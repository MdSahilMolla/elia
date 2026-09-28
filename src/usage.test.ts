import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addUsage,
  clearCustomPricingCache,
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

test('estimateCostUsd reads .elia/pricing.json for a model not in the built-in table, and lets it override a built-in rate too', () => {
  clearCustomPricingCache()
  const cwd = mkdtempSync(join(tmpdir(), 'elia-pricing-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(
    join(cwd, '.elia', 'pricing.json'),
    JSON.stringify({
      'my-custom-model': { inputPerM: 1, outputPerM: 3 },
      'gpt-4.1': { inputPerM: 100, outputPerM: 100 }, // deliberately absurd, to prove it overrides the built-in rate
    }),
  )
  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  expect(estimateCostUsd('my-custom-model', usage, cwd)).toBeCloseTo(1 + 1.5, 6)
  expect(estimateCostUsd('gpt-4.1', usage, cwd)).toBeCloseTo(100 + 50, 6)
  // A completely different cwd with no pricing.json still falls back to "unknown"/built-in normally.
  clearCustomPricingCache()
  expect(estimateCostUsd('my-custom-model', usage, mkdtempSync(join(tmpdir(), 'elia-pricing-empty-')))).toBeUndefined()
})

test('a malformed .elia/pricing.json is ignored, not thrown', () => {
  clearCustomPricingCache()
  const cwd = mkdtempSync(join(tmpdir(), 'elia-pricing-bad-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(join(cwd, '.elia', 'pricing.json'), 'not json at all')
  expect(() => estimateCostUsd('gpt-4.1', ZERO_USAGE, cwd)).not.toThrow()
  expect(estimateCostUsd('gpt-4.1', ZERO_USAGE, cwd)).toBe(0)
  clearCustomPricingCache()
})

test('estimateCostUsd treats a NaN or negative token count as 0 instead of propagating it', () => {
  const nanUsage = { inputTokens: Number.NaN, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  expect(estimateCostUsd('gpt-4.1', nanUsage)).toBeCloseTo(4, 6) // just the output half; NaN input contributes 0, not NaN

  const negativeUsage = { inputTokens: -1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const result = estimateCostUsd('gpt-4.1', negativeUsage)
  expect(result).toBe(0) // never a negative cost
  expect(result).not.toBeLessThan(0)

  const infiniteUsage = { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  expect(estimateCostUsd('gpt-4.1', infiniteUsage)).toBe(0)
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

// --- Every Claude model elia routes to can be priced -------------------------

const MTOK = 1_000_000
/** A per-MTok figure for one token class, so each assertion names the rate it checks. */
const usageOf = (fields: Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheWrite1hTokens', number>>) =>
  ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...fields })

test('every Claude model elia routes to has a price, so a spend ceiling can be enforced on it', () => {
  // Opus, Fable and Haiku used to be missing, and ELIA_MAX_SPEND_USD reported
  // itself unenforceable on them — Opus, the costliest tier, ran with no limit.
  for (const model of ['claude-fable-5-1', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    expect(estimateCostUsd(model, usageOf({ inputTokens: MTOK }))).toBeGreaterThan(0)
  }
})

test('input and output are priced at the published per-MTok rates', () => {
  expect(estimateCostUsd('claude-opus-5', usageOf({ inputTokens: MTOK, outputTokens: MTOK }))).toBeCloseTo(5 + 25)
  expect(estimateCostUsd('claude-fable-5-1', usageOf({ inputTokens: MTOK, outputTokens: MTOK }))).toBeCloseTo(10 + 50)
  expect(estimateCostUsd('claude-haiku-4-5', usageOf({ inputTokens: MTOK, outputTokens: MTOK }))).toBeCloseTo(1 + 5)
})

test('Fable 5.1 cache reads are 0.025x input, not the usual 0.1x', () => {
  expect(estimateCostUsd('claude-fable-5-1', usageOf({ cacheReadTokens: MTOK }))).toBeCloseTo(0.25)
  expect(estimateCostUsd('claude-opus-5', usageOf({ cacheReadTokens: MTOK }))).toBeCloseTo(0.5)
})

test('1-hour cache writes cost 2x input and 5-minute ones 1.25x, and a mix is priced by its parts', () => {
  // The Anthropic provider writes both: the stable system prompt and tools at 1
  // hour, the per-turn prompt and history at 5 minutes. Pricing all of it at the
  // 5-minute rate undercounted the 1-hour share by 37.5%.
  expect(estimateCostUsd('claude-opus-5', usageOf({ cacheWriteTokens: MTOK }))).toBeCloseTo(6.25)
  expect(estimateCostUsd('claude-opus-5', usageOf({ cacheWriteTokens: MTOK, cacheWrite1hTokens: MTOK }))).toBeCloseTo(10)
  // 600k at 5 minutes + 400k at 1 hour.
  expect(estimateCostUsd('claude-opus-5', usageOf({ cacheWriteTokens: MTOK, cacheWrite1hTokens: 400_000 }))).toBeCloseTo(0.6 * 6.25 + 0.4 * 10)
})

test('a 1-hour share larger than the writes it belongs to is not billed twice', () => {
  expect(estimateCostUsd('claude-opus-5', usageOf({ cacheWriteTokens: 100_000, cacheWrite1hTokens: 5 * MTOK }))).toBeCloseTo(0.1 * 10)
})

test('a model with no 1-hour rate prices its 1-hour writes at its ordinary write rate', () => {
  expect(estimateCostUsd('mercury-2.5', usageOf({ cacheWriteTokens: MTOK, cacheWrite1hTokens: MTOK })))
    .toBeCloseTo(estimateCostUsd('mercury-2.5', usageOf({ cacheWriteTokens: MTOK }))!)
})

test('addUsage carries the 1-hour share, and leaves usages that never had one unchanged in shape', () => {
  expect(addUsage(usageOf({ cacheWriteTokens: 10, cacheWrite1hTokens: 4 }), usageOf({ cacheWriteTokens: 6, cacheWrite1hTokens: 1 })))
    .toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 16, cacheWrite1hTokens: 5 })
  expect(addUsage(ZERO_USAGE, ZERO_USAGE)).toEqual(ZERO_USAGE)
})

test('a session that touched several models is priced per model, not at one rate (#1245)', async () => {
  const { sessionCost, formatSessionCost, recordUsage, estimateCostUsd, resetSessionUsageForTests } = await import('./usage.ts')
  resetSessionUsageForTests()
  const before = sessionCost()
  const deep = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const fast = { inputTokens: 4_000_000, outputTokens: 400_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  recordUsage(deep, 'claude-opus-5')
  recordUsage(fast, 'mercury-2.5')
  const after = sessionCost()
  const expected = estimateCostUsd('claude-opus-5', deep)! + estimateCostUsd('mercury-2.5', fast)!
  expect(after.usd - before.usd).toBeCloseTo(expected, 6)
  // An unpriced model is named, and the display says the figure is a floor.
  recordUsage({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'unpriced-model-x')
  expect(sessionCost().unpriced).toContain('unpriced-model-x')
  expect(formatSessionCost()).toContain('unpriced-model-x unpriced')
  resetSessionUsageForTests()
})

test('spend still inside a running loop shows in the live cost, and never twice', async () => {
  const { recordUsage, resetSessionUsageForTests, sessionCost, sessionCostLive, trackInflightUsage } = await import('./usage.ts')
  resetSessionUsageForTests()
  try {
    const call = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const loop = trackInflightUsage()
    loop.update('mercury-2.5', call)
    // Not recorded yet, but the display already counts it.
    expect(sessionCost().usd).toBe(0)
    expect(sessionCostLive().usd).toBeCloseTo(0.2, 6)
    // The loop finishes and clears its slot; its caller records the total.
    loop.done()
    recordUsage(call, 'mercury-2.5')
    expect(sessionCostLive().usd).toBeCloseTo(0.2, 6)
  } finally {
    resetSessionUsageForTests()
  }
})
