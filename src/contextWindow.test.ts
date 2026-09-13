import { expect, test } from 'bun:test'
import { COMPACTION_TOKEN_THRESHOLD } from './compaction.ts'
import {
  MAX_COMPACTION_THRESHOLD,
  compactionThresholdFor,
  contextWindowFor,
  contextWindowOverride,
  normalizeModelId,
} from './contextWindow.ts'

test('an unrecognised model keeps exactly the budget elia shipped before', () => {
  // The whole point of the fallback: making the budget model-aware must not
  // shrink anyone's working memory.
  expect(compactionThresholdFor('some-model-nobody-has-heard-of')).toBe(30_000)
  expect(COMPACTION_TOKEN_THRESHOLD).toBe(30_000)
})

test('a large-window model gets a proportionally larger budget', () => {
  const claude = compactionThresholdFor('claude-sonnet-5')
  expect(claude).toBe(120_000)
  expect(claude).toBeGreaterThan(compactionThresholdFor('unknown-model'))
})

test('vendor-prefixed model ids resolve to the model, not the vendor', () => {
  // OpenRouter, Groq and NVIDIA all serve ids in this shape.
  expect(normalizeModelId('nvidia/llama-3.3-nemotron-super-49b-v1.5')).toBe('llama-3.3-nemotron-super-49b-v1.5')
  expect(contextWindowFor('openai/gpt-oss-120b')).toBe(128_000)
  expect(contextWindowFor('nvidia/llama-3.3-nemotron-super-49b-v1.5')).toBe(128_000)
})

test('an enormous window is still capped', () => {
  // Recall degrades across a very long context and every turn re-attends it.
  expect(contextWindowFor('gemini-3.7-flash')).toBe(1_000_000)
  expect(compactionThresholdFor('gemini-3.7-flash')).toBe(MAX_COMPACTION_THRESHOLD)
})

test('the operator override wins over the table, in both directions', () => {
  expect(compactionThresholdFor('claude-sonnet-5', { ELIA_CONTEXT_WINDOW: '400000' })).toBe(MAX_COMPACTION_THRESHOLD)
  // Dialling it down is the point of the escape hatch on a per-token provider.
  expect(compactionThresholdFor('claude-sonnet-5', { ELIA_CONTEXT_WINDOW: '100000' })).toBe(60_000)
})

test('a nonsense override is ignored rather than trusted', () => {
  for (const value of ['0', '-5', 'lots', '']) {
    expect(contextWindowOverride({ ELIA_CONTEXT_WINDOW: value })).toBeUndefined()
  }
})

// The 30,000 floor used to apply to an explicit override too, which made the
// downward half of this escape hatch unusable: the smallest budget an operator
// could actually ask for was 30,000. A provider tier capped at 8,000 tokens
// per minute is therefore inexpressible, and a live run (2026-09-13-l0av-rnq0)
// built 42,000-token requests against exactly such a cap and lost two steps to
// repeated 413s. The floor protects a window elia *inferred*; it has no
// business overriding one the operator stated.
test('an explicit override below the inferred floor is honoured', () => {
  expect(compactionThresholdFor('openai/gpt-oss-120b', { ELIA_CONTEXT_WINDOW: '8000' })).toBe(4_800)
  expect(compactionThresholdFor('claude-sonnet-5', { ELIA_CONTEXT_WINDOW: '12000' })).toBe(7_200)
})

// Never hand back more room than the operator said exists — that would
// recreate the overflow the override is set to prevent.
test('an override never yields a budget larger than itself', () => {
  for (const window of ['1000', '2000', '3000', '8000']) {
    const value = Number.parseInt(window, 10)
    expect(compactionThresholdFor('claude-sonnet-5', { ELIA_CONTEXT_WINDOW: window })).toBeLessThanOrEqual(value)
  }
})

// An unrecognised model still keeps the historical budget: the floor exists
// for windows elia guessed at, and that is unchanged.
test('an inferred window still cannot fall below the historical floor', () => {
  expect(compactionThresholdFor('some-model-nobody-has-heard-of', {})).toBe(30_000)
})

test('every known window is at least the default, so no match ever loses room', () => {
  const models = [
    'claude-opus-5',
    'gpt-4.1',
    'gpt-5.6-terra',
    'o3',
    'gpt-4o',
    'gemini-3.7-flash',
    'mistral-large-latest',
    'deepseek-chat',
    'qwen-2.5-coder',
  ]
  for (const model of models) {
    expect(compactionThresholdFor(model)).toBeGreaterThanOrEqual(30_000)
    expect(compactionThresholdFor(model)).toBeLessThanOrEqual(MAX_COMPACTION_THRESHOLD)
  }
})

// Regression: `mercury-2` / `mercury-2.5` matched no pattern, so both fell back
// to DEFAULT_CONTEXT_WINDOW (50k) and compacted at 30k - against real windows of
// 128k and 260k. Long builds were summarized away a quarter of the way in.
test('Mercury models get their real windows, not the unknown-model default', () => {
  expect(contextWindowFor('mercury-2')).toBe(128_000)
  expect(contextWindowFor('mercury-2.5')).toBe(260_000)
  // Order matters: /^mercury/ must not claim 2.5 first.
  expect(contextWindowFor('mercury-2.5')).not.toBe(128_000)
  // Vendor-prefixed ids (OpenRouter serves inception/mercury-2.5) normalize too.
  expect(contextWindowFor('inception/mercury-2.5')).toBe(260_000)
  expect(contextWindowFor('mercury-99-unreleased')).toBe(128_000)
})
