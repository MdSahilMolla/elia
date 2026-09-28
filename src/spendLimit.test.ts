import { expect, test } from 'bun:test'
import { DEFAULT_SPEND_LIMIT_USD, applyDefaultSpendLimit, setSpendLimit, spendCeilingUsd, spendState, spendStopNotice, spendStopPrompt } from './spendLimit.ts'
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
  // The person is told how to go on, in the session they are in.
  expect(spendStopNotice(state)).toContain('/limit 5')
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

test('the priced part of the session is still enforced when another model has no price (#1245)', async () => {
  const { recordUsage, resetSessionUsageForTests } = await import('./usage.ts')
  resetSessionUsageForTests()
  try {
    recordUsage(EXPENSIVE, 'mercury-2.5')
    const state = spendState('some-model-with-no-pricing-entry', EXPENSIVE, { ELIA_MAX_SPEND_USD: '1' })
    expect(state.exceeded).toBe(true)
    expect(state.spentUsd).toBeGreaterThan(1)
  } finally {
    resetSessionUsageForTests()
  }
})

test('a session a person starts is bounded by default; measuring and training commands are not', () => {
  expect(DEFAULT_SPEND_LIMIT_USD).toBe(1)
  for (const command of [undefined, 'auto', 'autopilot', 'resume']) {
    const env: NodeJS.ProcessEnv = {}
    applyDefaultSpendLimit(command, env)
    expect(spendCeilingUsd(env)).toBe(1)
  }
  for (const command of ['bench', 'bench-latency', 'evolve', 'distill', 'compounding', 'jev', 'gap']) {
    const env: NodeJS.ProcessEnv = {}
    applyDefaultSpendLimit(command, env)
    expect(env.ELIA_MAX_SPEND_USD).toBeUndefined()
  }
  // What the person set always wins — including lifting it.
  const raised: NodeJS.ProcessEnv = { ELIA_MAX_SPEND_USD: '5' }
  applyDefaultSpendLimit(undefined, raised)
  expect(spendCeilingUsd(raised)).toBe(5)
  const lifted: NodeJS.ProcessEnv = { ELIA_MAX_SPEND_USD: '0' }
  applyDefaultSpendLimit(undefined, lifted)
  expect(spendCeilingUsd(lifted)).toBeUndefined()
})

test('/limit sets or lifts the limit mid-session, and refuses what is not an amount', () => {
  const env: NodeJS.ProcessEnv = { ELIA_MAX_SPEND_USD: '1' }
  expect(setSpendLimit('5', env)).toEqual({ ok: true, limitUsd: 5 })
  expect(spendCeilingUsd(env)).toBe(5)
  expect(setSpendLimit('$2.50', env)).toEqual({ ok: true, limitUsd: 2.5 })
  expect(setSpendLimit('off', env)).toEqual({ ok: true })
  expect(spendCeilingUsd(env)).toBeUndefined()
  for (const bad of ['lots', '-3', '1e9x', '']) {
    const result = setSpendLimit(bad, env)
    expect(result.ok).toBe(false)
  }
  expect(spendCeilingUsd(env)).toBeUndefined()
})
