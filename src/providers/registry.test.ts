import { afterEach, expect, test } from 'bun:test'
import { isProviderPresetConfigured, providerPresetDefaultModel, tryResolveProvider } from './registry.ts'

const originalProvider = process.env.ELIA_PROVIDER
const originalModel = process.env.ELIA_MODEL
const originalBaseURL = process.env.ELIA_BASE_URL
const originalKey = process.env.OPENROUTER_API_KEY

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore('ELIA_PROVIDER', originalProvider)
  restore('ELIA_MODEL', originalModel)
  restore('ELIA_BASE_URL', originalBaseURL)
  restore('OPENROUTER_API_KEY', originalKey)
})

test('OpenRouter has a documented default model and reports configuration from its key variable', () => {
  expect(providerPresetDefaultModel('openrouter')).toBe('openrouter/auto')

  process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
  expect(isProviderPresetConfigured('openrouter')).toBe(true)
})

test('OpenRouter resolves through the OpenAI-compatible adapter', () => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key'

  const resolved = tryResolveProvider({ providerName: 'openrouter' })

  expect('error' in resolved).toBe(false)
  if ('error' in resolved) return
  expect(resolved.providerName).toBe('openrouter')
  expect(resolved.model).toBe('openrouter/auto')
})

test('OpenRouter accepts an explicit model override', () => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key'

  const resolved = tryResolveProvider({ providerName: 'openrouter', model: 'anthropic/claude-sonnet-4.5' })

  expect('error' in resolved).toBe(false)
  if ('error' in resolved) return
  expect(resolved.model).toBe('anthropic/claude-sonnet-4.5')
})
