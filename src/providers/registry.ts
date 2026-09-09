import { createAnthropicProvider } from './anthropic.ts'
import { codexSubscriptionConfigured, createCodexSubscriptionProvider, listCodexSubscriptionModels } from './codexSubscription.ts'
import { createOpenAICompatibleProvider } from './openaiCompatible.ts'
import { assertProviderEndpoint, assertPublicNetworkUrl, validateNetworkUrl } from '../networkPolicy.ts'
import type { Provider, ThinkingOption } from './types.ts'

interface ProviderPreset {
  kind: 'anthropic' | 'openai-compatible' | 'codex-subscription'
  apiKeyEnv?: string
  baseURL?: string
  defaultModel?: string
}

const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    kind: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5',
  },
  groq: {
    kind: 'openai-compatible',
    apiKeyEnv: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
  },
  openai: {
    kind: 'openai-compatible',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1',
  },
  codex: {
    kind: 'codex-subscription',
    defaultModel: 'default',
  },
  openrouter: {
    kind: 'openai-compatible',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
  },
  mistral: {
    kind: 'openai-compatible',
    apiKeyEnv: 'MISTRAL_API_KEY',
    baseURL: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
  },
  google: {
    kind: 'openai-compatible',
    apiKeyEnv: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-3.7-flash',
  },
  nvidia: {
    kind: 'openai-compatible',
    apiKeyEnv: 'NVIDIA_API_KEY',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  },
  mercury: {
    kind: 'openai-compatible',
    apiKeyEnv: 'INCEPTION_API_KEY',
    baseURL: 'https://api.inceptionlabs.ai/v1',
    defaultModel: 'mercury-2.5',
  },
  custom: {
    kind: 'openai-compatible',
    apiKeyEnv: 'ELIA_API_KEY',
  },
}

export interface ResolvedProvider {
  provider: Provider
  providerName: string
  model: string
}

/** Preset provider names elia knows about out of the box — `custom` covers anything else via `ELIA_BASE_URL`. */
export const PROVIDER_PRESET_NAMES = Object.keys(PROVIDER_PRESETS)

/**
 * The generic `ELIA_API_KEY` belongs to the `custom` preset only. It used to be
 * a universal fallback for every preset, which made a lone `ELIA_API_KEY` report
 * every built-in provider as "ready" and then fail confusingly at request time.
 */
function presetApiKey(providerName: string, preset: ProviderPreset): string | undefined {
  if (!preset.apiKeyEnv) return undefined
  return process.env[preset.apiKeyEnv] ?? (providerName === 'custom' ? process.env.ELIA_API_KEY : undefined)
}

/** Normalises a caller-supplied provider name (case, surrounding whitespace) before lookup. */
export function normalizeProviderName(providerName: string): string {
  return providerName.trim().toLowerCase()
}

/** The known preset name closest to `providerName`, for a "did you mean" hint. Undefined when nothing is close. */
export function closestProviderName(providerName: string): string | undefined {
  const target = normalizeProviderName(providerName)
  let best: { name: string; distance: number } | undefined
  for (const name of PROVIDER_PRESET_NAMES) {
    const distance = levenshtein(target, name)
    if (best === undefined || distance < best.distance) best = { name, distance }
  }
  return best && best.distance <= Math.max(2, Math.floor(best.name.length / 3)) ? best.name : undefined
}

/** A consistent "that provider name is not one we know" message, with a did-you-mean and the custom-provider escape hatch. */
export function unknownProviderError(providerName: string): string {
  const suggestion = closestProviderName(providerName)
  return (
    `Unknown provider "${providerName.trim()}".` +
    (suggestion ? ` Did you mean "${suggestion}"?` : '') +
    ` Known providers: ${PROVIDER_PRESET_NAMES.join(', ')}. ` +
    `For any other OpenAI-compatible endpoint set ELIA_PROVIDER=custom with ELIA_BASE_URL.`
  )
}

function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
    }
  }
  return rows[a.length]![b.length]!
}

/**
 * Rejects a model id that cannot be a real model before it is baked into a
 * request and fails late and confusingly at the provider. Returns an error
 * string, or `undefined` when the id is acceptable.
 */
export function validateModelId(model: string): string | undefined {
  const trimmed = model.trim()
  if (!trimmed) return 'model id cannot be empty'
  if (trimmed.length > 256) return `model id is too long (${trimmed.length} characters; the maximum is 256)`
  if (/\s/.test(model) || [...model].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return 'model id cannot contain whitespace or control characters'
  if (/^(null|undefined|nan)$/i.test(trimmed)) return `"${trimmed}" is not a model id`
  return undefined
}

/** Whether a preset's API key is actually set, so a "switch model" listing can show what's usable right now versus just known by name. */
export function isProviderPresetConfigured(providerName: string): boolean {
  const preset = PROVIDER_PRESETS[normalizeProviderName(providerName)]
  if (!preset) return false
  if (preset.kind === 'codex-subscription') return codexSubscriptionConfigured()
  if (!preset.apiKeyEnv) return false
  return Boolean(presetApiKey(normalizeProviderName(providerName), preset))
}

export function providerPresetDefaultModel(providerName: string): string | undefined {
  return PROVIDER_PRESETS[providerName]?.defaultModel
}

export function providerPresetApiKeyEnv(providerName: string): string | undefined {
  return PROVIDER_PRESETS[providerName]?.apiKeyEnv
}

export function providerPresetBaseURL(providerName: string): string | undefined {
  return PROVIDER_PRESETS[providerName]?.baseURL
}

export interface AvailableModel {
  id: string
  name?: string
  ownedBy?: string
  isDefault?: boolean
}

export interface ModelDiscoveryResult {
  providerName: string
  models: AvailableModel[]
  error?: string
}

/**
 * Lists models only when the user asks for them. This avoids startup latency and
 * does not modify the system prompt, model parameters, or chat request path.
 * Providers that expose an OpenAI-compatible /models endpoint use the same
 * adapter; Anthropic uses its native models endpoint and headers.
 */
export async function listProviderModels(providerNameInput: string): Promise<ModelDiscoveryResult> {
  const providerName = normalizeProviderName(providerNameInput)
  const preset = PROVIDER_PRESETS[providerName]
  if (!preset) return { providerName, models: [], error: unknownProviderError(providerNameInput) }
  if (preset.kind === 'codex-subscription') {
    const discovery = await listCodexSubscriptionModels()
    return { providerName, models: discovery.models.map(({ id, name, description, isDefault }) => ({ id, name, ownedBy: description, isDefault })), error: discovery.error }
  }
  if (!preset.apiKeyEnv) return { providerName, models: [], error: `No authentication method configured for ${providerName}` }

  const apiKey = presetApiKey(providerName, preset)
  if (!apiKey) return { providerName, models: [], error: `No API key set for ${providerName}` }

  const baseURL = providerName === 'custom' ? process.env.ELIA_BASE_URL : preset.baseURL
  if (!baseURL) return { providerName, models: [], error: `Set ELIA_BASE_URL to discover models for ${providerName}` }

  const allowExplicitLocal = providerName === 'custom' && process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT === '1'
  const endpoint = preset.kind === 'anthropic' ? 'https://api.anthropic.com/v1/models' : `${baseURL.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = preset.kind === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey}` }

  try {
    if (providerName === 'custom') await assertProviderEndpoint(baseURL)
    await assertPublicNetworkUrl(endpoint, { allowExplicitLocal })
    const response = await fetch(endpoint, { redirect: 'manual', headers, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return { providerName, models: [], error: `Model discovery returned HTTP ${response.status}` }
    const payload = (await response.json()) as { data?: unknown[]; models?: unknown[] }
    const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
    const models = rows
      .map((row) => {
        if (typeof row === 'string') return { id: row }
        if (!row || typeof row !== 'object') return undefined
        const item = row as Record<string, unknown>
        if (typeof item.id !== 'string' || item.id.length === 0) return undefined
        return {
          id: item.id,
          name: typeof item.name === 'string' ? item.name : undefined,
          ownedBy: typeof item.owned_by === 'string' ? item.owned_by : typeof item.ownedBy === 'string' ? item.ownedBy : undefined,
        }
      })
      .filter((model): model is AvailableModel => model !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id))
    return { providerName, models }
  } catch (error) {
    return { providerName, models: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export interface ProviderRequest {
  /** Provider preset name (defaults to `ELIA_PROVIDER`, then `anthropic`). */
  providerName?: string
  /** Model id override (defaults to `ELIA_MODEL`, then the preset default). */
  model?: string
  /** Base URL override (defaults to `ELIA_BASE_URL`, then the preset base URL). */
  baseURL?: string
  /** Env var to read the API key from, tried before the preset's own var. */
  apiKeyEnv?: string
  /**
   * Ignore the ambient `ELIA_PROVIDER`/`ELIA_MODEL`/`ELIA_BASE_URL` vars. Set when
   * resolving a *secondary* provider (the fast tier), whose preset defaults must not
   * be overridden by env vars the user set for the primary one.
   */
  ignoreAmbient?: boolean
  /** Extended thinking / reasoning. Omitted (not just `enabled: false`) means the caller doesn't want it wired at all. */
  thinking?: ThinkingOption
}

/** Resolves the primary provider from the environment, exiting the process with a clear message if it can't. */
export function resolveProvider(): ResolvedProvider {
  const resolved = tryResolveProvider()
  if ('error' in resolved) fail(resolved.error)
  return resolved
}

/**
 * Resolves a provider, returning an `error` string instead of exiting so callers
 * can fall back. Used for the optional fast tier, which must degrade to the
 * primary provider rather than kill the process when it isn't configured.
 */
export function tryResolveProvider(request: ProviderRequest = {}): ResolvedProvider | { error: string } {
  const ambient = request.ignoreAmbient ? {} : process.env
  const requestedName = request.providerName ?? ambient.ELIA_PROVIDER ?? 'anthropic'
  const providerName = normalizeProviderName(requestedName)
  const preset = PROVIDER_PRESETS[providerName]
  // An unknown name is a mistake to report, not something to silently run as
  // `custom` (which then fails with a misleading "no API key" message).
  if (!preset) return { error: unknownProviderError(requestedName) }

  if (preset.kind === 'codex-subscription') {
    if (!codexSubscriptionConfigured()) return { error: 'Codex is not signed in. Select Settings > Provider connections > ChatGPT subscription (Codex) and complete sign-in first.' }
    const model = request.model ?? ambient.ELIA_MODEL ?? preset.defaultModel ?? 'default'
    return { provider: createCodexSubscriptionProvider(model), providerName, model }
  }
  if (!preset.apiKeyEnv) return { error: `Provider "${providerName}" has no authentication method configured.` }

  // `tryResolveProvider` keeps the documented generic-key escape hatch: a
  // power user can point any preset at `ELIA_API_KEY`. Readiness reporting
  // (`isProviderPresetConfigured`) is the strict one — it must not claim a
  // provider is set up just because a generic key exists (issue #12).
  const apiKey =
    (request.apiKeyEnv ? process.env[request.apiKeyEnv] : undefined) ??
    process.env[preset.apiKeyEnv] ??
    process.env.ELIA_API_KEY
  if (!apiKey) {
    return {
      error:
        `No API key found for provider "${providerName}". ` +
        `Set ${preset.apiKeyEnv} (or the generic ELIA_API_KEY) in your .env file.`,
    }
  }

  const explicitDifferentProvider = request.providerName !== undefined && providerName !== normalizeProviderName(ambient.ELIA_PROVIDER ?? 'anthropic')
  const baseURL = request.baseURL ?? (explicitDifferentProvider && providerName !== 'custom' ? preset.baseURL : ambient.ELIA_BASE_URL ?? preset.baseURL)
  if (preset.kind === 'openai-compatible' && !baseURL) {
    return {
      error:
        `Provider "${providerName}" has no known base URL. ` +
        `Set ELIA_BASE_URL in your .env file to the provider's OpenAI-compatible endpoint (e.g. https://api.example.com/v1).`,
    }
  }

  if (preset.kind === 'openai-compatible' && baseURL) {
    try {
      validateNetworkUrl(baseURL, { allowExplicitLocal: process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT === '1', requireHttps: true })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  const model = request.model ?? ambient.ELIA_MODEL ?? preset.defaultModel
  if (!model) {
    return {
      error:
        `No model configured for provider "${providerName}". ` +
        `Set ELIA_MODEL in your .env file to the model id you want to use.`,
    }
  }

  const provider =
    preset.kind === 'anthropic'
      ? createAnthropicProvider(apiKey, model, { thinking: request.thinking })
      : createOpenAICompatibleProvider(apiKey, model, baseURL, { thinking: request.thinking })

  return { provider, providerName, model }
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}
