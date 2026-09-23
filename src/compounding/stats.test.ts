import { expect, test } from 'bun:test'
import { eValue, olsSlope, phi, seededRandom, spentLevel, summarize, wilson } from './stats.ts'

test('wilson: a proper interval even at 0 and at n', () => {
  const none = wilson(0, 20)
  expect(none.mean).toBe(0)
  expect(none.lo).toBe(0)
  expect(none.hi).toBeGreaterThan(0.1) // zero observed is not zero possible
  const all = wilson(20, 20)
  expect(all.hi).toBe(1)
  expect(all.lo).toBeLessThan(0.9)
  expect(wilson(0, 0).mean).toBeUndefined()
  const mid = wilson(50, 100)
  expect(mid.lo).toBeCloseTo(0.404, 2)
  expect(mid.hi).toBeCloseTo(0.596, 2)
})

test('phi recovers the correlation the verifiers were built with', () => {
  const random = seededRandom(7)
  const a: boolean[] = []
  const b: boolean[] = []
  // Shared difficulty: half the time both judges see the same coin.
  for (let i = 0; i < 20_000; i++) {
    const shared = random() < 0.5
    const coinA = random() < 0.2
    a.push(coinA)
    b.push(shared ? coinA : random() < 0.2)
  }
  expect(phi(a, b)!).toBeCloseTo(0.5, 1)
  expect(phi([true, true], [false, true])).toBeUndefined()
})

test('eValue: stays small under no change, grows under a real gain', () => {
  const random = seededRandom(11)
  let falseRejections = 0
  const trials = 400
  for (let trial = 0; trial < trials; trial++) {
    // Null: each task's difference is symmetric noise around zero.
    const diffs = Array.from({ length: 100 }, () => (random() < 0.1 ? (random() < 0.5 ? 1 : -1) : 0))
    if (eValue(diffs) >= 20) falseRejections += 1
  }
  expect(falseRejections / trials).toBeLessThanOrEqual(0.05)

  // A gain on 15 of 60 tasks with no losses is overwhelming evidence.
  const gain = [...Array(15).fill(1), ...Array(45).fill(0)]
  expect(eValue(gain)).toBeGreaterThan(100)
  // Order cannot be chosen to help: the value is the same however the tasks are listed.
  expect(eValue([1, 0, -1, 1, 0])).toBeCloseTo(eValue([0, 1, 1, -1, 0]), 12)
})

test('spentLevel sums to δ over a lifetime of comparisons', () => {
  let total = 0
  for (let k = 1; k <= 200_000; k++) total += spentLevel(k, 0.05)
  expect(total).toBeLessThan(0.05)
  expect(total).toBeGreaterThan(0.0499)
  expect(spentLevel(1, 0.05)).toBeCloseTo(0.0304, 4)
})

test('olsSlope and summarize', () => {
  const xs = [0, 1, 2, 3, 4]
  const fit = olsSlope(xs, xs.map((x) => 2 * x + 1))!
  expect(fit.slope).toBeCloseTo(2, 9)
  expect(fit.intercept).toBeCloseTo(1, 9)
  expect(fit.se).toBeCloseTo(0, 9)
  expect(olsSlope([1, 1, 1], [1, 2, 3])).toBeUndefined()
  const s = summarize([1, 2, 3, 4])
  expect(s.mean).toBe(2.5)
  expect(s.variance).toBeCloseTo(1.6667, 3)
})
