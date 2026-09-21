import { expect, test } from 'bun:test'
import {
  acceptWithin,
  archiveWait,
  argmaxHalvingSamples,
  argmaxPeak,
  argmaxPrecisionBound,
  bernsteinBar,
  errorThreshold,
  frontierMargin,
  growthRegime,
  heldOutNeeded,
  hoeffdingBar,
  inFrontier,
  libraryAt,
  lineageSoundness,
  pairFalseAccept,
  proofreadSlip,
  proofreadThreshold,
  repairedSoundFraction,
  repairedThreshold,
  requiredSuccessRate,
  resamplingPrecision,
  resampleWait,
  saturationSamples,
  soundFraction,
  soundFractionStep,
  stackedFalseAccept,
} from './theory.ts'

// Every number below is one the paper states. If one of these moves, either the
// paper was wrong or the code is — find out which before changing the expectation.

test('§3.1 table: compute cannot buy precision, a stricter verifier or a better tool can', () => {
  expect(resamplingPrecision(0.02, 0.05, 0.1)).toBeCloseTo(0.27, 2)
  expect(resamplingPrecision(0.02, 0.025, 0.1)).toBeCloseTo(0.42, 2)
  expect(resamplingPrecision(0.1, 0.05, 0.1)).toBeCloseTo(0.67, 2)
  // Coverage grows with n; precision does not.
  expect(acceptWithin(0.02, 0.05, 0.1, 1000)).toBeGreaterThan(acceptWithin(0.02, 0.05, 0.1, 10))
})

test('§11.1: the thresholded verifier holds Proposition 1\'s 82.6%', () => {
  expect(resamplingPrecision(0.05, 0.01, 0.1)).toBeCloseTo(0.826, 3)
})

test('Corollary 1: the frontier reduces to p ≳ α at half precision', () => {
  expect(inFrontier(0.1, 0.05, 0)).toBe(true)
  expect(inFrontier(0.02, 0.05, 0)).toBe(false)
  // Exactly on the boundary: odds(p) = α/(1−β), so p = α/(1+α) when β = 0.
  expect(frontierMargin(0.05 / 1.05, 0.05, 0)).toBeCloseTo(0, 6)
  // The boundary success rate is exactly where precision equals the target.
  const p = requiredSuccessRate(0.05, 0.1, 0.8)
  expect(resamplingPrecision(p, 0.05, 0.1)).toBeCloseTo(0.8, 9)
})

test('Corollary 2: compute saturates after ln(1/δ) over the per-sample accept rate', () => {
  const perSample = 0.05 * 0.9 + 0.95 * 0.01
  expect(saturationSamples(0.05, 0.01, 0.1, 0.01)).toBeCloseTo(Math.log(100) / perSample, 6)
  expect(saturationSamples(0, 0, 0)).toBe(Number.POSITIVE_INFINITY)
})

test('§3.2: a correlated second judge buys much less than an independent one', () => {
  expect(stackedFalseAccept([0.1, 0.1])).toBeCloseTo(0.01, 9)
  expect(pairFalseAccept(0.1, 0.1, 0)).toBeCloseTo(0.01, 9)
  expect(pairFalseAccept(0.1, 0.1, 0.5)).toBeCloseTo(0.055, 9)
  expect(pairFalseAccept(0.1, 0.1, 0.8)).toBeCloseTo(0.082, 9)
  // Never more than the stricter judge alone.
  expect(pairFalseAccept(0.1, 0.2, 1)).toBeLessThanOrEqual(0.1)
})

test('§3.3 and A.2: argmax over a learned score peaks near 65 and halves every ~365', () => {
  expect(argmaxPeak(0.05, 0.002)).toBeCloseTo(65, 0)
  expect(argmaxHalvingSamples(0.05, 0.002)).toBeCloseTo(364.5, 0)
  expect(argmaxPrecisionBound(0.05, 0.002, 4096)).toBeLessThan(0.001)
})

test('Proposition 4: an archive turns 100 million samples into 80', () => {
  expect(resampleWait(0.1, 8)).toBeCloseTo(1e8, -2)
  expect(archiveWait(0.1, 8)).toBe(80)
  expect(lineageSoundness(0.05, 20)).toBeCloseTo(0.36, 2)
  expect(lineageSoundness(0.05, 60)).toBeCloseTo(0.05, 2)
})

test('Theorem 1 table: L* across slip rates and selection pressures', () => {
  const rows: Array<[number, number, number, number]> = [
    [0.05, 7.9, 13.5, 27.0],
    [0.01, 40.3, 69.0, 137.9],
    [0.001, 405.3, 692.8, 1385.6],
  ]
  for (const [eps, s15, s2, s4] of rows) {
    expect(errorThreshold(1.5, eps)).toBeCloseTo(s15, 1)
    expect(errorThreshold(2, eps)).toBeCloseTo(s2, 1)
    expect(errorThreshold(4, eps)).toBeCloseTo(s4, 1)
  }
  expect(errorThreshold(1, 0.01)).toBe(0)
})

test('Theorem 1: near the threshold most of the library is junk that still looks certified', () => {
  expect(soundFraction(2, 0.01, 50)).toBeCloseTo(0.21, 2)
  expect(soundFraction(2, 0.01, 70)).toBe(0)
  // The recursion converges to the closed form.
  let x = 1
  const q = (1 - 0.01) ** 50
  for (let i = 0; i < 2000; i++) x = soundFractionStep(x, 2, q)
  expect(x).toBeCloseTo(soundFraction(2, 0.01, 50), 6)
})

test('§5.3: an audit catching half of unsound artifacts moves 69 to 138', () => {
  expect(repairedThreshold(2, 0.01, 0.5)).toBeCloseTo(138, 0)
  expect(repairedThreshold(2, 0.01, 0)).toBeCloseTo(errorThreshold(2, 0.01), 9)
  // An over-zealous auditor gives some of it back.
  expect(repairedThreshold(2, 0.01, 0.5, 0.2)).toBeLessThan(repairedThreshold(2, 0.01, 0.5))
  // §11.2's audit curve at L = 60: theory 0.396.
  expect(repairedSoundFraction(2, 0.01, 60, 0.5)).toBeCloseTo(0.396, 3)
})

test('§5.3 proofreading: 69 → 6,900 only when the passes are independent', () => {
  expect(proofreadSlip(0.01, 2, 0)).toBeCloseTo(1e-4, 12)
  expect(proofreadThreshold(2, 0.01, 2, 0)).toBeCloseTo(6931, -1)
  // At k = 2 the correlated model is exactly Proposition 2.
  expect(proofreadSlip(0.01, 2, 0.5)).toBeCloseTo(0.0001 + 0.5 * 0.01 * 0.99, 12)
  expect(proofreadThreshold(2, 0.01, 2, 0.5)).toBeCloseTo(137, 0)
  expect(proofreadSlip(0.01, 5, 1)).toBe(0.01)
})

test('§6.1: three growth regimes from one exponent', () => {
  expect(growthRegime(0.5)).toBe('polynomial')
  expect(growthRegime(1)).toBe('exponential')
  expect(growthRegime(1.5)).toBe('hyperbolic')
  expect(libraryAt(1, 1, 1, 1)).toBeCloseTo(Math.E, 9)
  expect(libraryAt(1, 1, 0, 3)).toBeCloseTo(4, 9) // λ = 0: linear
  expect(libraryAt(1, 1, 2, 2)).toBe(Number.POSITIVE_INFINITY) // blew up at t = 1
})

test('Proposition 5 and A.3: the acceptance bars the paper quotes', () => {
  expect(hoeffdingBar(500, 1000, 0.05)).toBeCloseTo(0.2, 2)
  expect(bernsteinBar(500, 1000, 0.09, 0.05)).toBeCloseTo(0.086, 3)
  const n = heldOutNeeded(0.02, 1000, 0.3, 0.05)
  expect(n).toBeGreaterThan(5000)
  expect(n).toBeLessThan(6500)
  expect(bernsteinBar(n, 1000, 0.09)).toBeLessThanOrEqual(0.02)
  expect(bernsteinBar(n - 1, 1000, 0.09)).toBeGreaterThan(0.02)
})
