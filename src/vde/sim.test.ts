import { expect, test } from 'bun:test'
import { binomial, metaLoopControls, simArgmax, simLibrary, simSteppingStones, simThreshold } from './sim.ts'
import { seededRandom } from './stats.ts'
import { repairedSoundFraction, resamplingPrecision, soundFraction } from './theory.ts'

test('binomial draws have the right mean on both branches', () => {
  const rand = seededRandom(1)
  const small = Array.from({ length: 4000 }, () => binomial(100, 0.05, rand))
  const large = Array.from({ length: 4000 }, () => binomial(2000, 0.4, rand))
  expect(small.reduce((a, b) => a + b, 0) / small.length).toBeCloseTo(5, 0)
  expect(large.reduce((a, b) => a + b, 0) / large.length / 2000).toBeCloseTo(0.4, 2)
})

test('§11.1: argmax rises then collapses; the threshold holds Proposition 1', () => {
  const rand = seededRandom(1)
  const peak = simArgmax(128, rand, { trials: 20_000 })
  const late = simArgmax(2048, rand, { trials: 20_000 })
  expect(peak).toBeGreaterThan(0.65)
  expect(late).toBeLessThan(0.05)
  const threshold = simThreshold(2048, rand, { trials: 20_000 })
  expect(threshold.precision).toBeCloseTo(resamplingPrecision(0.05, 0.01, 0.1), 1)
  expect(threshold.coverage).toBeGreaterThan(0.99)
})

test('§11.2: the error threshold appears where Theorem 1 puts it', () => {
  const rand = seededRandom(2)
  const opts = { generations: 300, burn: 150, reps: 3 }
  expect(simLibrary(40, rand, opts)).toBeCloseTo(soundFraction(2, 0.01, 40), 1)
  expect(simLibrary(80, rand, opts)).toBe(0)
  expect(simLibrary(80, rand, { ...opts, r: 0.5 })).toBeCloseTo(repairedSoundFraction(2, 0.01, 80, 0.5), 1)
})

test('§11.3: the archive waits linearly', () => {
  const result = simSteppingStones(4, seededRandom(3), { trials: 5_000 })
  expect(result.archive).toBeCloseTo(20, 0)
  expect(result.resample).toBeGreaterThan(500)
  expect(result.sound).toBeCloseTo(0.95 ** 4, 1)
})

test('§11.4 with its missing control: tampering passes valid statistics; holdout size buys the gain', () => {
  const [naiveSmall, validSmall, validLarge, tampered, naiveLarge] = metaLoopControls({ seeds: 2, fresh: 500, small: 300, large: 2000 })
  // A small holdout blocks everything under the valid bar.
  expect(validSmall!.realAccepted).toBeLessThan(naiveSmall!.realAccepted)
  // Statistics do not stop tampering: every reachable tampering action got through.
  expect(tampered!.tamperAccepted).toBeGreaterThan(0)
  expect(tampered!.measured - tampered!.fresh).toBeGreaterThan(0.2)
  // The control: naive gating at the large holdout is no worse on true gain.
  expect(naiveLarge!.trueGain).toBeGreaterThanOrEqual(validLarge!.trueGain - 0.03)
}, 60_000)
