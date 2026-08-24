import { afterEach, expect, test } from 'bun:test'

const { resolveThinking, describeThinking, config, getThinking, switchModel, switchThinking } = await import('./config.ts')

afterEach(() => {
  delete process.env.ELIA_THINKING
  delete process.env.ELIA_THINKING_BUDGET
})

// Snapshot once at import time — whatever this test run's real .env actually
// resolved — so every switch test can restore it afterward and never leak
// mutated state into other test files sharing this module instance.
const originalProviderName = config.providerName
const originalModel = config.model
const originalThinking = getThinking()

afterEach(() => {
  switchModel({ providerName: originalProviderName, model: originalModel })
  switchThinking(originalThinking)
})

test('resolveThinking defaults to enabled with the default budget', () => {
  expect(resolveThinking()).toEqual({ enabled: true, budgetTokens: 4096 })
})

test('ELIA_THINKING=off disables thinking', () => {
  process.env.ELIA_THINKING = 'off'
  expect(resolveThinking()).toEqual({ enabled: false, budgetTokens: 0 })
})

test('ELIA_THINKING_BUDGET overrides the default when valid', () => {
  process.env.ELIA_THINKING_BUDGET = '8000'
  expect(resolveThinking()).toEqual({ enabled: true, budgetTokens: 8000 })
})

test('an invalid or below-minimum ELIA_THINKING_BUDGET falls back to the default', () => {
  process.env.ELIA_THINKING_BUDGET = '100'
  expect(resolveThinking()).toEqual({ enabled: true, budgetTokens: 4096 })
})

test('describeThinking reports the capability honestly rather than staying silent', () => {
  // Reflects whatever provider this test run's .env actually resolved (not
  // re-evaluated per test — it is a startup-time snapshot by design), so this
  // only pins the shape of the message, not a specific provider branch.
  expect(describeThinking()).toContain('reasoning:')
})

test('switchModel re-resolving the current provider/model succeeds and updates config live', () => {
  const result = switchModel({ providerName: originalProviderName, model: originalModel })
  expect(result.ok).toBe(true)
  expect(config.providerName).toBe(originalProviderName)
  expect(config.model).toBe(originalModel)
})

test('built-in model switching ignores a stale custom endpoint', () => {
  if (originalProviderName === 'custom') return
  const previousBaseURL = process.env.ELIA_BASE_URL
  process.env.ELIA_BASE_URL = 'http://127.0.0.1:9/v1'
  try {
    const result = switchModel({ providerName: originalProviderName, model: originalModel })
    expect(result.ok).toBe(true)
    expect(config.providerName).toBe(originalProviderName)
    expect(config.model).toBe(originalModel)
  } finally {
    if (previousBaseURL === undefined) delete process.env.ELIA_BASE_URL
    else process.env.ELIA_BASE_URL = previousBaseURL
  }
})

test('switchModel to an unresolvable provider fails without mutating the live config', () => {
  const result = switchModel({ providerName: 'not-a-real-preset-xyz' })
  expect(result.ok).toBe(false)
  expect(config.providerName).toBe(originalProviderName)
  expect(config.model).toBe(originalModel)
})

test('switchModel auto enables fallback without changing the selected provider or model', () => {
  const providerName = config.providerName
  const model = config.model
  const result = switchModel({ providerName: 'auto' })

  expect(result.ok).toBe(true)
  expect(config.routingMode).toBe('auto')
  expect(config.providerName).toBe(providerName)
  expect(config.model).toBe(model)

  const restored = switchModel({ providerName, model })
  expect(restored.ok).toBe(true)
  expect(config.routingMode).toBe('selected')
})

test('switchThinking off is reflected in getThinking and describeThinking', () => {
  const result = switchThinking({ enabled: false, budgetTokens: 0 })
  expect(result.ok).toBe(true)
  expect(getThinking()).toEqual({ enabled: false, budgetTokens: 0 })
  expect(describeThinking()).toContain('off')
})

test('switchThinking on with an explicit budget is reflected in getThinking', () => {
  const result = switchThinking({ enabled: true, budgetTokens: 16000 })
  expect(result.ok).toBe(true)
  expect(getThinking()).toEqual({ enabled: true, budgetTokens: 16000 })
})
