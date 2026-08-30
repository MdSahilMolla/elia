import { afterEach, beforeEach, expect, test } from 'bun:test'
import { profileReport, profilingEnabled, recordModelCall, renderProfileReport, resetProfilerForTests, type ModelCallSample } from './profile.ts'

const original = process.env.ELIA_PROFILE

beforeEach(() => {
  process.env.ELIA_PROFILE = '1'
  resetProfilerForTests()
})

afterEach(() => {
  if (original === undefined) delete process.env.ELIA_PROFILE
  else process.env.ELIA_PROFILE = original
  resetProfilerForTests()
})

function sample(overrides: Partial<ModelCallSample> = {}): ModelCallSample {
  return {
    callIndex: 1,
    actor: 'top',
    wallMs: 2000,
    ttftMs: 800,
    inputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 12_000,
    outputTokens: 200,
    toolCalls: 1,
    systemChars: 8_000,
    dynamicSystemChars: 400,
    toolDefs: 30,
    messageCount: 3,
    ...overrides,
  }
}

test('recordModelCall is a no-op when ELIA_PROFILE is unset', () => {
  delete process.env.ELIA_PROFILE
  expect(profilingEnabled()).toBe(false)
  recordModelCall(sample())
  process.env.ELIA_PROFILE = '1'
  expect(profileReport().calls).toBe(0)
})

test('aggregate cache hit rate is read / (read + write + fresh input)', () => {
  recordModelCall(sample({ callIndex: 1, cacheReadTokens: 0, cacheWriteTokens: 10_000, inputTokens: 0 }))
  recordModelCall(sample({ callIndex: 2, cacheReadTokens: 10_000, cacheWriteTokens: 200, inputTokens: 300 }))

  const report = profileReport()
  expect(report.calls).toBe(2)
  expect(report.totalCacheRead).toBe(10_000)
  expect(report.totalCacheWrite).toBe(10_200)
  expect(report.totalInput).toBe(300)
  // 10000 / (10000 + 10200 + 300)
  expect(report.aggregateHitRate).toBeCloseTo(10_000 / 20_500, 5)
})

test('a follow-up call that rewrites the prefix instead of reading it is flagged as a prefix miss', () => {
  recordModelCall(sample({ callIndex: 1, cacheReadTokens: 0, cacheWriteTokens: 12_000 }))
  // call 2 should have read the ~8000-char system prefix back; instead it wrote fresh again
  recordModelCall(sample({ callIndex: 2, cacheReadTokens: 100, cacheWriteTokens: 12_000 }))
  expect(profileReport().prefixMisses).toBe(1)
})

test('a healthy follow-up call that reads the prefix back is not a prefix miss', () => {
  recordModelCall(sample({ callIndex: 1, cacheReadTokens: 0, cacheWriteTokens: 12_000 }))
  recordModelCall(sample({ callIndex: 2, cacheReadTokens: 12_000, cacheWriteTokens: 300 }))
  expect(profileReport().prefixMisses).toBe(0)
})

test('TTFT percentiles ignore tool-only calls that streamed nothing', () => {
  recordModelCall(sample({ callIndex: 1, ttftMs: 400 }))
  recordModelCall(sample({ callIndex: 2, ttftMs: undefined }))
  recordModelCall(sample({ callIndex: 3, ttftMs: 1200 }))
  const report = profileReport()
  expect(report.p50TtftMs).toBe(1200)
  expect(report.p90TtftMs).toBe(1200)
})

test('renderProfileReport returns empty string with no samples and a table once there are', () => {
  expect(renderProfileReport()).toBe('')
  recordModelCall(sample())
  const text = renderProfileReport()
  expect(text).toContain('Turn profile')
  expect(text).toContain('cache hit rate')
})
