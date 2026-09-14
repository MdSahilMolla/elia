import { expect, test } from 'bun:test'
import { spendCeilingUsd, spendState, spendStopNotice, spendStopPrompt } from './spendLimit.ts'
import type { Usage } from './providers/types.ts'

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
/** Enough tokens on a priced model to be worth real money, so the ceiling has something to bite on. */
const EXPENSIVE: Usage = { inputTokens: 20_000_000, outputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
const PRICED_MODEL = 'mercury-2.5'

test('no ceiling is configured by default, and nothing is ever exceeded', () => {
  expect(spendCeilingUsd({})).toBeUndefined()
  expect(spendState(PRICED_MODEL, EXPENSIVE, {}).exceeded).toBe(false)
})

test('a ceiling is only honoured when it parses to a positive number', () => {
  expect(spendCeilingUsd({ ELIA_MAX_SPEND_USD: '5' })).toBe(5)
  expect(spendCeilingUsd({ ELIA_MAX_SPEND_USD: '2.50' })).toBe(2.5)
  // Garbage must not fail a run, and must not silently become a ceiling of 0 —
  // which would stop every session on its first step.
  for (const bad of ['', '  ', 'lots', '-1', '0', 'NaN']) {
    expect(spendCeilingUsd({ ELIA_MAX_SPEND_USD: bad })).toBeUndefined()
  }
})

test('spend under the ceiling keeps running', () => {
  const state = spendState(PRICED_MODEL, NO_USAGE, { ELIA_MAX_SPEND_USD: '100' })
  expect(state.exceeded).toBe(false)
  expect(state.limitUsd).toBe(100)
})

test('spend at or past the ceiling is exceeded', () => {
  const state = spendState(PRICED_MODEL, EXPENSIVE, { ELIA_MAX_SPEND_USD: '1' })
  expect(state.spentUsd).toBeGreaterThan(1)
  expect(state.exceeded).toBe(true)
})

test('a ceiling on an unpriced model is reported as unenforceable rather than silently ignored', () => {
  // The dangerous failure: the operator sets a limit, the model has no pricing
  // entry, and the run proceeds unbounded while they believe they are covered.
  const state = spendState('some-model-with-no-pricing-entry', EXPENSIVE, { ELIA_MAX_SPEND_USD: '1' })
  expect(state.exceeded).toBe(false)
  expect(state.unenforceable).toContain('not being enforced')
  expect(state.unenforceable).toContain('some-model-with-no-pricing-entry')
})

test('the stop prompt and notice both name the spend and the limit', () => {
  const state = spendState(PRICED_MODEL, EXPENSIVE, { ELIA_MAX_SPEND_USD: '1' })
  expect(spendStopPrompt(state)).toContain('Stop calling tools')
  expect(spendStopNotice(state)).toContain('ELIA_MAX_SPEND_USD')
})

test('the ceiling is enforceable on every Claude model elia routes to, Opus included', () => {
  // Opus was missing from the price table, so a ceiling on it reported itself
  // unenforceable and the costliest tier ran with no limit at all.
  for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5']) {
    const state = spendState(model, EXPENSIVE, { ELIA_MAX_SPEND_USD: '1' })
    expect(state.unenforceable).toBeUndefined()
    expect(state.exceeded).toBe(true)
  }
})
