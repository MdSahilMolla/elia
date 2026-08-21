import { afterEach, beforeEach, expect, test } from 'bun:test'
import { isProviderPresetConfigured, providerPresetDefaultModel, tryResolveProvider } from './registry.ts'

const originalProvider = process.env.ELIA_PROVIDER
const originalModel = process.env.ELIA_MODEL
const originalBaseURL = process.env.ELIA_BASE_URL
const originalKey = process.env.OPENROUTER_API_KEY
const originalMistralKey = process.env.MISTRAL_API_KEY

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  delete process.env.ELIA_PROVIDER
  delete process.env.ELIA_MODEL
  delete process.env.ELIA_BASE_URL
  delete process.env.OPENROUTER_API_KEY
  delete process.env.MISTRAL_API_KEY
})

afterEach(() => {
  restore('ELIA_PROVIDER', originalProvider)
  restore('ELIA_MODEL', originalModel)
  restore('ELIA_BASE_URL', originalBaseURL)
  restore('OPENROUTER_API_KEY', originalKey)
  restore('MISTRAL_API_KEY', originalMistralKey)
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

test('Mistral has a documented default model and reports configuration from its key variable', () => {
  expect(providerPresetDefaultModel('mistral')).toBe('mistral-large-latest')

  process.env.MISTRAL_API_KEY = 'test-mistral-key'
  expect(isProviderPresetConfigured('mistral')).toBe(true)
})

test('Mistral resolves through the OpenAI-compatible adapter', () => {
  process.env.MISTRAL_API_KEY = 'test-mistral-key'

  const resolved = tryResolveProvider({ providerName: 'mistral' })

  expect('error' in resolved).toBe(false)
  if ('error' in resolved) return
  expect(resolved.providerName).toBe('mistral')
  expect(resolved.model).toBe('mistral-large-latest')
})
