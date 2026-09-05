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
  // And a tiny one still cannot push a model below the historical floor.
  expect(compactionThresholdFor('claude-sonnet-5', { ELIA_CONTEXT_WINDOW: '1000' })).toBe(30_000)
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
