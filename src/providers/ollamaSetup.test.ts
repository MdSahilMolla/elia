import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearDeclaredContextWindows, compactionThresholdFor, contextWindowFor, declareContextWindow, DECLARED_WINDOW_RESERVE, MIN_COMPACTION_THRESHOLD } from '../contextWindow.ts'
import { activeProviderNeedsSetup, savedProviderNames, saveProviderConfiguration } from '../providerSettings.ts'
import { ollamaStartupAction } from '../cli/providerSetup.ts'
import { resetOllamaDetection } from './ollama.ts'
import { isProviderPresetConfigured, listProviderModels, providerReadiness, PROVIDER_PRESET_NAMES, tryResolveProvider } from './registry.ts'

/** Ollama as a provider: resolving it, saving it, readiness, the startup decision and the window it declares. */

const ENV_KEYS = ['ELIA_PROVIDER', 'ELIA_MODEL', 'ELIA_BASE_URL', 'ELIA_API_KEY', 'OLLAMA_HOST', 'OLLAMA_API_KEY'] as const
let saved: Record<string, string | undefined>
let dir: string
let server: ReturnType<typeof Bun.serve> | undefined

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  dir = mkdtempSync(join(tmpdir(), 'elia-ollama-setup-'))
  resetOllamaDetection()
  clearDeclaredContextWindows()
})

afterEach(() => {
  server?.stop(true)
  server = undefined
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(dir, { recursive: true, force: true })
  resetOllamaDetection()
  clearDeclaredContextWindows()
})

test('ollama is a provider that needs a model and no key', () => {
  expect(PROVIDER_PRESET_NAMES).toContain('ollama')
  const resolved = tryResolveProvider({ providerName: 'ollama', model: 'qwen3:8b' })
  expect('error' in resolved).toBe(false)
  if (!('error' in resolved)) expect(resolved.model).toBe('qwen3:8b')

  const noModel = tryResolveProvider({ providerName: 'ollama', ignoreAmbient: true })
  expect('error' in noModel && noModel.error).toContain('/model ollama')

  // A remote server over plain HTTP is refused, with the reason.
  process.env.OLLAMA_HOST = 'http://gpu-box.example.com:11434'
  const remote = tryResolveProvider({ providerName: 'ollama', model: 'qwen3:8b' })
  expect('error' in remote && remote.error).toContain('HTTPS')
})

test('ollama is never pulled into auto fallback: it has no model to fall back to', () => {
  // resolveAutoFallbacks resolves each preset with its default model and no ambient env.
  expect('error' in tryResolveProvider({ providerName: 'ollama', model: undefined, ignoreAmbient: true })).toBe(true)
})

test('saving ollama writes the provider and model, and no key', () => {
  const path = join(dir, 'config.env')
  const result = saveProviderConfiguration({ provider: 'ollama', apiKey: '', model: 'qwen3:8b', filePath: path })
  expect(result.model).toBe('qwen3:8b')
  const written = readFileSync(path, 'utf8')
  expect(written).toContain('ELIA_PROVIDER=ollama')
  expect(written).toContain('ELIA_MODEL=qwen3:8b')
  expect(written).not.toContain('OLLAMA_API_KEY')
  expect(savedProviderNames(path)).toContain('ollama')
  expect(activeProviderNeedsSetup({ ELIA_PROVIDER: 'ollama', ELIA_MODEL: 'qwen3:8b' })).toBe(false)
  expect(activeProviderNeedsSetup({ ELIA_PROVIDER: 'ollama' })).toBe(true)

  // A host is Ollama's own OLLAMA_HOST, checked like any endpoint.
  saveProviderConfiguration({ provider: 'ollama', apiKey: '', model: 'qwen3:8b', baseURL: 'http://127.0.0.1:11500', filePath: path })
  expect(readFileSync(path, 'utf8')).toContain('OLLAMA_HOST=http://127.0.0.1:11500')
  expect(() => saveProviderConfiguration({ provider: 'ollama', apiKey: '', model: 'qwen3:8b', baseURL: 'http://gpu-box.example.com', filePath: path })).toThrow()
  // Any other provider still needs its key.
  expect(() => saveProviderConfiguration({ provider: 'groq', apiKey: '', filePath: path })).toThrow('API key')
})

test('readiness for ollama is whether a server answered with models, not whether a key is set', async () => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3:8b' }, { name: 'gemma3:4b' }] })
      if (path === '/api/show') {
        const body = (await request.json()) as { model: string }
        return Response.json({ capabilities: body.model === 'qwen3:8b' ? ['completion', 'tools'] : ['completion'], model_info: { 'x.context_length': 40_960 } })
      }
      return new Response('', { status: 404 })
    },
  })
  process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`
  expect(providerReadiness('ollama')).toBe('local models')

  const discovery = await listProviderModels('ollama')
  // The model elia can use leads; the one it cannot is marked, with the reason kept for the switch.
  expect(discovery.models.map((model) => model.id)).toEqual(['qwen3:8b', 'gemma3:4b'])
  expect(discovery.models[0]!.detail).toContain('tools')
  expect(discovery.models[1]!.warning).toContain('cannot call tools')
  expect(isProviderPresetConfigured('ollama')).toBe(true)
  expect(providerReadiness('ollama')).toBe('running · 2 local models · no key needed')
  expect(providerReadiness('groq')).toMatch(/ready|no key set/)
})

test('startup: warn when ollama is chosen but down, ask when its model is gone, offer it once otherwise', () => {
  const up = { running: true, models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:latest' }] }
  const down = { running: false, models: [], error: 'Ollama is not running at http://127.0.0.1:11434' }

  expect(ollamaStartupAction({ provider: 'ollama', model: 'qwen3:8b', detection: down, offered: false })).toEqual({ kind: 'not-running', message: down.error })
  expect(ollamaStartupAction({ provider: 'ollama', model: 'qwen3:8b', detection: up, offered: false })).toEqual({ kind: 'none' })
  // `ollama pull llama3.2` lists as llama3.2:latest; both spellings are the same model.
  expect(ollamaStartupAction({ provider: 'ollama', model: 'llama3.2', detection: up, offered: false }).kind).toBe('none')
  expect(ollamaStartupAction({ provider: 'ollama', model: 'mistral:7b', detection: up, offered: false }).kind).toBe('choose')
  expect(ollamaStartupAction({ provider: 'ollama', detection: up, offered: false }).kind).toBe('choose')

  expect(ollamaStartupAction({ provider: 'anthropic', model: 'claude-sonnet-5', detection: up, offered: false })).toEqual({ kind: 'offer' })
  expect(ollamaStartupAction({ provider: 'anthropic', detection: up, offered: true })).toEqual({ kind: 'none' })
  expect(ollamaStartupAction({ provider: 'anthropic', detection: down, offered: false })).toEqual({ kind: 'none' })
  expect(ollamaStartupAction({ provider: 'anthropic', detection: { running: true, models: [] }, offered: false })).toEqual({ kind: 'none' })
})

test('a declared window beats the table, and compaction leaves room for the fixed prompt', () => {
  // The table credits any qwen with 128k; run at 32k, it has 32k.
  expect(contextWindowFor('qwen3:8b')).toBe(128_000)
  declareContextWindow('qwen3:8b', 32_768)
  expect(contextWindowFor('qwen3:8b')).toBe(32_768)
  // 60% of 32k would leave the ~17k prompt no room; the reserve does.
  expect(compactionThresholdFor('qwen3:8b', {})).toBe(32_768 - DECLARED_WINDOW_RESERVE)
  // A large declared window still uses the usable fraction.
  declareContextWindow('big:latest', 131_072)
  expect(compactionThresholdFor('big:latest', {})).toBe(Math.floor(131_072 * 0.6))
  // Too small to hold anything still yields a budget rather than a loop.
  declareContextWindow('tiny:latest', 4_096)
  expect(compactionThresholdFor('tiny:latest', {})).toBe(MIN_COMPACTION_THRESHOLD)
  // An explicit ELIA_CONTEXT_WINDOW still wins over everything.
  expect(compactionThresholdFor('qwen3:8b', { ELIA_CONTEXT_WINDOW: '100000' })).toBe(60_000)
})
