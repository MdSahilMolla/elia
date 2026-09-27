import type { Frame } from '../frame.ts'
import type { Check } from '../record.ts'
import { createRng, type Rng } from '../rng.ts'
import { mean, quantileSorted, spearman, standardDeviation } from '../stats/describe.ts'
import { tQuantile } from '../stats/special.ts'
import { isMissing, parseDateMs, scalarKey, toDateMs, toNumber, type Scalar } from '../values.ts'
import { groupKFold, holdout, kFold, stratifiedKFold, timeSeriesSplit, describeStrategy, type CvStrategy, type Fold } from './cv.ts'
import { calibration, classificationMetrics, liftTable, LOWER_IS_BETTER, metricValue, regressionMetrics, rocAuc, thresholdAnalysis } from './metrics.ts'
import { ALGORITHMS, fitModel, predictModel, type Algorithm, type FittedModel, type Prediction, type Task } from './models.ts'
import { excludedFeatures, fitPreprocessor, transformRecord, transformRows, type PreprocessorState } from './preprocess.ts'

/**
 * AutoML: detects the problem type, screens features for leakage, picks a validation plan
 * that matches the data (stratified, grouped, or time-ordered), compares candidate models
 * on the same folds, and selects one on more than a single number — the one-standard-error
 * rule prefers a simpler, faster, more interpretable model whose score is statistically
 * indistinguishable from the best. The selected model is then scored once on an untouched
 * holdout, compared with a baseline, checked for overfitting and calibration, explained with
 * permutation importance, and packaged as a versioned artifact.
 */

export interface TrainRequest {
  frame: Frame
  target: string
  features?: string[]
  task?: Task | 'auto'
  algorithms?: Algorithm[]
  metric?: string
  cvStrategy?: CvStrategy
  folds?: number
  groupColumn?: string
  timeColumn?: string
  gap?: number
  testFraction?: number
  seed?: number
  params?: Partial<Record<Algorithm, Record<string, unknown>>>
  tune?: boolean
  tuneIterations?: number
  positiveClass?: string
  sensitive?: string[]
  classWeight?: 'balanced'
  costs?: { falsePositive: number; falseNegative: number }
  keepLeakageSuspects?: boolean
  maxSearchRows?: number
  profiles: Array<{ name: string; semanticType: string; role: string; distinct: number }>
}

export interface TrainingProfileFeature {
  name: string
  kind: 'numeric' | 'categorical'
  edges?: number[]
  shares: number[]
  levels?: string[]
  missingRate: number
}

export interface ModelArtifact {
  format: 'elia-model/1'
  task: Task
  target: string
  classLabels: string[]
  positiveClass?: string
  threshold?: number
  features: string[]
  preprocessor: PreprocessorState
  model: FittedModel
  metrics: Record<string, unknown>
  trainingProfile: TrainingProfileFeature[]
  predictionProfile: { edges: number[]; shares: number[] }
  seed: number
  trainedAt: string
  trainingRows: number
}

export interface LeaderboardRow {
  algorithm: Algorithm
  params: Record<string, unknown>
  metric: string
  cvMean: number
  cvSd: number
  cvScores: number[]
  secondary: Record<string, number>
  fitSeconds: number
  predictMsPer1k: number
  sizeKb: number
  interpretability: 'high' | 'medium' | 'low'
  beatsBaseline: boolean | null
}

export interface TrainResult {
  task: Task
  target: string
  classLabels: string[]
  positiveClass?: string
  features: string[]
  excluded: Array<{ name: string; reason: string }>
  leakage: Array<{ feature: string; reason: string; action: 'excluded' | 'kept' }>
  validation: { strategy: string; folds: number; holdout: string; trainRows: number; testRows: number; searchRows: number }
  primaryMetric: string
  leaderboard: LeaderboardRow[]
  selected: { algorithm: Algorithm; params: Record<string, unknown>; reason: string }
  test: { selected: Record<string, unknown>; baseline: Record<string, unknown>; train: Record<string, unknown> }
  calibration?: ReturnType<typeof calibration>
  thresholds?: ReturnType<typeof thresholdAnalysis>
  lift?: ReturnType<typeof liftTable>
  permutationImportance: Array<{ feature: string; importance: number; sd: number }>
  nativeImportance: Array<{ feature: string; importance: number }>
  fairness?: Array<{ attribute: string; groups: Array<Record<string, unknown>>; gaps: Record<string, number>; flags: string[] }>
  checks: Check[]
  warnings: string[]
  artifact: ModelArtifact
  notes: string[]
}

const DEFAULT_PARAMS: Partial<Record<Algorithm, Record<string, unknown>>> = {
  random_forest: { nEstimators: 150, maxDepth: 14 },
  gradient_boosting: { nEstimators: 400, learningRate: 0.06, maxDepth: 4 },
  ridge: { alpha: 1 },
  elastic_net: { alpha: 0.01, l1Ratio: 0.5 },
  logistic: { C: 1 },
  decision_tree: { maxDepth: 6, minSamplesLeaf: 10 },
  knn: { k: 15, weights: 'distance' },
}

const SEARCH_SPACES: Partial<Record<Algorithm, Record<string, unknown[]>>> = {
  ridge: { alpha: [0.01, 0.1, 1, 10, 100] },
  elastic_net: { alpha: [0.0005, 0.005, 0.05, 0.5], l1Ratio: [0.1, 0.5, 0.9] },
  lasso: { alpha: [0.0005, 0.005, 0.05, 0.5] },
  logistic: { C: [0.01, 0.1, 1, 10] },
  decision_tree: { maxDepth: [3, 5, 8, 12], minSamplesLeaf: [1, 5, 20, 50] },
  random_forest: { maxDepth: [8, 14, 24], minSamplesLeaf: [1, 3, 10], maxFeatures: [] },
  gradient_boosting: { learningRate: [0.03, 0.06, 0.12], maxDepth: [3, 4, 6], minSamplesLeaf: [5, 20, 50], lambda: [0.1, 1, 5], subsample: [0.7, 0.9] },
  knn: { k: [5, 15, 31, 61], weights: ['uniform', 'distance'] },
  mlp: { hidden: [[32], [64], [64, 32]], learningRate: [0.0005, 0.001, 0.003], l2: [1e-5, 1e-4, 1e-3] },
  linear_svm: { C: [0.1, 1, 10] },
}

function detectTask(frame: Frame, target: string, requested?: Task | 'auto'): Task {
  if (requested && requested !== 'auto') return requested
  const values = frame.rows.map((row) => row[target]).filter((value) => !isMissing(value)) as Scalar[]
  const distinct = new Set(values.map((value) => scalarKey(value))).size
  const numeric = values.every((value) => typeof value === 'number')
  if (distinct === 2) return 'binary'
  if (numeric && (distinct > 20 || values.some((value) => !Number.isInteger(value as number)))) return 'regression'
  if (distinct >= 3 && distinct <= 50) return 'multiclass'
  if (numeric) return 'regression'
  throw new Error(`target "${target}" has ${distinct} distinct non-numeric values — too many classes for classification (limit 50); group them or choose another target`)
}

function classOrder(values: Scalar[], task: Task, positive?: string): string[] {
  const labels = [...new Set(values.map((value) => String(value)))]
  if (task === 'binary') {
    let pos = positive
    if (pos === undefined) pos = labels.includes('1') ? '1' : labels.includes('true') ? 'true' : [...labels].sort()[1]!
    if (!labels.includes(pos)) throw new Error(`positiveClass "${pos}" is not a value of the target (${labels.join(', ')})`)
    return [labels.find((label) => label !== pos)!, pos]
  }
  return labels.sort()
}

function scoreOf(task: Task, metric: string, actual: number[], prediction: Prediction, classLabels: string[]): { primary: number; all: Record<string, unknown> } {
  const all = task === 'regression' ? regressionMetrics(actual, prediction.values) : classificationMetrics(actual, prediction.values, prediction.probabilities, classLabels)
  return { primary: metricValue(all, metric), all }
}

function better(metric: string, a: number, b: number): boolean {
  if (!Number.isFinite(a)) return false
  if (!Number.isFinite(b)) return true
  return LOWER_IS_BETTER.has(metric) ? a < b : a > b
}

function leakageScreen(frame: Frame, rows: number[], features: string[], target: string, y: number[], task: Task, timeColumn?: string): Array<{ feature: string; reason: string }> {
  const suspects: Array<{ feature: string; reason: string }> = []
  const targetStem = target.toLowerCase().replace(/[^a-z]/g, '').replace(/(ed|s)$/, '')
  for (const feature of features) {
    const lower = feature.toLowerCase().replace(/[^a-z]/g, '')
    if (targetStem.length >= 4 && lower.includes(targetStem) && lower !== targetStem) suspects.push({ feature, reason: `name contains the target's name ("${target}") — likely recorded after or because of the outcome` })
    const type = frame.types[feature]
    const missingFlags = rows.map((index) => (isMissing(frame.rows[index]![feature]) ? 1 : 0))
    const missingCount = missingFlags.reduce((a: number, b) => a + b, 0)
    if (task !== 'regression' && missingCount > 0 && missingCount < rows.length) {
      const auc = task === 'binary' ? rocAuc(y, missingFlags) : Number.NaN
      if (Number.isFinite(auc) && Math.max(auc, 1 - auc) > 0.985) {
        suspects.push({ feature, reason: `whether it is missing predicts the target almost perfectly (AUC ${Math.max(auc, 1 - auc).toFixed(3)}) — typically a field filled in only after the outcome` })
        continue
      }
    }
    if (type === 'integer' || type === 'number') {
      const pairs = rows.map((index, position) => [toNumber(frame.rows[index]![feature]), y[position]!] as const).filter((pair): pair is readonly [number, number] => pair[0] !== undefined)
      if (pairs.length < 30) continue
      if (task === 'binary') {
        const auc = rocAuc(pairs.map((pair) => pair[1]), pairs.map((pair) => pair[0]))
        if (Number.isFinite(auc) && Math.max(auc, 1 - auc) > 0.985) suspects.push({ feature, reason: `alone it separates the classes almost perfectly (single-feature AUC ${Math.max(auc, 1 - auc).toFixed(3)})` })
      } else if (task === 'regression') {
        const rho = spearman(pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1]))
        if (Math.abs(rho) > 0.985) suspects.push({ feature, reason: `rank correlation with the target is ${rho.toFixed(3)} — it may be the target in disguise (a sum, a copy, or a post-outcome measurement)` })
      }
    } else if (type === 'string' && task !== 'regression') {
      const groups = new Map<string, Map<number, number>>()
      rows.forEach((index, position) => {
        const key = String(frame.rows[index]![feature] ?? '')
        const counts = groups.get(key) ?? new Map<number, number>()
        counts.set(y[position]!, (counts.get(y[position]!) ?? 0) + 1)
        groups.set(key, counts)
      })
      if (groups.size < rows.length / 20 && groups.size >= 2) {
        const pure = [...groups.values()].reduce((total, counts) => total + Math.max(...counts.values()), 0) / rows.length
        if (pure > 0.995) suspects.push({ feature, reason: `each of its ${groups.size} levels maps to a single class (${(pure * 100).toFixed(1)}% purity)` })
      }
    }
    if (timeColumn && (type === 'date' || type === 'datetime') && feature !== timeColumn) {
      const later = rows.filter((index) => {
        const f = toDateMs(frame.rows[index]![feature])
        const t = toDateMs(frame.rows[index]![timeColumn])
        return f !== undefined && t !== undefined && f > t
      }).length
      if (later / rows.length > 0.05) suspects.push({ feature, reason: `${((100 * later) / rows.length).toFixed(0)}% of its dates fall after the prediction time (${timeColumn}) — information from the future` })
    }
  }
  return suspects
}

export function trainingProfile(frame: Frame, rows: number[], features: string[]): TrainingProfileFeature[] {
  return features.map((name) => {
    const values = rows.map((index) => frame.rows[index]![name])
    const missingRate = values.filter((value) => isMissing(value)).length / Math.max(1, values.length)
    const type = frame.types[name]
    if (type === 'integer' || type === 'number' || type === 'date' || type === 'datetime') {
      const numbers = values.map((value) => (type === 'date' || type === 'datetime' ? toDateMs(value) : toNumber(value))).filter((value): value is number => value !== undefined).sort((a, b) => a - b)
      const edges = [...new Set(Array.from({ length: 9 }, (_, index) => quantileSorted(numbers, (index + 1) / 10)))]
      return { name, kind: 'numeric' as const, edges, shares: binShares(numbers, edges), missingRate }
    }
    const counts = new Map<string, number>()
    for (const value of values) if (!isMissing(value)) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1)
    const levels = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([level]) => level)
    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1
    const shares = [...levels.map((level) => counts.get(level)! / total), 1 - levels.reduce((sum, level) => sum + counts.get(level)! / total, 0)]
    return { name, kind: 'categorical' as const, levels, shares, missingRate }
  })
}

export function binShares(sortedOrAny: number[], edges: number[]): number[] {
  const counts = new Array<number>(edges.length + 1).fill(0)
  for (const value of sortedOrAny) {
    let bin = 0
    while (bin < edges.length && value > edges[bin]!) bin++
    counts[bin]!++
  }
  const total = sortedOrAny.length || 1
  return counts.map((count) => count / total)
}

function sampleParams(space: Record<string, unknown[]>, rng: Rng, d: number, task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, options] of Object.entries(space)) {
    if (key === 'maxFeatures') {
      const choices = task === 'regression' ? [Math.max(1, Math.round(d / 3)), Math.max(1, Math.round(d / 2)), d] : [Math.max(1, Math.round(Math.sqrt(d))), Math.max(1, Math.round(d / 3)), Math.max(1, Math.round(d / 2))]
      out[key] = choices[rng.int(choices.length)]
    } else if (options.length) out[key] = options[rng.int(options.length)]
  }
  return out
}

function defaultAlgorithms(task: Task, n: number): Algorithm[] {
  const list: Algorithm[] = task === 'regression' ? ['baseline', 'ridge', 'elastic_net', 'decision_tree', 'random_forest', 'gradient_boosting'] : ['baseline', 'logistic', 'naive_bayes', 'decision_tree', 'random_forest', 'gradient_boosting']
  if (n <= 10_000) list.push('knn')
  if (n >= 500 && n <= 50_000) list.push('mlp')
  return list
}

function sizeKb(model: FittedModel): number {
  return Math.round(JSON.stringify(model.state).length / 102.4) / 10
}

export function trainAutoML(request: TrainRequest): TrainResult {
  const { frame, target } = request
  if (!frame.columns.includes(target)) throw new Error(`target "${target}" is not a column`)
  const seed = request.seed ?? 42
  const rng = createRng(seed)
  const warnings: string[] = []
  const notes: string[] = []
  const checks: Check[] = []
  // Rows with a target value, ordered by time when a time column is given.
  let rows = frame.rows.map((_, index) => index).filter((index) => !isMissing(frame.rows[index]![target]))
  const droppedTargets = frame.rows.length - rows.length
  if (droppedTargets) warnings.push(`${droppedTargets} rows with a missing target were excluded`)
  if (request.timeColumn) {
    if (!frame.columns.includes(request.timeColumn)) throw new Error(`timeColumn "${request.timeColumn}" is not a column`)
    const time = request.timeColumn
    rows = rows.filter((index) => toDateMs(frame.rows[index]![time]) !== undefined).sort((a, b) => toDateMs(frame.rows[a]![time])! - toDateMs(frame.rows[b]![time])!)
  }
  if (request.timeColumn && request.task !== 'binary' && request.task !== 'multiclass') {
    const times = rows.map((index) => toDateMs(frame.rows[index]![request.timeColumn!])!)
    const values = rows.map((index) => toNumber(frame.rows[index]![target]))
    const pairs = times.map((time, position) => [time, values[position]] as const).filter((pair): pair is readonly [number, number] => pair[1] !== undefined)
    if (pairs.length >= 30) {
      const rho = spearman(pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1]))
      if (Math.abs(rho) > 0.3) warnings.push(`${target} trends over ${request.timeColumn} (Spearman ${rho.toFixed(2)}). Tree models cannot extrapolate beyond the training range and ${request.timeColumn} itself is not a feature: add a trend feature (e.g. days since start) or use ds_timeseries forecasting for future periods.`)
    }
  }
  if (rows.length < 30) throw new Error(`only ${rows.length} rows have a target value; at least 30 are needed to train and validate a model`)
  const task = detectTask(frame, target, request.task)
  const targetValues = rows.map((index) => frame.rows[index]![target]!)
  const classLabels = task === 'regression' ? [] : classOrder(targetValues, task, request.positiveClass)
  const y = task === 'regression' ? targetValues.map((value) => { const n = toNumber(value); if (n === undefined) throw new Error(`regression target "${target}" has non-numeric value ${JSON.stringify(value)}`); return n }) : targetValues.map((value) => classLabels.indexOf(String(value)))
  if (task !== 'regression') {
    const counts = classLabels.map((_, c) => y.filter((label) => label === c).length)
    const minority = Math.min(...counts)
    if (minority < 10) warnings.push(`the smallest class has only ${minority} rows; estimates for it are very uncertain`)
  }
  // Features
  const candidates = (request.features ?? frame.columns).filter((name) => name !== target && name !== request.groupColumn && (request.features ? true : name !== request.timeColumn))
  const screened = excludedFeatures(frame, candidates, request.profiles, target, new Set(request.features ?? []))
  for (const entry of screened.kept) warnings.push(`${entry.name} ${entry.reason}`)
  const suspects = leakageScreen(frame, rows, screened.features, target, y, task, request.timeColumn)
  const leakage = suspects.map((suspect) => ({ ...suspect, action: request.keepLeakageSuspects ? ('kept' as const) : ('excluded' as const) }))
  let features = request.keepLeakageSuspects ? screened.features : screened.features.filter((name) => !suspects.some((suspect) => suspect.feature === name))
  if (features.length === 0) throw new Error(`no usable features remain after excluding identifiers, constants, text, and leakage suspects (${[...screened.excluded.map((e) => e.name), ...suspects.map((s) => s.feature)].join(', ')})`)
  if (suspects.length) checks.push({ name: 'leakage screen', status: 'warn', detail: `${suspects.length} feature(s) look like target leakage: ${suspects.map((s) => s.feature).join(', ')}${request.keepLeakageSuspects ? ' (kept on request)' : ' (excluded)'}` })
  else checks.push({ name: 'leakage screen', status: 'pass', detail: 'no feature separates the target implausibly well on its own; no post-outcome names or future dates found' })
  // Validation plan
  const n = rows.length
  const folds = Math.max(2, Math.min(10, Math.floor(request.folds ?? (n < 200 ? 3 : 5))))
  const strategy: CvStrategy = request.cvStrategy ?? (request.timeColumn ? 'timeseries' : request.groupColumn ? 'group' : task === 'regression' ? 'kfold' : 'stratified')
  const groups = request.groupColumn ? rows.map((index) => String(frame.rows[index]![request.groupColumn!] ?? '')) : undefined
  if (strategy === 'group' && !groups) throw new Error('group cross-validation needs groupColumn')
  if (strategy === 'timeseries' && !request.timeColumn) throw new Error('time-series cross-validation needs timeColumn')
  const testFraction = request.testFraction ?? 0.2
  const split = holdout(n, testFraction, rng.fork(1), { ...(task !== 'regression' && strategy === 'stratified' ? { labels: y } : {}), ...(groups ? { groups } : {}), timeOrdered: strategy === 'timeseries' })
  const trainIdx = split.train
  const testIdx = split.test
  // Search sample (bounded for tractability; the final model is refit on the full training split).
  const maxSearch = request.maxSearchRows ?? 60_000
  const searchIdx = trainIdx.length > maxSearch ? (strategy === 'timeseries' ? trainIdx.slice(-maxSearch) : rng.fork(2).shuffle(trainIdx).slice(0, maxSearch).sort((a, b) => a - b)) : trainIdx
  if (searchIdx.length < trainIdx.length) notes.push(`model comparison used ${searchIdx.length} of ${trainIdx.length} training rows (${strategy === 'timeseries' ? 'the most recent' : 'a random sample'}); the selected model was refit on all training rows`)
  const searchY = searchIdx.map((i) => y[i]!)
  const searchRows = searchIdx.map((i) => rows[i]!)
  let cvFolds: Fold[]
  if (strategy === 'timeseries') cvFolds = timeSeriesSplit(searchIdx.length, folds, request.gap ?? 0)
  else if (strategy === 'group') cvFolds = groupKFold(searchIdx.map((i) => groups![i]!), folds, rng.fork(3))
  else if (strategy === 'stratified') cvFolds = stratifiedKFold(searchY, folds, rng.fork(3))
  else cvFolds = kFold(searchIdx.length, folds, rng.fork(3))
  const minorityShare = task === 'binary' ? Math.min(mean(y), 1 - mean(y)) : 1
  const metric = request.metric ?? (task === 'regression' ? 'rmse' : task === 'binary' ? (minorityShare < 0.1 ? 'prAuc' : 'rocAuc') : 'macroF1')
  if (task === 'binary' && minorityShare < 0.1 && !request.metric) notes.push(`the positive class is ${(minorityShare * 100).toFixed(1)}% of rows, so models are ranked by PR-AUC rather than ROC-AUC or accuracy`)
  const classes = classLabels.length
  const algorithms = (request.algorithms?.length ? request.algorithms : defaultAlgorithms(task, searchIdx.length)).filter((algorithm) => {
    if (!ALGORITHMS[algorithm]) throw new Error(`unknown algorithm "${algorithm}"; available: ${Object.keys(ALGORITHMS).join(', ')}`)
    if (!ALGORITHMS[algorithm].tasks.includes(task)) { notes.push(`${algorithm} skipped: it does not support ${task}`); return false }
    return true
  })
  if (!algorithms.includes('baseline')) algorithms.unshift('baseline')
  // Precompute per-fold preprocessing (fit on the fold's training rows only).
  const foldData = cvFolds.map((fold) => {
    const trainRows = fold.train.map((i) => searchRows[i]!)
    const testRows = fold.test.map((i) => searchRows[i]!)
    const pre = fitPreprocessor(frame, trainRows, features)
    return { fold, pre, xTrain: transformRows(pre, frame, trainRows), xTest: transformRows(pre, frame, testRows), yTrain: fold.train.map((i) => searchY[i]!), yTest: fold.test.map((i) => searchY[i]!) }
  })
  const d = foldData[0]!.xTrain[0]?.length ?? 0
  const evaluate = (algorithm: Algorithm, params: Record<string, unknown>) => {
    const scores: number[] = []
    const secondary: Record<string, number[]> = {}
    let fitMs = 0
    let predictMs = 0
    let predicted = 0
    let lastModel: FittedModel | undefined
    foldData.forEach((data, index) => {
      const start = performance.now()
      const model = fitModel(algorithm, task, data.xTrain, data.yTrain, classes, { ...params, ...(request.classWeight ? { classWeight: request.classWeight } : {}) }, seed + index)
      fitMs += performance.now() - start
      const t0 = performance.now()
      const prediction = predictModel(model, data.xTest)
      predictMs += performance.now() - t0
      predicted += data.xTest.length
      const { primary, all } = scoreOf(task, metric, data.yTest, prediction, classLabels)
      scores.push(primary)
      for (const key of task === 'regression' ? ['rmse', 'mae', 'r2'] : task === 'binary' ? ['rocAuc', 'prAuc', 'f1', 'logLoss', 'accuracy'] : ['macroF1', 'accuracy', 'logLoss']) {
        const value = metricValue(all, key)
        if (Number.isFinite(value)) (secondary[key] ??= []).push(value)
      }
      lastModel = model
    })
    return { scores, secondary: Object.fromEntries(Object.entries(secondary).map(([key, values]) => [key, mean(values)])), fitSeconds: fitMs / 1000 / foldData.length, predictMsPer1k: (predictMs / Math.max(1, predicted)) * 1000, sizeKb: lastModel ? sizeKb(lastModel) : 0 }
  }
  const leaderboard: LeaderboardRow[] = []
  for (const algorithm of algorithms) {
    let params: Record<string, unknown> = { ...DEFAULT_PARAMS[algorithm], ...request.params?.[algorithm] }
    let result = evaluate(algorithm, params)
    if (request.tune && SEARCH_SPACES[algorithm] && algorithm !== 'baseline') {
      const iterations = Math.max(1, Math.min(30, request.tuneIterations ?? 6))
      const tuneRng = rng.fork(100 + algorithms.indexOf(algorithm))
      for (let iteration = 0; iteration < iterations; iteration++) {
        const candidate = { ...params, ...sampleParams(SEARCH_SPACES[algorithm]!, tuneRng, d, task), ...request.params?.[algorithm] }
        const candidateResult = evaluate(algorithm, candidate)
        if (better(metric, mean(candidateResult.scores), mean(result.scores))) {
          params = candidate
          result = candidateResult
        }
      }
    }
    const finite = result.scores.filter(Number.isFinite)
    leaderboard.push({ algorithm, params, metric, cvMean: finite.length ? mean(finite) : Number.NaN, cvSd: finite.length > 1 ? standardDeviation(finite) : 0, cvScores: result.scores, secondary: result.secondary, fitSeconds: result.fitSeconds, predictMsPer1k: result.predictMsPer1k, sizeKb: result.sizeKb, interpretability: ALGORITHMS[algorithm].interpretability, beatsBaseline: null })
  }
  const baselineRow = leaderboard.find((row) => row.algorithm === 'baseline')!
  // "Beats the baseline" needs evidence, not a lucky decimal: a one-sided paired t test on the
  // per-fold differences (same folds for every model) at the 5% level.
  const pairedAdvantage = (row: LeaderboardRow) => {
    const diffs = row.cvScores.map((score, fold) => (LOWER_IS_BETTER.has(metric) ? baselineRow.cvScores[fold]! - score : score - baselineRow.cvScores[fold]!)).filter(Number.isFinite)
    if (diffs.length < 2) return { significant: false, meanDiff: diffs[0] ?? 0 }
    const meanDiff = mean(diffs)
    const sd = standardDeviation(diffs)
    const threshold = sd === 0 ? 0 : tQuantile(0.95, diffs.length - 1) * (sd / Math.sqrt(diffs.length))
    return { significant: meanDiff > threshold && meanDiff > 0, meanDiff }
  }
  for (const row of leaderboard) row.beatsBaseline = row.algorithm === 'baseline' ? null : pairedAdvantage(row).significant
  leaderboard.sort((a, b) => (better(metric, a.cvMean, b.cvMean) ? -1 : better(metric, b.cvMean, a.cvMean) ? 1 : 0))
  const contenders = leaderboard.filter((row) => row.algorithm !== 'baseline' && Number.isFinite(row.cvMean))
  if (contenders.length === 0) throw new Error('every candidate model failed to produce a finite validation score')
  const best = contenders[0]!
  const se = best.cvSd / Math.sqrt(Math.max(1, best.cvScores.length))
  const rank = { high: 0, medium: 1, low: 2 }
  const withinOneSe = contenders.filter((row) => Math.abs(row.cvMean - best.cvMean) <= se)
  const chosen = withinOneSe.sort((a, b) => rank[a.interpretability] - rank[b.interpretability] || a.fitSeconds + a.predictMsPer1k / 1000 - (b.fitSeconds + b.predictMsPer1k / 1000))[0]!
  const reason = chosen.algorithm === best.algorithm
    ? `${chosen.algorithm} had the best cross-validated ${metric} (${chosen.cvMean.toPrecision(4)} ± ${chosen.cvSd.toPrecision(2)})${withinOneSe.length > 1 ? ' and no simpler model was within one standard error' : ''}`
    : `${best.algorithm} scored best (${best.cvMean.toPrecision(4)}), but ${chosen.algorithm} (${chosen.cvMean.toPrecision(4)}) is within one standard error (${se.toPrecision(2)}) and is ${chosen.interpretability === 'high' && best.interpretability !== 'high' ? 'more interpretable' : 'faster'} — the one-standard-error rule prefers it`
  const advantage = pairedAdvantage(chosen)
  checks.push({ name: 'beats baseline in cross-validation', status: chosen.beatsBaseline ? 'pass' : advantage.meanDiff > 0 ? 'warn' : 'fail', detail: `${chosen.algorithm} ${metric} ${chosen.cvMean.toPrecision(4)} vs baseline ${baselineRow.cvMean.toPrecision(4)}${chosen.beatsBaseline ? ' (paired across folds, one-sided p < 0.05)' : advantage.meanDiff > 0 ? ' — ahead on average but not consistently across folds; the model may have no real signal' : ' — the model is no better than predicting the baseline'}` })
  const unstable = chosen.cvMean !== 0 && Math.abs(chosen.cvSd / chosen.cvMean) > 0.25
  checks.push({ name: 'stable across folds', status: unstable ? 'warn' : 'pass', detail: `fold scores ${chosen.cvScores.map((s) => s.toPrecision(3)).join(', ')}` })
  // Final fit on the full training split, scored once on the holdout.
  const finalTrainRows = trainIdx.map((i) => rows[i]!)
  const finalTestRows = testIdx.map((i) => rows[i]!)
  const pre = fitPreprocessor(frame, finalTrainRows, features)
  const xTrain = transformRows(pre, frame, finalTrainRows)
  const xTest = transformRows(pre, frame, finalTestRows)
  const yTrain = trainIdx.map((i) => y[i]!)
  const yTest = testIdx.map((i) => y[i]!)
  const model = fitModel(chosen.algorithm, task, xTrain, yTrain, classes, { ...chosen.params, ...(request.classWeight ? { classWeight: request.classWeight } : {}) }, seed)
  const baselineModel = fitModel('baseline', task, xTrain, yTrain, classes, {}, seed)
  const testPrediction = predictModel(model, xTest)
  const test = scoreOf(task, metric, yTest, testPrediction, classLabels)
  const baselineTest = scoreOf(task, metric, yTest, predictModel(baselineModel, xTest), classLabels)
  const trainScore = scoreOf(task, metric, yTrain, predictModel(model, xTrain), classLabels)
  // Paired bootstrap of the holdout metric difference: the lower bound must clear zero.
  const baselineHoldoutPrediction = predictModel(baselineModel, xTest)
  const bootRng = rng.fork(9)
  const diffs: number[] = []
  for (let b = 0; b < 300; b++) {
    const idx = Array.from({ length: yTest.length }, () => bootRng.int(yTest.length))
    const pick = (prediction: Prediction): Prediction => ({ values: idx.map((i) => prediction.values[i]!), ...(prediction.probabilities ? { probabilities: idx.map((i) => prediction.probabilities![i]!) } : {}) })
    const ys = idx.map((i) => yTest[i]!)
    const a = scoreOf(task, metric, ys, pick(testPrediction), classLabels).primary
    const c = scoreOf(task, metric, ys, pick(baselineHoldoutPrediction), classLabels).primary
    const d = LOWER_IS_BETTER.has(metric) ? c - a : a - c
    if (Number.isFinite(d)) diffs.push(d)
  }
  diffs.sort((x, y) => x - y)
  const lowerBound = diffs.length ? quantileSorted(diffs, 0.05) : Number.NaN
  const holdoutBetter = better(metric, test.primary, baselineTest.primary)
  checks.push({ name: 'beats baseline on the untouched holdout', status: lowerBound > 0 ? 'pass' : holdoutBetter ? 'warn' : 'fail', detail: `${metric} ${test.primary.toPrecision(4)} vs baseline ${baselineTest.primary.toPrecision(4)} on ${yTest.length} holdout rows; 90% bootstrap interval of the improvement starts at ${Number.isFinite(lowerBound) ? lowerBound.toPrecision(3) : 'n/a'}${lowerBound > 0 ? '' : ' — not clearly better than the baseline'}` })
  const gap = LOWER_IS_BETTER.has(metric) ? (test.primary - trainScore.primary) / Math.max(1e-12, Math.abs(trainScore.primary)) : (trainScore.primary - test.primary) / Math.max(1e-12, Math.abs(trainScore.primary))
  checks.push({ name: 'no severe overfitting', status: gap > 0.3 ? 'warn' : 'pass', detail: `train ${metric} ${trainScore.primary.toPrecision(4)} vs holdout ${test.primary.toPrecision(4)} (relative gap ${(gap * 100).toFixed(1)}%)` })
  const cvVsTest = Math.abs(test.primary - chosen.cvMean) / Math.max(1e-12, Math.abs(chosen.cvMean))
  checks.push({ name: 'holdout agrees with cross-validation', status: cvVsTest > 0.2 && Math.abs(test.primary - chosen.cvMean) > 3 * Math.max(chosen.cvSd, 1e-9) ? 'warn' : 'pass', detail: `CV ${chosen.cvMean.toPrecision(4)} vs holdout ${test.primary.toPrecision(4)}${request.tune ? ' (tuned CV scores are optimistic; the holdout is the unbiased estimate)' : ''}` })
  let calibrationResult: TrainResult['calibration']
  let thresholds: TrainResult['thresholds']
  let lift: TrainResult['lift']
  if (task === 'binary' && testPrediction.probabilities) {
    const scores = testPrediction.probabilities.map((row) => row[1]!)
    calibrationResult = calibration(yTest, scores)
    thresholds = thresholdAnalysis(yTest, scores, request.costs)
    lift = liftTable(yTest, scores)
    checks.push({ name: 'probabilities are calibrated', status: calibrationResult.ece > 0.1 ? 'warn' : 'pass', detail: `expected calibration error ${calibrationResult.ece.toFixed(3)} on the holdout${calibrationResult.ece > 0.1 ? ' — treat scores as rankings, not probabilities, until recalibrated' : ''}` })
  }
  // Permutation importance on the holdout, by original feature.
  const permutationImportance = permutationImportanceOf(frame, finalTestRows, features, pre, model, task, metric, yTest, classLabels, rng.fork(7), test.primary)
  const nativeImportance = model.featureImportance ? rollUp(pre, model.featureImportance) : []
  // Fairness across explicitly named sensitive attributes only.
  const fairness = request.sensitive?.length ? request.sensitive.map((attribute) => fairnessReport(frame, finalTestRows, attribute, yTest, testPrediction, task, classLabels)) : undefined
  for (const report of fairness ?? []) for (const flag of report.flags) checks.push({ name: `fairness (${report.attribute})`, status: 'warn', detail: flag })
  const trainingPredictions = predictModel(model, xTrain)
  const predictionScores = task === 'regression' ? trainingPredictions.values : task === 'binary' ? trainingPredictions.probabilities!.map((row) => row[1]!) : trainingPredictions.probabilities!.map((row) => Math.max(...row))
  const sortedScores = [...predictionScores].sort((a, b) => a - b)
  const predictionEdges = [...new Set(Array.from({ length: 9 }, (_, index) => quantileSorted(sortedScores, (index + 1) / 10)))]
  const artifact: ModelArtifact = {
    format: 'elia-model/1',
    task,
    target,
    classLabels,
    ...(task === 'binary' ? { positiveClass: classLabels[1]!, threshold: 0.5 } : {}),
    features,
    preprocessor: pre,
    model,
    metrics: { primaryMetric: metric, cv: { mean: chosen.cvMean, sd: chosen.cvSd, scores: chosen.cvScores }, holdout: stripMatrix(test.all), baselineHoldout: stripMatrix(baselineTest.all) },
    trainingProfile: trainingProfile(frame, finalTrainRows, features),
    predictionProfile: { edges: predictionEdges, shares: binShares(predictionScores, predictionEdges) },
    seed,
    trainedAt: new Date().toISOString(),
    trainingRows: finalTrainRows.length,
  }
  return {
    task,
    target,
    classLabels,
    ...(task === 'binary' ? { positiveClass: classLabels[1]! } : {}),
    features,
    excluded: screened.excluded,
    leakage,
    validation: { strategy: describeStrategy(strategy, cvFolds.length), folds: cvFolds.length, holdout: strategy === 'timeseries' ? `the most recent ${testIdx.length} rows by ${request.timeColumn}` : `${testIdx.length} rows (${(testFraction * 100).toFixed(0)}%) held out${strategy === 'group' ? ' by group' : strategy === 'stratified' ? ', stratified' : ''}, never used for selection`, trainRows: trainIdx.length, testRows: testIdx.length, searchRows: searchIdx.length },
    primaryMetric: metric,
    leaderboard,
    selected: { algorithm: chosen.algorithm, params: chosen.params, reason },
    test: { selected: stripMatrix(test.all), baseline: stripMatrix(baselineTest.all), train: stripMatrix(trainScore.all) },
    ...(calibrationResult ? { calibration: calibrationResult } : {}),
    ...(thresholds ? { thresholds } : {}),
    ...(lift ? { lift } : {}),
    permutationImportance,
    nativeImportance,
    ...(fairness ? { fairness } : {}),
    checks,
    warnings,
    artifact,
    notes: [...notes, ...model.notes],
  }
}

function stripMatrix(metrics: Record<string, unknown>): Record<string, unknown> {
  const { perClass, ...rest } = metrics as Record<string, unknown> & { perClass?: unknown }
  return { ...rest, ...(Array.isArray(perClass) && perClass.length <= 20 ? { perClass } : {}) }
}

function rollUp(pre: PreprocessorState, importance: number[]): Array<{ feature: string; importance: number }> {
  const totals = new Map<string, number>()
  importance.forEach((value, index) => totals.set(pre.sources[index]!, (totals.get(pre.sources[index]!) ?? 0) + value))
  return [...totals.entries()].map(([feature, value]) => ({ feature, importance: value })).sort((a, b) => b.importance - a.importance)
}

export function permutationImportanceOf(frame: Frame, rows: number[], features: string[], pre: PreprocessorState, model: FittedModel, task: Task, metric: string, y: number[], classLabels: string[], rng: Rng, baselineScore: number, repeats = 5): Array<{ feature: string; importance: number; sd: number }> {
  const records = rows.map((index) => frame.rows[index]!)
  const out: Array<{ feature: string; importance: number; sd: number }> = []
  for (const feature of features) {
    const drops: number[] = []
    for (let repeat = 0; repeat < repeats; repeat++) {
      const shuffled = rng.shuffle(records.map((record) => record[feature] ?? null))
      const x = records.map((record, index) => transformRecord(pre, { ...record, [feature]: shuffled[index]! }))
      const score = scoreOf(task, metric, y, predictModel(model, x), classLabels).primary
      drops.push(LOWER_IS_BETTER.has(metric) ? score - baselineScore : baselineScore - score)
    }
    out.push({ feature, importance: mean(drops), sd: drops.length > 1 ? standardDeviation(drops) : 0 })
  }
  return out.sort((a, b) => b.importance - a.importance)
}

function fairnessReport(frame: Frame, rows: number[], attribute: string, y: number[], prediction: Prediction, task: Task, classLabels: string[]): { attribute: string; groups: Array<Record<string, unknown>>; gaps: Record<string, number>; flags: string[] } {
  if (!frame.columns.includes(attribute)) throw new Error(`sensitive attribute "${attribute}" is not a column`)
  const byGroup = new Map<string, number[]>()
  rows.forEach((index, position) => {
    const key = String(frame.rows[index]![attribute] ?? '(missing)')
    byGroup.set(key, [...(byGroup.get(key) ?? []), position])
  })
  const groups: Array<Record<string, unknown>> = []
  const flags: string[] = []
  for (const [group, positions] of byGroup) {
    if (positions.length < 10) {
      groups.push({ group, n: positions.length, note: 'fewer than 10 holdout rows — too few to assess' })
      continue
    }
    const actual = positions.map((p) => y[p]!)
    if (task === 'regression') {
      const metrics = regressionMetrics(actual, positions.map((p) => prediction.values[p]!))
      groups.push({ group, n: positions.length, mae: metrics.mae, rmse: metrics.rmse, bias: metrics.bias })
    } else if (task === 'binary') {
      const predicted = positions.map((p) => prediction.values[p]!)
      const tp = positions.filter((_, i) => predicted[i] === 1 && actual[i] === 1).length
      const fp = positions.filter((_, i) => predicted[i] === 1 && actual[i] === 0).length
      const positives = actual.filter((label) => label === 1).length
      const negatives = actual.length - positives
      groups.push({ group, n: positions.length, positiveRate: predicted.filter((label) => label === 1).length / predicted.length, truePositiveRate: positives ? tp / positives : null, falsePositiveRate: negatives ? fp / negatives : null, accuracy: predicted.filter((label, i) => label === actual[i]).length / predicted.length, auc: prediction.probabilities ? rocAuc(actual, positions.map((p) => prediction.probabilities![p]![1]!)) : null })
    } else {
      const metrics = classificationMetrics(actual, positions.map((p) => prediction.values[p]!), undefined, classLabels)
      groups.push({ group, n: positions.length, accuracy: metrics.accuracy, macroF1: metrics.macroF1 })
    }
  }
  const assessed = groups.filter((group) => !('note' in group))
  const gaps: Record<string, number> = {}
  for (const key of ['positiveRate', 'truePositiveRate', 'falsePositiveRate', 'accuracy', 'mae', 'macroF1']) {
    const values = assessed.map((group) => group[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (values.length >= 2) gaps[key] = Math.max(...values) - Math.min(...values)
  }
  const rates = assessed.map((group) => group.positiveRate).filter((value): value is number => typeof value === 'number')
  if (rates.length >= 2 && Math.max(...rates) > 0) {
    const ratio = Math.min(...rates) / Math.max(...rates)
    gaps.disparateImpactRatio = ratio
    if (ratio < 0.8) flags.push(`positive-prediction rate ratio across ${attribute} groups is ${ratio.toFixed(2)} (below the 0.8 "four-fifths" guideline)`)
  }
  if ((gaps.truePositiveRate ?? 0) > 0.1) flags.push(`true-positive rate differs by ${(gaps.truePositiveRate! * 100).toFixed(0)} points across ${attribute} groups (equal-opportunity gap)`)
  if ((gaps.accuracy ?? 0) > 0.1) flags.push(`accuracy differs by ${(gaps.accuracy! * 100).toFixed(0)} points across ${attribute} groups`)
  return { attribute, groups, gaps, flags }
}

// ---------------------------------------------------------------- inference and drift

export interface DriftFeature {
  feature: string
  psi: number
  level: 'stable' | 'moderate' | 'significant'
  missingRateReference: number
  missingRateCurrent: number
}

export function populationStabilityIndex(reference: number[], current: number[]): number {
  let psi = 0
  reference.forEach((r, index) => {
    const a = Math.max(r, 1e-4)
    const b = Math.max(current[index] ?? 0, 1e-4)
    psi += (b - a) * Math.log(b / a)
  })
  return psi
}

export function driftAgainstProfile(profile: TrainingProfileFeature[], frame: Frame, rows?: number[]): DriftFeature[] {
  const indices = rows ?? frame.rows.map((_, index) => index)
  return profile.filter((feature) => frame.columns.includes(feature.name)).map((feature) => {
    const values = indices.map((index) => frame.rows[index]![feature.name])
    const missingRateCurrent = values.filter((value) => isMissing(value)).length / Math.max(1, values.length)
    let shares: number[]
    if (feature.kind === 'numeric') {
      const numbers = values.map((value) => (typeof value === 'string' ? parseDateMs(value) ?? toNumber(value) : toNumber(value))).filter((value): value is number => value !== undefined)
      shares = binShares(numbers, feature.edges ?? [])
    } else {
      const counts = new Map<string, number>()
      let total = 0
      for (const value of values) if (!isMissing(value)) { counts.set(String(value), (counts.get(String(value)) ?? 0) + 1); total++ }
      const levelShares = (feature.levels ?? []).map((level) => (counts.get(level) ?? 0) / Math.max(1, total))
      shares = [...levelShares, 1 - levelShares.reduce((a, b) => a + b, 0)]
    }
    const psi = populationStabilityIndex(feature.shares, shares)
    return { feature: feature.name, psi, level: psi >= 0.25 ? 'significant' : psi >= 0.1 ? 'moderate' : 'stable', missingRateReference: feature.missingRate, missingRateCurrent }
  })
}

export function predictWithArtifact(artifact: ModelArtifact, frame: Frame): { prediction: Prediction; x: number[][]; missingFeatures: string[] } {
  const missingFeatures = artifact.features.filter((name) => !frame.columns.includes(name))
  const x = frame.rows.map((row) => transformRecord(artifact.preprocessor, row))
  return { prediction: predictModel(artifact.model, x), x, missingFeatures }
}
