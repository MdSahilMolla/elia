import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-repeats-test'

const { aggregateAttempts, benchRepeats, compareScorecards } = await import('./fitness.ts')
import type { TaskOutcome } from './fitness.ts'
import type { Metrics } from './ledger.ts'

const attempt = (passed: boolean, overrides: Partial<TaskOutcome> = {}): TaskOutcome => ({
  taskId: 't',
  weight: 1,
  passed,
  detail: passed ? 'ok' : 'tests still failing',
  steps: 10,
  elapsedMs: 1000,
  totalTokens: 100,
  ...overrides,
})

test('benchRepeats reads ELIA_BENCH_REPEATS, defaults to 1, and is capped', () => {
  expect(benchRepeats({})).toBe(1)
  expect(benchRepeats({ ELIA_BENCH_REPEATS: '3' })).toBe(3)
  expect(benchRepeats({ ELIA_BENCH_REPEATS: '0' })).toBe(1)
  expect(benchRepeats({ ELIA_BENCH_REPEATS: '99' })).toBe(10)
})

test('attempts fold into a pass rate; the task passes on a majority', () => {
  const two = aggregateAttempts([attempt(true), attempt(false, { keptDir: '/tmp/x' }), attempt(true)])
  expect(two).toMatchObject({ attempts: 3, passes: 2, passed: true, totalTokens: 300, keptDir: '/tmp/x' })
  expect(two.detail).toContain('2/3 attempts passed')
  const one = aggregateAttempts([attempt(true), attempt(false), attempt(false)])
  expect(one.passed).toBe(false)
  expect(one.unmeasured).toBeUndefined()
})

test('one unmeasured attempt makes the whole task unmeasured', () => {
  const folded = aggregateAttempts([attempt(true), attempt(false, { error: '429 rate limit', unmeasured: true }), attempt(true)])
  expect(folded.unmeasured).toBe(true)
  expect(folded.passed).toBe(false)
})

const metrics = (taskRates: Record<string, number>): Metrics => {
  const ids = Object.keys(taskRates)
  return {
    passRate: ids.reduce((sum, id) => sum + taskRates[id]!, 0) / ids.length,
    passed: ids.filter((id) => taskRates[id]! >= 0.5),
    failed: ids.filter((id) => taskRates[id]! < 0.5),
    taskRates,
    totalTokens: 1000,
    totalElapsedMs: 1000,
  }
}

test('one attempt in three flipping is noise, not a regression or a win', () => {
  const base = metrics({ a: 1, b: 2 / 3, c: 0 })
  expect(compareScorecards(base, metrics({ a: 2 / 3, b: 2 / 3, c: 0 })).reason).not.toContain('regressed')
  const nudged = compareScorecards(base, metrics({ a: 1, b: 1, c: 0 }))
  expect(nudged.better).toBe(false)
  expect(nudged.reason).toContain('noise')
})

test('losing or gaining at least half the attempts on a task is real', () => {
  const base = metrics({ a: 1, b: 2 / 3, c: 0 })
  const regressed = compareScorecards(base, metrics({ a: 1 / 3, b: 1, c: 1 }))
  expect(regressed.better).toBe(false)
  expect(regressed.reason).toContain('regressed on a')
  const won = compareScorecards(base, metrics({ a: 1, b: 2 / 3, c: 2 / 3 }))
  expect(won.better).toBe(true)
  expect(won.reason).toContain('now passes c')
})
