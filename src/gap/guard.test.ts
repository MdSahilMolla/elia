import { expect, test } from 'bun:test'
import { checkGapNotRegressed, assertGapNotRegressed } from './guard.ts'
import type { GapVector } from './types.ts'

const base: GapVector = {
  at: '2026-09-10T00:00:00.000Z',
  ref: 'aaaaaaa',
  defectsTotal: 11,
  defectsScored: 9,
  mechanicalCatchRate: 1,
  falsePositiveRate: 0,
  byRegime: { mechanical: { total: 9, caught: 9 }, empirical: { total: 0, caught: 0 }, judgment: { total: 2, caught: 0 } },
  byRung: {},
  calibrationContradictionRate: 0,
  escapees: [],
}

test('an identical vector is not a regression', () => {
  expect(checkGapNotRegressed(base, { ...base, ref: 'bbbbbbb' }).ok).toBe(true)
})

test('a drop in mechanical catch rate beyond epsilon is a regression', () => {
  const after = { ...base, mechanicalCatchRate: 0.77 }
  const result = checkGapNotRegressed(base, after)
  expect(result.ok).toBe(false)
  expect(result.regressions[0]).toContain('mechanical catch rate fell')
})

test('a tiny drop within epsilon is tolerated as noise', () => {
  expect(checkGapNotRegressed(base, { ...base, mechanicalCatchRate: 0.99 }).ok).toBe(true)
})

test('a newly escaping defect is a hard regression even at the same rate', () => {
  const after: GapVector = {
    ...base,
    mechanicalCatchRate: 1,
    escapees: ['test-off-by-one'],
    defectsScored: 10,
  }
  const result = checkGapNotRegressed(base, after)
  expect(result.ok).toBe(false)
  expect(result.regressions.some((r) => r.includes('test-off-by-one'))).toBe(true)
})

test('a rise in false-positive rate is a regression', () => {
  expect(checkGapNotRegressed(base, { ...base, falsePositiveRate: 0.2 }).ok).toBe(false)
})

test('a rise in critic false-accept is a regression when both sides measured it', () => {
  const b = { ...base, criticFalseAcceptRate: 0.1 }
  const a = { ...base, criticFalseAcceptRate: 0.4 }
  expect(checkGapNotRegressed(b, a).ok).toBe(false)
  // Not comparable when the earlier run never measured it.
  expect(checkGapNotRegressed(base, a).ok).toBe(true)
})

test('assertGapNotRegressed throws with the regression list', () => {
  expect(() => assertGapNotRegressed(base, { ...base, mechanicalCatchRate: 0.5 })).toThrow(/gap regressed/i)
})
