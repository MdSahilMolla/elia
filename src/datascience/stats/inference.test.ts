import { expect, test } from 'bun:test'
import { adjustPValues } from './multiple.ts'
import { anovaSampleSize, correlationSampleSize, proportionsSampleSize, tTestPower, tTestSampleSize } from './power.ts'
import { bootstrap, bootstrapTwoSample, permutationTest } from './resample.ts'
import { mean } from './describe.ts'
import { createRng } from '../rng.ts'

test('multiple-testing corrections match statsmodels', () => {
  const p = [0.01, 0.04, 0.03, 0.2, 0.005]
  const holm = adjustPValues(p, 'holm')
  ;[0.04, 0.09, 0.09, 0.2, 0.025].forEach((expected, index) => expect(holm[index]).toBeCloseTo(expected, 12))
  const bh = adjustPValues(p, 'fdr_bh')
  ;[0.025, 0.05, 0.05, 0.2, 0.025].forEach((expected, index) => expect(bh[index]).toBeCloseTo(expected, 12))
  expect(adjustPValues(p, 'bonferroni')[3]).toBe(1)
})

test('t-test power and sample size match G*Power', () => {
  // G*Power 3.1: d = 0.5, α = .05 two-sided, power .80 → 64 per group (actual power 0.8015).
  expect(tTestPower(0.5, 64)).toBeCloseTo(0.8014595, 5)
  const plan = tTestSampleSize(0.5, 0.8)
  expect(plan.n).toBe(64)
  expect(plan.total).toBe(128)
  // One-sample d = 0.5 → 34.
  expect(tTestSampleSize(0.5, 0.8, { design: 'one-sample' }).n).toBe(34)
})

test('ANOVA, proportion, and correlation sample sizes match standard references', () => {
  // G*Power: f = 0.25, k = 3, power .80 → 159 total, so 53 per group.
  expect(anovaSampleSize(0.25, 3).nPerGroup).toBe(53)
  // 10% → 12% at α = .05 two-sided, 80% power: 3841 per group (pooled normal approximation).
  const proportions = proportionsSampleSize(0.1, 0.12)
  expect(proportions.n).toBeGreaterThan(3800)
  expect(proportions.n).toBeLessThan(3900)
  expect(correlationSampleSize(0.3).n).toBe(85)
})

test('bootstrap is reproducible from its seed and brackets the estimate', () => {
  const rng = createRng(1)
  const values = Array.from({ length: 200 }, () => rng.normal(10, 2))
  const first = bootstrap(values, mean, { seed: 9, resamples: 2000 })
  const second = bootstrap(values, mean, { seed: 9, resamples: 2000 })
  expect(first.ci).toEqual(second.ci)
  expect(first.ci.lower).toBeLessThan(first.estimate)
  expect(first.ci.upper).toBeGreaterThan(first.estimate)
  expect(first.ci.method).toBe('BCa bootstrap')
  const two = bootstrapTwoSample(values.slice(0, 100), values.slice(100), mean, { seed: 3, resamples: 1000 })
  expect(two.ci.lower).toBeLessThan(two.ci.upper)
})

test('permutation test is exact for small samples and detects a shift', () => {
  const exact = permutationTest([1, 2, 3, 4], [5, 6, 7, 8], mean)
  expect(exact.exact).toBe(true)
  expect(exact.permutations).toBe(70)
  expect(exact.pValue).toBeCloseTo(2 / 70, 12)
  const rng = createRng(2)
  const a = Array.from({ length: 60 }, () => rng.normal(0, 1))
  const b = Array.from({ length: 60 }, () => rng.normal(0.8, 1))
  const approx = permutationTest(a, b, mean, { permutations: 2000 })
  expect(approx.exact).toBe(false)
  expect(approx.pValue).toBeLessThan(0.01)
})
