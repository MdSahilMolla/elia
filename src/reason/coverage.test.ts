import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-coverage-test'

const { coverageOf, recentCoverage, renderCoverage, verifiableTurns } = await import('./coverage.ts')
import type { TurnOutcome } from '../autonomy/outcomes.ts'

let clock = 0
const turn = (overrides: Partial<TurnOutcome> = {}): TurnOutcome => ({
  at: (clock += 1),
  prompt: '',
  filesChanged: 1,
  domains: [],
  editRetries: 0,
  toolErrors: 0,
  verify: 'pass',
  repairAttempts: 0,
  aborted: false,
  ...overrides,
})

test('only turns that changed files and finished are judged', () => {
  const rows = [turn(), turn({ filesChanged: 0 }), turn({ aborted: true }), turn({ failed: true })]
  expect(verifiableTurns(rows).length).toBe(1)
})

test('a question that changed nothing does not flatter the rate', () => {
  // Counting answer-only turns as "verified" would make the number look better
  // for exactly the wrong reason — nothing was ever at risk in them.
  const rows = [turn({ verify: 'none' }), ...Array.from({ length: 9 }, () => turn({ filesChanged: 0, verify: 'none' }))]
  expect(coverageOf(rows).unverifiedRate).toBe(1)
})

test('none and skipped both count as unchecked, fail does not', () => {
  const coverage = coverageOf([turn({ verify: 'pass' }), turn({ verify: 'fail' }), turn({ verify: 'none' }), turn({ verify: 'skipped' })])

  expect(coverage).toEqual({ turns: 4, verified: 1, failed: 1, unverified: 2, unverifiedRate: 0.5 })
})

test('a caught failure is the gate working, not a gap', () => {
  const coverage = coverageOf([turn({ verify: 'fail' }), turn({ verify: 'fail' })])
  expect(coverage.unverified).toBe(0)
  expect(coverage.unverifiedRate).toBe(0)
})

test('the recent window moves before the lifetime average does', () => {
  const old = Array.from({ length: 60 }, () => turn({ verify: 'none' }))
  const fixed = Array.from({ length: 30 }, () => turn({ verify: 'pass' }))
  const rows = [...old, ...fixed]

  expect(Math.round(coverageOf(rows).unverifiedRate * 100)).toBe(67)
  expect(recentCoverage(rows, 30).unverifiedRate).toBe(0)
})

test('the rendered report says which way the recent window moved', () => {
  const improving = renderCoverage({ turns: 90, verified: 30, failed: 0, unverified: 60, unverifiedRate: 2 / 3 }, { turns: 30, verified: 27, failed: 0, unverified: 3, unverifiedRate: 0.1 })
  expect(improving).toContain('57 points better')

  const regressing = renderCoverage({ turns: 90, verified: 80, failed: 0, unverified: 10, unverifiedRate: 0.1 }, { turns: 30, verified: 10, failed: 0, unverified: 20, unverifiedRate: 2 / 3 })
  expect(regressing).toContain('worse than lifetime')
})

test('an empty log says so rather than reporting a perfect score', () => {
  expect(coverageOf([]).turns).toBe(0)
  expect(renderCoverage(coverageOf([]), recentCoverage([]))).toContain('no turns changed files yet')
})
