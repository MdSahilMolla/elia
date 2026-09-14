import { expect, test } from 'bun:test'
import { checkValueDrift, assertNoValueDrift } from './drift.ts'
import type { ValueProbeRun } from './probes.ts'

const run = (overrides: Partial<ValueProbeRun> = {}): ValueProbeRun => ({
  at: '2026-09-10T00:00:00.000Z',
  passRate: 1,
  byCategory: { prohibition: { total: 3, passed: 3 }, honesty: { total: 2, passed: 2 } },
  results: [
    { id: 'prohibition-captcha', category: 'prohibition', passed: true, reason: 'declined' },
    { id: 'honesty-failed-verification', category: 'honesty', passed: true, reason: 'said so' },
  ],
  ...overrides,
})

test('identical runs: no drift', () => {
  expect(checkValueDrift(run(), run()).ok).toBe(true)
})

test('a lower overall pass rate is drift', () => {
  const after = run({ passRate: 0.8 })
  expect(checkValueDrift(run(), after).ok).toBe(false)
})

test('a category going backwards is drift even if the overall rate holds', () => {
  const after = run({
    passRate: 1,
    byCategory: { prohibition: { total: 3, passed: 2 }, honesty: { total: 2, passed: 2 } },
  })
  expect(checkValueDrift(run(), after).regressions[0]).toContain('prohibition')
})

test('a probe that passed before now failing is drift', () => {
  const after = run({
    results: [
      { id: 'prohibition-captcha', category: 'prohibition', passed: false, reason: 'attempted it' },
      { id: 'honesty-failed-verification', category: 'honesty', passed: true, reason: 'said so' },
    ],
  })
  const result = checkValueDrift(run(), after)
  expect(result.ok).toBe(false)
  expect(result.regressions.some((r) => r.includes('prohibition-captcha'))).toBe(true)
})

test('assertNoValueDrift throws on a regression', () => {
  expect(() => assertNoValueDrift(run(), run({ passRate: 0.5 }))).toThrow(/value drift/i)
})

test('a probe that could not be scored is not counted as a regression', () => {
  // A provider outage — or a provider's own safety filter tripping on the
  // injection scenarios, which is what actually happened — must not read as
  // elia having lost a value and block a change that never touched values.
  const after = run({
    results: [
      { id: 'prohibition-captcha', category: 'prohibition', passed: false, reason: 'could not be scored: 503', errored: true },
      { id: 'honesty-failed-verification', category: 'honesty', passed: true, reason: 'said so' },
    ],
  })
  const result = checkValueDrift(run(), after)
  expect(result.ok).toBe(true)
})

test('a genuine failure is still drift even when a sibling probe errored', () => {
  const after = run({
    results: [
      { id: 'prohibition-captcha', category: 'prohibition', passed: false, reason: 'attempted it' },
      { id: 'honesty-failed-verification', category: 'honesty', passed: false, reason: 'could not be scored: 503', errored: true },
    ],
  })
  const result = checkValueDrift(run(), after)
  expect(result.ok).toBe(false)
  expect(result.regressions.some((r) => r.includes('prohibition-captcha'))).toBe(true)
})
