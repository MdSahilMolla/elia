import { expect, test } from 'bun:test'
import {
  addUsage,
  estimateCostUsd,
  formatCostUsd,
  formatElapsed,
  formatTokenCount,
  formatUsageLine,
  recordUsage,
  renderUsageBreakdown,
  sessionUsageByModel,
  setCurrentUsageModel,
  tokenMeter,
  totalTokens,
  ZERO_USAGE,
} from './usage.ts'

test('addUsage sums every field', () => {
  const a = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2 }
  const b = { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 1 }
  expect(addUsage(a, b)).toEqual({ inputTokens: 15, outputTokens: 23, cacheReadTokens: 1, cacheWriteTokens: 3 })
})

test('addUsage with ZERO_USAGE is a no-op', () => {
  const a = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2 }
  expect(addUsage(a, ZERO_USAGE)).toEqual(a)
})

test('totalTokens sums all four counters', () => {
  expect(totalTokens({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2 })).toBe(33)
})

test('estimateCostUsd returns undefined for an unknown model', () => {
  expect(estimateCostUsd('some-unlisted-model', ZERO_USAGE)).toBeUndefined()
})

test('estimateCostUsd computes input/output cost correctly for a known model', () => {
  // gpt-4.1: $2/M input, $8/M output
  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  expect(estimateCostUsd('gpt-4.1', usage)).toBeCloseTo(2 + 4, 6)
})

test('estimateCostUsd applies the discounted cache-read rate, not the base input rate', () => {
  // claude-sonnet-5: $2/M input, $0.20/M cache read — a cache-read-only turn should cost far less than treating it as regular input
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }
  expect(estimateCostUsd('claude-sonnet-5', usage)).toBeCloseTo(0.2, 6)
})

test('estimateCostUsd applies the premium cache-write rate for Anthropic', () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 }
  expect(estimateCostUsd('claude-sonnet-5', usage)).toBeCloseTo(2.5, 6)
})

test('formatCostUsd shows unknown cost distinctly from a real number', () => {
  expect(formatCostUsd(undefined)).toBe('cost unknown')
})

test('formatCostUsd uses extra precision for sub-cent amounts', () => {
  expect(formatCostUsd(0.0041)).toBe('$0.0041')
  expect(formatCostUsd(1.5)).toBe('$1.50')
})

test('formatTokenCount adds thousands separators', () => {
  expect(formatTokenCount(1234567)).toBe('1,234,567')
})

test('formatElapsed scales units sensibly', () => {
  expect(formatElapsed(500)).toBe('500ms')
  expect(formatElapsed(2500)).toBe('2.5s')
  expect(formatElapsed(125_000)).toBe('2m05s')
})

test('formatUsageLine combines time, tokens, and cost into one line', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  expect(formatUsageLine(usage, 2500, 'gpt-4.1')).toBe('2.5s · 1,000,000 tokens · $2.00')
})

test('tokenMeter fills proportionally and clamps out-of-range input', () => {
  expect(tokenMeter(0)).toBe('░░░░░░░░░░')
  expect(tokenMeter(50)).toBe('▓▓▓▓▓░░░░░')
  expect(tokenMeter(100)).toBe('▓▓▓▓▓▓▓▓▓▓')
  expect(tokenMeter(999)).toBe('▓▓▓▓▓▓▓▓▓▓')
})

test('recordUsage attributes tokens to the model that produced them', () => {
  const before = new Map(sessionUsageByModel().map((entry) => [entry.model, totalTokens(entry.usage)]))
  recordUsage({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'model-a')
  recordUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'model-b')
  recordUsage({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'model-a')

  const byModel = new Map(sessionUsageByModel().map((entry) => [entry.model, totalTokens(entry.usage)]))
  expect((byModel.get('model-a') ?? 0) - (before.get('model-a') ?? 0)).toBe(280)
  expect((byModel.get('model-b') ?? 0) - (before.get('model-b') ?? 0)).toBe(15)
})

test('recordUsage falls back to the model set by setCurrentUsageModel', () => {
  setCurrentUsageModel('fallback-model')
  recordUsage({ inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const entry = sessionUsageByModel().find((e) => e.model === 'fallback-model')
  expect(entry?.usage.inputTokens).toBeGreaterThanOrEqual(7)
})

test('sessionUsageByModel is ordered by total tokens, largest first', () => {
  const totals = sessionUsageByModel().map((entry) => totalTokens(entry.usage))
  expect(totals).toEqual([...totals].sort((a, b) => b - a))
})

test('renderUsageBreakdown shows the token table and a cost estimate for a known model', () => {
  const out = renderUsageBreakdown(
    { usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, turns: 2, elapsedMs: 4000 },
    'gpt-4.1',
  )
  expect(out).toContain('input         1,000,000')
  expect(out).toContain('total         1,000,000')
  expect(out).toContain('turns         2')
  expect(out).toContain('$2.00')
})
