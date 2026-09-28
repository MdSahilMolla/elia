import { expect, test } from 'bun:test'
import { rankVariants, type VariantOutcome } from './variants.ts'
import { ZERO_USAGE } from '../usage.ts'
import type { Worktree } from './worktree.ts'

const worktree: Worktree = { path: '/tmp/does-not-matter', branch: 'x' }

function outcome(overrides: Partial<VariantOutcome>): VariantOutcome {
  return {
    index: 0,
    worktree,
    passed: true,
    usage: ZERO_USAGE,
    elapsedMs: 1000,
    verificationSummary: 'verification passed',
    failedCount: 0,
    ...overrides,
  }
}

// #1285: selection used to be pass/fail then cheapest-tokens-then-fastest —
// no signal at all for diff size, so a needlessly sprawling but cheap-to-
// generate change could beat a tighter, more surgical one.
test('among passing variants, the smaller diff wins even if it cost a few more tokens', () => {
  const sprawling = outcome({ index: 0, diffChurn: 400, usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  const surgical = outcome({ index: 1, diffChurn: 40, usage: { inputTokens: 120, outputTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  const ranked = rankVariants([sprawling, surgical])
  expect(ranked[0]!.index).toBe(1)
})

test('among passing variants with equal diff size, cheaper tokens win, then faster elapsed time', () => {
  const cheap = outcome({ index: 0, diffChurn: 50, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  const expensive = outcome({ index: 1, diffChurn: 50, usage: { inputTokens: 500, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  expect(rankVariants([expensive, cheap])[0]!.index).toBe(0)

  const slow = outcome({ index: 2, diffChurn: 50, usage: ZERO_USAGE, elapsedMs: 9000 })
  const fast = outcome({ index: 3, diffChurn: 50, usage: ZERO_USAGE, elapsedMs: 1000 })
  expect(rankVariants([slow, fast])[0]!.index).toBe(3)
})

test('a passing variant always outranks a failing one, regardless of cost or diff size', () => {
  const failedButCheap = outcome({ index: 0, passed: false, failedCount: 1, diffChurn: 5, usage: ZERO_USAGE, elapsedMs: 1 })
  const passedButExpensive = outcome({ index: 1, passed: true, diffChurn: 9999, usage: { inputTokens: 99999, outputTokens: 99999, cacheReadTokens: 0, cacheWriteTokens: 0 }, elapsedMs: 99999 })
  expect(rankVariants([failedButCheap, passedButExpensive])[0]!.index).toBe(1)
})

// The all-fail fallback used to always be outcomes[0] — an arbitrary choice
// with no relationship to which attempt was actually closest to working.
test('when every variant fails, the one with the fewest failed verification commands is chosen, not always the first', () => {
  const worst = outcome({ index: 0, passed: false, failedCount: 5 })
  const closest = outcome({ index: 1, passed: false, failedCount: 1 })
  const middle = outcome({ index: 2, passed: false, failedCount: 3 })
  expect(rankVariants([worst, closest, middle])[0]!.index).toBe(1)
})

test('when every variant fails with the same failedCount, diff size and cost still break the tie', () => {
  const bigDiff = outcome({ index: 0, passed: false, failedCount: 2, diffChurn: 500 })
  const smallDiff = outcome({ index: 1, passed: false, failedCount: 2, diffChurn: 20 })
  expect(rankVariants([bigDiff, smallDiff])[0]!.index).toBe(1)
})

test('a variant whose diff churn could not be measured ranks behind one that could, not ahead of it by default-zero', () => {
  const unmeasured = outcome({ index: 0, diffChurn: undefined })
  const measured = outcome({ index: 1, diffChurn: 100 })
  expect(rankVariants([unmeasured, measured])[0]!.index).toBe(1)
})
