import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  profileReport,
  profilingEnabled,
  recordModelCall,
  recordToolCall,
  renderProfileReport,
  renderToolProfile,
  resetProfilerForTests,
  toolProfileReport,
  type ModelCallSample,
  type ToolCallSample,
} from './profile.ts'

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

function toolSample(overrides: Partial<ToolCallSample> = {}): ToolCallSample {
  return { name: 'read_file', actor: 'top', wallMs: 5, bytesOut: 100, cached: false, isError: false, ...overrides }
}

test('recordToolCall is a no-op when ELIA_PROFILE is unset', () => {
  delete process.env.ELIA_PROFILE
  recordToolCall(toolSample())
  process.env.ELIA_PROFILE = '1'
  expect(toolProfileReport()).toHaveLength(0)
})

test('toolProfileReport aggregates per tool, busiest first, with cached/error counts and percentiles', () => {
  for (const wallMs of [2, 4, 6, 8, 100]) recordToolCall(toolSample({ name: 'read_file', wallMs }))
  recordToolCall(toolSample({ name: 'read_file', wallMs: 0, cached: true }))
  recordToolCall(toolSample({ name: 'grep', wallMs: 40, isError: true }))

  const rows = toolProfileReport()
  expect(rows.map((r) => r.name)).toEqual(['read_file', 'grep'])

  const read = rows[0]!
  expect(read.calls).toBe(6)
  expect(read.cachedCalls).toBe(1)
  expect(read.errorCalls).toBe(0)
  expect(read.totalWallMs).toBe(120)
  expect(read.p90WallMs).toBe(100)
  expect(read.p50WallMs).toBeLessThan(read.p90WallMs)

  expect(rows[1]!.errorCalls).toBe(1)
})

test('renderToolProfile shows a table and a speculative-cache share line', () => {
  expect(renderToolProfile()).toBe('')
  recordToolCall(toolSample({ name: 'read_file', cached: true }))
  recordToolCall(toolSample({ name: 'read_file', cached: false }))
  const text = renderToolProfile()
  expect(text).toContain('Tool profile')
  expect(text).toContain('read_file')
  expect(text).toContain('50% served from speculative cache')
})

test('renderProfileReport appends the tool table when both model and tool calls were recorded', () => {
  recordModelCall(sample())
  recordToolCall(toolSample({ name: 'grep' }))
  const text = renderProfileReport()
  expect(text).toContain('Turn profile')
  expect(text).toContain('Tool profile')
  expect(text).toContain('grep')
})
