import { expect, test } from 'bun:test'
import { budgetPolicy, mayStart, overran, spentInLastDay, tokensSpent, DEFAULT_DAILY_TOKENS } from './budget.ts'

const NOW = 1_000_000_000_000
const HOUR = 3_600_000
const record = (hoursAgo: number, costTokens?: number, raceTokens?: number) => ({
  at: NOW - hoursAgo * HOUR,
  ...(costTokens === undefined ? {} : { costTokens }),
  ...(raceTokens === undefined ? {} : { evidenceCost: { tasksRun: 1, tasksCarried: 0, tasksSkipped: 0, tasksTotal: 1, tokens: raceTokens, msToVerdict: 1 } }),
})

test('the policy has sensible defaults and reads its switches from the environment', () => {
  expect(budgetPolicy({})).toEqual({ enabled: true, dailyTokens: DEFAULT_DAILY_TOKENS, generationSweeps: 3.5 })
  expect(budgetPolicy({ ELIA_EVOLVE_DAILY_TOKENS: '5000000', ELIA_EVOLVE_GENERATION_SWEEPS: '2' })).toMatchObject({ dailyTokens: 5_000_000, generationSweeps: 2 })
  expect(budgetPolicy({ ELIA_EVOLVE_BUDGET: 'off' }).enabled).toBe(false)
  // Nonsense falls back rather than silently disabling the ceiling.
  expect(budgetPolicy({ ELIA_EVOLVE_DAILY_TOKENS: 'lots' }).dailyTokens).toBe(DEFAULT_DAILY_TOKENS)
  expect(budgetPolicy({ ELIA_EVOLVE_DAILY_TOKENS: '-1' }).dailyTokens).toBe(DEFAULT_DAILY_TOKENS)
})

test('what a generation cost is the recorded total, or for older records the race', () => {
  expect(tokensSpent(record(1, 9, 5))).toBe(9)
  expect(tokensSpent(record(1, undefined, 5))).toBe(5)
  expect(tokensSpent(record(1))).toBe(0)
})

test('only the last 24 hours count', () => {
  expect(spentInLastDay([record(1, 10), record(23, 5), record(25, 1000)], NOW)).toBe(15)
})

test('a generation that could not be afforded to the end is refused before it starts', () => {
  const policy = budgetPolicy({ ELIA_EVOLVE_DAILY_TOKENS: '100' })
  // A winner costs 3 sweeps: 30 of the 100.
  expect(mayStart(policy, [], 10, NOW)).toEqual({ ok: true })
  expect(mayStart(policy, [record(1, 60)], 10, NOW)).toEqual({ ok: true })
  const refused = mayStart(policy, [record(1, 80)], 10, NOW)
  expect(refused.ok).toBe(false)
  expect(!refused.ok && refused.reason).toContain('a winner that cannot be confirmed')
  const spent = mayStart(policy, [record(1, 100)], 10, NOW)
  expect(!spent.ok && spent.reason).toContain('daily budget is spent')
})

test('a generation that has overrun its own ceiling is stopped', () => {
  const policy = budgetPolicy({})
  expect(overran(policy, 34, 10)).toEqual({ ok: true })
  const over = overran(policy, 36, 10)
  expect(over.ok).toBe(false)
  expect(!over.ok && over.reason).toContain('3.5 sweeps')
})

test('off means off', () => {
  const policy = budgetPolicy({ ELIA_EVOLVE_BUDGET: 'off' })
  expect(mayStart(policy, [record(1, 1e12)], 1e9, NOW)).toEqual({ ok: true })
  expect(overran(policy, 1e12, 1)).toEqual({ ok: true })
})
