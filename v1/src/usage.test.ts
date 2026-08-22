import { expect, test } from 'bun:test'
import {
  addUsage,
  estimateCostUsd,
  formatCostUsd,
  formatElapsed,
  formatTokenCount,
  formatUsageLine,
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
