import { expect, test } from 'bun:test'
import { mean, median, minimumDetectableShift, normalQuantile, requiredPerArmForMeans, requiredPerArmForRates, sd, seeded, stratifiedComparison } from './stats.ts'
import type { Observation } from './stats.ts'

test('the normal quantile matches the tables in the body and the tails', () => {
  expect(normalQuantile(0.5)).toBeCloseTo(0, 9)
  expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5)
  expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5)
  expect(normalQuantile(0.995)).toBeCloseTo(2.575829, 5)
  expect(normalQuantile(0.999)).toBeCloseTo(3.090232, 5)
  expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5)
  expect(() => normalQuantile(0)).toThrow()
  expect(() => normalQuantile(1)).toThrow()
})

test('descriptive statistics', () => {
  expect(mean([1, 2, 3, 4])).toBe(2.5)
  expect(median([3, 1, 2])).toBe(2)
  expect(median([1, 2, 3, 4])).toBe(2.5)
  expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4)
  expect(Number.isNaN(sd([1]))).toBe(true)
  expect(Number.isNaN(mean([]))).toBe(true)
})

test('a seeded generator repeats and stays in [0, 1)', () => {
  const a = seeded(5)
  const b = seeded(5)
  const draws = Array.from({ length: 50 }, () => a())
  expect(draws).toEqual(Array.from({ length: 50 }, () => b()))
  expect(draws.every((x) => x >= 0 && x < 1)).toBe(true)
})

test('sample sizes match the textbook figures', () => {
  // A half-standard-deviation shift at 80% power and a 5% level needs ~63 per arm.
  expect(requiredPerArmForMeans(1, 0.5)).toBe(63)
  // Half the sigma needs four times the sample when the shift is halved again.
  expect(requiredPerArmForMeans(1, 0.25)).toBeGreaterThan(4 * 62)
  expect(requiredPerArmForRates(0.5, 0.35)).toBe(170)
  expect(minimumDetectableShift(1, 63)).toBeCloseTo(0.5, 1)
})

const arm = (stratum: string, treated: boolean, ys: number[]): Observation[] => ys.map((y) => ({ stratum, treated, y }))

test('a real difference inside strata is found', () => {
  const observations = [
    ...arm('a', true, Array.from({ length: 30 }, (_, i) => 0.8 + (i % 3) * 0.01)),
    ...arm('a', false, Array.from({ length: 30 }, (_, i) => 0.5 + (i % 3) * 0.01)),
    ...arm('b', true, Array.from({ length: 30 }, (_, i) => 0.7 + (i % 3) * 0.01)),
    ...arm('b', false, Array.from({ length: 30 }, (_, i) => 0.4 + (i % 3) * 0.01)),
  ]
  const result = stratifiedComparison(observations)
  expect(result.diff).toBeCloseTo(0.3, 2)
  expect(result.p).toBeLessThan(0.01)
  expect(result.ci[0]).toBeGreaterThan(0.25)
  expect(result.ci[1]).toBeLessThan(0.35)
  expect(result.strata).toBe(2)
  expect(result.dropped).toBe(0)
})

test('identical arms are not called different', () => {
  const ys = Array.from({ length: 40 }, (_, i) => (i % 7) / 7)
  const result = stratifiedComparison([...arm('a', true, ys), ...arm('a', false, ys)])
  expect(result.diff).toBeCloseTo(0, 9)
  expect(result.p).toBeGreaterThan(0.9)
})

test('a difference that is only the mix of strata disappears once strata are held equal', () => {
  // The treated arm lives mostly in the high-outcome stratum: a naive comparison sees a large gap.
  const observations = [...arm('high', true, Array(90).fill(1)), ...arm('high', false, Array(10).fill(1)), ...arm('low', true, Array(10).fill(0)), ...arm('low', false, Array(90).fill(0))]
  const naive = mean(observations.filter((o) => o.treated).map((o) => o.y)) - mean(observations.filter((o) => !o.treated).map((o) => o.y))
  expect(naive).toBeGreaterThan(0.7)
  const result = stratifiedComparison(observations)
  expect(result.diff).toBeCloseTo(0, 9)
  expect(result.p).toBeGreaterThan(0.9)
})

test('strata holding only one arm are dropped, and nothing left is not a number', () => {
  const partial = stratifiedComparison([...arm('a', true, [1, 1]), ...arm('a', false, [0, 0]), ...arm('b', true, [1, 1, 1])])
  expect(partial.dropped).toBe(3)
  expect(partial.strata).toBe(1)
  const none = stratifiedComparison(arm('a', true, [1, 1]))
  expect(Number.isNaN(none.diff)).toBe(true)
  expect(none.treated).toBe(0)
})

test('the same seed gives the same p-value and interval', () => {
  const observations = [...arm('a', true, [0.9, 0.7, 0.8, 0.6]), ...arm('a', false, [0.5, 0.6, 0.4, 0.7])]
  expect(stratifiedComparison(observations, { seed: 4 })).toEqual(stratifiedComparison(observations, { seed: 4 }))
})
