import { afterEach, beforeEach, expect, test } from 'bun:test'
import { isProviderPresetConfigured, listProviderModels, providerPresetDefaultModel, tryResolveProvider } from './registry.ts'

const originalProvider = process.env.ELIA_PROVIDER
const originalModel = process.env.ELIA_MODEL
const originalBaseURL = process.env.ELIA_BASE_URL
const originalGoogleKey = process.env.GEMINI_API_KEY
const originalNvidiaKey = process.env.NVIDIA_API_KEY
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY
const originalMistralKey = process.env.MISTRAL_API_KEY

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  delete process.env.ELIA_PROVIDER
  delete process.env.ELIA_MODEL
  delete process.env.ELIA_BASE_URL
  delete process.env.GEMINI_API_KEY
  delete process.env.NVIDIA_API_KEY
  delete process.env.OPENROUTER_API_KEY
  delete process.env.MISTRAL_API_KEY
})

afterEach(() => {
  restore('ELIA_PROVIDER', originalProvider)
  restore('ELIA_MODEL', originalModel)
  restore('ELIA_BASE_URL', originalBaseURL)
  restore('GEMINI_API_KEY', originalGoogleKey)
  restore('NVIDIA_API_KEY', originalNvidiaKey)
  restore('OPENROUTER_API_KEY', originalOpenRouterKey)
  restore('MISTRAL_API_KEY', originalMistralKey)
})

test('Google Gemini has a documented default model and reports configuration from its key variable', () => {
  expect(providerPresetDefaultModel('google')).toBe('gemini-3.7-flash')

  process.env.GEMINI_API_KEY = 'test-gemini-key'
  expect(isProviderPresetConfigured('google')).toBe(true)
})

test('Google Gemini resolves through the OpenAI-compatible adapter', () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key'

  const resolved = tryResolveProvider({ providerName: 'google' })

  expect('error' in resolved).toBe(false)
  if ('error' in resolved) return
  expect(resolved.providerName).toBe('google')
  expect(resolved.model).toBe('gemini-3.7-flash')
})

test('NVIDIA NIM has a documented default model and reports configuration from its key variable', () => {
  expect(providerPresetDefaultModel('nvidia')).toBe('nvidia/llama-3.3-nemotron-super-49b-v1.5')

  process.env.NVIDIA_API_KEY = 'test-nvidia-key'
  expect(isProviderPresetConfigured('nvidia')).toBe(true)
})

test('NVIDIA NIM resolves through the OpenAI-compatible adapter', () => {
  process.env.NVIDIA_API_KEY = 'test-nvidia-key'

  const resolved = tryResolveProvider({ providerName: 'nvidia' })

  expect('error' in resolved).toBe(false)
  if ('error' in resolved) return
  expect(resolved.providerName).toBe('nvidia')
  expect(resolved.model).toBe('nvidia/llama-3.3-nemotron-super-49b-v1.5')
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

test('model discovery lists and sorts provider models without changing chat configuration', async () => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
  const originalFetch = globalThis.fetch
  let requestedURL = ''
  let authorization = ''
  globalThis.fetch = (async (input, init) => {
    requestedURL = String(input)
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return new Response(JSON.stringify({ data: [{ id: 'zeta-model' }, { id: 'alpha-model', name: 'Alpha' }, { id: 42 }] }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await listProviderModels('openrouter')
    expect(requestedURL).toBe('https://openrouter.ai/api/v1/models')
    expect(authorization).toBe('Bearer test-openrouter-key')
    expect(result.models.map((model) => model.id)).toEqual(['alpha-model', 'zeta-model'])
    expect(result.models[0]?.name).toBe('Alpha')
    expect(result.error).toBeUndefined()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('model discovery reports an actionable result when a provider has no key', async () => {
  const result = await listProviderModels('mistral')
  expect(result.models).toEqual([])
  expect(result.error).toContain('No API key set')
})
