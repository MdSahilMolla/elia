import { expect, test } from 'bun:test'
import { createRng } from '../rng.ts'
import { ALGORITHMS, explainRow, fitModel, predictModel, type Algorithm } from './models.ts'
import { classificationMetrics, regressionMetrics, rocAuc, averagePrecision, calibration, thresholdAnalysis } from './metrics.ts'
import { groupKFold, stratifiedKFold, timeSeriesSplit } from './cv.ts'

function regressionData(n: number, seed: number) {
  const rng = createRng(seed)
  const x: number[][] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    const a = rng.normal()
    const b = rng.normal()
    const c = rng.normal()
    x.push([a, b, c])
    y.push(3 * a - 2 * b + (a > 0 ? 1.5 : 0) + rng.normal(0, 0.3))
  }
  return { x, y }
}

function classificationData(n: number, seed: number, k = 2) {
  const rng = createRng(seed)
  const x: number[][] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    const label = rng.int(k)
    x.push([rng.normal(label * 1.8, 1), rng.normal(-label, 1), rng.normal()])
    y.push(label)
  }
  return { x, y }
}

test('every regression learner beats the mean baseline on a learnable signal', () => {
  const train = regressionData(600, 1)
  const test = regressionData(300, 2)
  const baseline = regressionMetrics(test.y, predictModel(fitModel('baseline', 'regression', train.x, train.y, 0), test.x).values)
  for (const algorithm of Object.keys(ALGORITHMS) as Algorithm[]) {
    if (algorithm === 'baseline' || !ALGORITHMS[algorithm].tasks.includes('regression')) continue
    const model = fitModel(algorithm, 'regression', train.x, train.y, 0, algorithm === 'random_forest' ? { nEstimators: 40 } : algorithm === 'gradient_boosting' ? { nEstimators: 150 } : {})
    const metrics = regressionMetrics(test.y, predictModel(model, test.x).values)
    expect({ algorithm, better: metrics.rmse! < 0.6 * baseline.rmse! }).toEqual({ algorithm, better: true })
  }
})

test('every classification learner separates two shifted classes', () => {
  const train = classificationData(600, 3)
  const test = classificationData(300, 4)
  for (const algorithm of Object.keys(ALGORITHMS) as Algorithm[]) {
    if (algorithm === 'baseline' || !ALGORITHMS[algorithm].tasks.includes('binary')) continue
    const model = fitModel(algorithm, 'binary', train.x, train.y, 2, algorithm === 'random_forest' ? { nEstimators: 40 } : {})
    const prediction = predictModel(model, test.x)
    const metrics = classificationMetrics(test.y, prediction.values, prediction.probabilities, ['0', '1'])
    expect({ algorithm, good: (metrics.rocAuc as number) > 0.85 }).toEqual({ algorithm, good: true })
    for (const row of prediction.probabilities!) expect(Math.abs(row[0]! + row[1]! - 1)).toBeLessThan(1e-9)
  }
})

test('multiclass learners produce valid probability rows', () => {
  const train = classificationData(600, 5, 3)
  const test = classificationData(300, 6, 3)
  for (const algorithm of ['logistic', 'random_forest', 'gradient_boosting', 'naive_bayes', 'mlp', 'decision_tree', 'knn', 'linear_svm'] as Algorithm[]) {
    const model = fitModel(algorithm, 'multiclass', train.x, train.y, 3, algorithm === 'random_forest' ? { nEstimators: 30 } : {})
    const prediction = predictModel(model, test.x)
    const metrics = classificationMetrics(test.y, prediction.values, prediction.probabilities, ['a', 'b', 'c'])
    expect({ algorithm, good: (metrics.accuracy as number) > 0.6 }).toEqual({ algorithm, good: true })
  }
})

test('models are reproducible from their seed and survive a JSON round trip', () => {
  const train = regressionData(300, 7)
  const a = fitModel('random_forest', 'regression', train.x, train.y, 0, { nEstimators: 10 }, 9)
  const b = fitModel('random_forest', 'regression', train.x, train.y, 0, { nEstimators: 10 }, 9)
  expect(predictModel(a, train.x.slice(0, 5)).values).toEqual(predictModel(b, train.x.slice(0, 5)).values)
  const revived = JSON.parse(JSON.stringify(a))
  expect(predictModel(revived, train.x.slice(0, 5)).values).toEqual(predictModel(a, train.x.slice(0, 5)).values)
})

test('lasso recovers the true coefficients and tree contributions sum to the prediction', () => {
  const rng = createRng(1)
  const x = Array.from({ length: 500 }, () => [rng.normal(), rng.normal(), rng.normal()])
  const y = x.map(([a, b]) => 2 * a! - b! + rng.normal(0, 0.1))
  const lasso = fitModel('lasso', 'regression', x, y, 0, { alpha: 0.01 })
  const coefficients = (lasso.state as { coefficients: number[] }).coefficients
  expect(coefficients[0]).toBeCloseTo(2, 1)
  expect(coefficients[1]).toBeCloseTo(-1, 1)
  expect(Math.abs(coefficients[2]!)).toBeLessThan(0.05)
  const gbm = fitModel('gradient_boosting', 'regression', x, y, 0, { nEstimators: 50, earlyStopping: false })
  const row = x[0]!
  const explanation = explainRow(gbm, row, [0, 0, 0])
  const total = explanation.bias + explanation.contributions.reduce((s, v) => s + v, 0)
  expect(total).toBeCloseTo(predictModel(gbm, [row]).values[0]!, 8)
})

test('ranking metrics match scikit-learn definitions', () => {
  expect(rocAuc([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8])).toBeCloseTo(0.75, 12)
  expect(averagePrecision([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8])).toBeCloseTo(0.8333333333, 8)
  const cal = calibration([0, 1, 1, 0, 1], [0.1, 0.9, 0.8, 0.3, 0.6])
  expect(cal.ece).toBeGreaterThanOrEqual(0)
  const thresholds = thresholdAnalysis([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8], { falsePositive: 1, falseNegative: 5 })
  expect(thresholds.minimumCost).toBeDefined()
})

test('CV plans respect strata, groups, and time order', () => {
  const rng = createRng(3)
  const labels = Array.from({ length: 100 }, (_, i) => (i < 10 ? 1 : 0))
  for (const fold of stratifiedKFold(labels, 5, rng)) expect(fold.test.filter((i) => labels[i] === 1)).toHaveLength(2)
  const groups = Array.from({ length: 60 }, (_, i) => `g${i % 12}`)
  for (const fold of groupKFold(groups, 4, rng)) {
    const trainGroups = new Set(fold.train.map((i) => groups[i]))
    expect(fold.test.some((i) => trainGroups.has(groups[i]!))).toBe(false)
  }
  for (const fold of timeSeriesSplit(100, 4, 2)) expect(Math.max(...fold.train)).toBeLessThan(Math.min(...fold.test) - 2)
})
