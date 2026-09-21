import { expect, test } from 'bun:test'
import type { Metrics } from '../evolve/ledger.ts'
import { gateDecision, gateMode, pairedDifferences, sealedCompare } from './acceptance.ts'

function metrics(passed: string[], failed: string[], taskRates?: Record<string, number>): Metrics {
  return { passRate: passed.length / (passed.length + failed.length), passed, failed, totalTokens: 0, totalElapsedMs: 0, ...(taskRates ? { taskRates } : {}) }
}

const ids = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`)

test('paired differences use repeat rates when there are repeats, pass/fail otherwise', () => {
  expect(pairedDifferences(metrics(['a'], ['b']), metrics(['a', 'b'], []))).toEqual([0, 1])
  const before = metrics([], [], { a: 1 / 3, b: 1 })
  const after = metrics([], [], { a: 1, b: 2 / 3, c: 1 })
  const diffs = pairedDifferences(before, after)
  expect(diffs[0]).toBeCloseTo(2 / 3, 9)
  expect(diffs[1]).toBeCloseTo(-1 / 3, 9)
  expect(diffs).toHaveLength(2) // c has no baseline
})

test('elia\'s bench today: fixing 2 of the 4 failing tasks cannot be certified', () => {
  // 54 tasks, 50 passing — the shape of the last recorded full bench.
  const all = ids(54)
  const baseline = metrics(all.slice(0, 50), all.slice(50))
  const candidate = metrics(all.slice(0, 52), all.slice(52))
  const verdict = sealedCompare(baseline, candidate, { index: 1 })
  expect(verdict.bit).toBe('reject')
  expect(verdict.minimumDetectable).toBeGreaterThan(verdict.meanDiff)
  expect(verdict.reason).toContain('can certify gains of about')
})

test('a broad real gain is certified, and later comparisons need more evidence', () => {
  const all = ids(60)
  const baseline = metrics(all.slice(0, 20), all.slice(20))
  const candidate = metrics(all.slice(0, 45), all.slice(45))
  const first = sealedCompare(baseline, candidate, { index: 1 })
  expect(first.bit).toBe('accept')
  const hundredth = sealedCompare(baseline, candidate, { index: 100 })
  expect(hundredth.needed).toBeGreaterThan(first.needed)
})

test('no change is never certified, and nothing measured is rejected', () => {
  const all = ids(40)
  const same = metrics(all.slice(0, 30), all.slice(30))
  expect(sealedCompare(same, same, { index: 1 }).bit).toBe('reject')
  expect(sealedCompare(metrics([], []), metrics([], []), { index: 1 }).reason).toContain('no task')
})

test('gate modes', () => {
  expect(gateMode({})).toBe('legacy')
  expect(gateMode({ ELIA_EVOLVE_GATE: 'Sealed' })).toBe('sealed')
  expect(gateMode({ ELIA_EVOLVE_GATE: 'both' })).toBe('both')
  expect(gateMode({ ELIA_EVOLVE_GATE: 'nonsense' })).toBe('legacy')
  const accept = { bit: 'accept' } as Parameters<typeof gateDecision>[2]
  const reject = { bit: 'reject' } as Parameters<typeof gateDecision>[2]
  expect(gateDecision('legacy', true, reject)).toBe(true)
  expect(gateDecision('sealed', true, reject)).toBe(false)
  expect(gateDecision('sealed', false, accept)).toBe(true)
  expect(gateDecision('both', true, accept)).toBe(true)
  expect(gateDecision('both', false, accept)).toBe(false)
})
