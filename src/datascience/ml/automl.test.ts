import { expect, test } from 'bun:test'
import { frameFromRows } from '../frame.ts'
import { createRng } from '../rng.ts'
import { understandDataset } from '../understand.ts'
import { driftAgainstProfile, predictWithArtifact, trainAutoML } from './automl.ts'
import { explainPrediction, partialDependence } from './explain.ts'
import { dbscan, gaussianMixture, isolationForest, kMeans, localOutlierFactor, mahalanobis, pca, silhouette, tsne, wardHierarchical } from './unsupervised.ts'

function churnFrame(n: number, seed: number) {
  const rng = createRng(seed)
  const rows = Array.from({ length: n }, (_, i) => {
    const tenure = Math.round(rng.next() * 60)
    const charges = 20 + rng.next() * 100
    const contract = ['monthly', 'annual', 'two-year'][rng.int(3)]!
    const tickets = Math.floor(rng.next() * 6)
    const logit = -1 + 0.04 * (charges - 70) - 0.06 * tenure + (contract === 'monthly' ? 1.2 : -0.6) + 0.35 * tickets
    const churned = rng.next() < 1 / (1 + Math.exp(-logit)) ? 1 : 0
    return { customer_id: `C${i}`, tenure, charges, contract, tickets, region: ['north', 'south'][rng.int(2)]!, churned, churn_reason: churned ? 'price' : null }
  })
  return frameFromRows(rows)
}

test('AutoML trains, selects on validation, beats the baseline on the holdout, and screens leakage', () => {
  const frame = churnFrame(1200, 1)
  const u = understandDataset(frame)
  const result = trainAutoML({ frame, target: 'churned', profiles: u.profiles, algorithms: ['logistic', 'random_forest', 'gradient_boosting'], params: { random_forest: { nEstimators: 40 }, gradient_boosting: { nEstimators: 120 } }, sensitive: ['region'] })
  expect(result.task).toBe('binary')
  expect(result.excluded.map((e) => e.name)).toContain('customer_id')
  expect(result.leakage.map((l) => l.feature)).toContain('churn_reason')
  expect(result.features).not.toContain('churn_reason')
  expect(result.leaderboard[0]!.cvMean).toBeGreaterThan(0.7)
  expect(result.checks.find((c) => c.name === 'beats baseline on the untouched holdout')!.status).toBe('pass')
  expect(result.permutationImportance[0]!.feature).not.toBe('region')
  expect(result.fairness![0]!.attribute).toBe('region')
  expect(result.calibration!.ece).toBeLessThan(0.2)
  const artifact = JSON.parse(JSON.stringify(result.artifact))
  const fresh = churnFrame(200, 2)
  const scored = predictWithArtifact(artifact, fresh)
  expect(scored.prediction.probabilities).toHaveLength(200)
  expect(driftAgainstProfile(artifact.trainingProfile, fresh).every((d) => d.level !== 'significant')).toBe(true)
  const pd = partialDependence(artifact, fresh, 'tenure', createRng(1))
  expect(pd.average[0]!).toBeGreaterThan(pd.average.at(-1)!)
  const local = explainPrediction(artifact, fresh.rows[0]!)
  expect(local.contributions.length).toBeGreaterThan(0)
})

test('AutoML regression with time-ordered validation never trains on the future', () => {
  const rng = createRng(3)
  const rows = Array.from({ length: 400 }, (_, i) => {
    const date = new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    const promo = rng.next() < 0.2 ? 1 : 0
    return { date, day_index: i, promo, dow: (i % 7) + 1, sales: 100 + 0.1 * i + 30 * promo + (i % 7 === 5 ? 20 : 0) + rng.normal(0, 5) }
  })
  const frame = frameFromRows(rows)
  const result = trainAutoML({ frame, target: 'sales', timeColumn: 'date', features: ['day_index', 'promo', 'dow'], profiles: understandDataset(frame).profiles, algorithms: ['ridge', 'gradient_boosting'], params: { gradient_boosting: { nEstimators: 100 } } })
  expect(result.validation.strategy).toContain('time-series')
  expect(result.validation.holdout).toContain('most recent')
  expect(result.features).not.toContain('date')
  expect(result.warnings.some((w) => w.includes('trends over date'))).toBe(true)
  expect(result.selected.algorithm).toBe('ridge')
  expect(result.test.selected.r2 as number).toBeGreaterThan(0.3)
})

test('clustering, reduction, and anomaly detection recover planted structure', () => {
  const rng = createRng(4)
  const centers = [[0, 0], [6, 6], [0, 8]]
  const x = Array.from({ length: 300 }, (_, i) => centers[i % 3]!.map((c) => c + rng.normal(0, 0.6)))
  const km = kMeans(x, 3, rng)
  expect(km.sizes.sort((a, b) => a - b)).toEqual([100, 100, 100])
  expect(silhouette(x, km.labels, rng)).toBeGreaterThan(0.7)
  expect(dbscan(x, 1.2, 5).clusters).toBe(3)
  expect(new Set(wardHierarchical(x.slice(0, 150), 3).labels).size).toBe(3)
  expect(gaussianMixture(x, 3, rng).bic).toBeLessThan(gaussianMixture(x, 1, rng).bic)
  const p = pca(x.map(([a, b]) => [a!, b!, a! + b! + rng.normal(0, 0.01)]), 2)
  expect(p.explainedVarianceRatio[0]! + p.explainedVarianceRatio[1]!).toBeGreaterThan(0.99)
  expect(tsne(x.slice(0, 60), rng, { iterations: 300 })).toHaveLength(60)
  const withOutlier = [...x, [30, -30]]
  const iso = isolationForest(withOutlier, rng)
  expect(iso.indexOf(Math.max(...iso))).toBe(300)
  const lof = localOutlierFactor(withOutlier, 10)
  expect(lof.indexOf(Math.max(...lof))).toBe(300)
  expect(mahalanobis(withOutlier).pValue[300]).toBeLessThan(1e-6)
})
