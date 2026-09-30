import { createAnthropicProvider } from './anthropic.ts'
import { codexSubscriptionConfigured, createCodexSubscriptionProvider, listCodexSubscriptionModels } from './codexSubscription.ts'
import { createOpenAICompatibleProvider } from './openaiCompatible.ts'
import { assertOllamaHost, cachedOllamaDetection, createOllamaProvider, describeOllamaModel, detectOllama, ollamaHost, ollamaModelWarning, rankOllamaModels } from './ollama.ts'
import { assertProviderEndpoint, publicFetch, validateNetworkUrl } from '../networkPolicy.ts'
import type { Provider, ThinkingOption } from './types.ts'

interface ProviderPreset {
  kind: 'anthropic' | 'openai-compatible' | 'codex-subscription' | 'ollama'
  apiKeyEnv?: string
  /** The key is optional: a local server needs none, and `apiKeyEnv` is only for one that asks. */
  keyOptional?: boolean
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
    // Probed live on 2026-09-20. The previous default,
    // `nvidia/llama-3.3-nemotron-super-49b-v1.5`, reached end of life on
    // 2026-08-26 and now answers 410 — which surfaced as a *benchmark task
    // failure* during an `elia evolve` baseline, because `ELIA_ROUTING_MODE=auto`
    // puts every preset in the fallback chain. Note that NVIDIA lists 82 models
    // and most of them 404 on inference for a given account, so this was chosen
    // by probing rather than by reading the catalogue.
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
  },
  mercury: {
    kind: 'openai-compatible',
    apiKeyEnv: 'INCEPTION_API_KEY',
    baseURL: 'https://api.inceptionlabs.ai/v1',
    defaultModel: 'mercury-2.5',
  },
  // Local models. No default model — only the person knows which of their
  // pulled models to run — and no key unless the server asks for one. The
  // address comes from OLLAMA_HOST, the variable Ollama itself reads.
  ollama: {
    kind: 'ollama',
    apiKeyEnv: 'OLLAMA_API_KEY',
    keyOptional: true,
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

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'codex-subscription' | 'ollama'

/**
 * What a provider route can do, derived once from the preset table instead of a
 * `providerName === 'codex'`/`=== 'ollama'` comparison at every decision site.
 * The name-based checks had the same shape and the same spelling risk repeated
 * across a dozen files; capability queries stay meaningful when a provider gains
 * a family member or a preset is pointed at a new endpoint. String identity is
 * still the right tool where a decision is about *which* preset this is — the
 * provider picker, sign-in messaging — so those sites are untouched.
 */
export interface ProviderCapabilities {
  /** The provider-family this preset speaks over. */
  kind: ProviderKind
  /** Accepts base64 image blocks on user turns. Codex has no vision channel; every other preset is treated as capable. */
  vision: boolean
  /** Runs against a server on this machine: no API key, and one shared parallel/GPU budget. */
  local: boolean
  /** The call hands off to the provider's own agent (the ChatGPT subscription's Codex CLI) rather than Elia's model-tool loop. */
  handoff: boolean
  /** Where the working conversation lives: Elia's own messages, or a thread the provider keeps and compacts itself. */
  threadModel: 'elia' | 'provider'
}

const GENERIC_CAPABILITIES: ProviderCapabilities = { kind: 'openai-compatible', vision: true, local: false, handoff: false, threadModel: 'elia' }

/**
 * The capabilities of a provider preset. Unknown names (a caller's typo, or a
 * provider from a build that knows a preset this one does not) fall back to the
 * openai-compatible defaults rather than throwing — a capability query must
 * never be the thing that crashes a turn.
 */
export function providerCapabilities(providerName: string): ProviderCapabilities {
  const preset = PROVIDER_PRESETS[normalizeProviderName(providerName)]
  if (!preset) return GENERIC_CAPABILITIES
  switch (preset.kind) {
    case 'codex-subscription':
      return { kind: 'codex-subscription', vision: false, local: false, handoff: true, threadModel: 'provider' }
    case 'ollama':
      return { kind: 'ollama', vision: true, local: true, handoff: false, threadModel: 'elia' }
    case 'anthropic':
      return { kind: 'anthropic', vision: true, local: false, handoff: false, threadModel: 'elia' }
    case 'openai-compatible':
      return { kind: 'openai-compatible', vision: true, local: false, handoff: false, threadModel: 'elia' }
  }
}

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
  if (preset.kind === 'ollama') {
    // Ready means a server answered with a model to run — not a key, which it does not need.
    const detection = cachedOllamaDetection()
    if (detection) return detection.running && detection.models.length > 0
    return normalizeProviderName(process.env.ELIA_PROVIDER ?? '') === 'ollama' && Boolean(process.env.ELIA_MODEL?.trim())
  }
  if (!preset.apiKeyEnv) return false
  return Boolean(presetApiKey(normalizeProviderName(providerName), preset))
}

/**
 * The status a provider picker shows beside a preset: whether it can be used
 * right now, and if not, what is missing. Ollama is judged by the last
 * detection, since it has no key to look for.
 */
export function providerReadiness(providerName: string): string {
  const name = normalizeProviderName(providerName)
  if (PROVIDER_PRESETS[name]?.kind === 'ollama') {
    const detection = cachedOllamaDetection()
    if (!detection) return isProviderPresetConfigured(name) ? 'ready' : 'local models'
    if (!detection.running) return 'not running'
    if (detection.models.length === 0) return 'running, no models pulled'
    return `running · ${detection.models.length} local model${detection.models.length === 1 ? '' : 's'} · no key needed`
  }
  return isProviderPresetConfigured(name) ? 'ready' : 'no key set'
}

/** True for a preset whose API key may be left unset (a local server). */
export function providerPresetKeyOptional(providerName: string): boolean {
  return Boolean(PROVIDER_PRESETS[normalizeProviderName(providerName)]?.keyOptional)
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
  /** A line for the picker, when the provider knows more than a name (size, tool calling, context). */
  detail?: string
  /** Why this model is a poor fit for elia, shown before it is switched to. */
  warning?: string
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
  if (preset.kind === 'ollama') {
    // What is pulled on this machine, best-suited to elia first, each with what it can do.
    const detection = await detectOllama({ details: true })
    const models = rankOllamaModels(detection.models).map((model) => {
      const warning = ollamaModelWarning(model)
      return { id: model.name, detail: describeOllamaModel(model), ...(warning ? { warning } : {}) }
    })
    return { providerName, models, ...(detection.error ? { error: detection.error } : {}) }
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
    // Pinned: the DNS answer that passes the policy is the one connected to.
    const response = await publicFetch(endpoint, { headers, signal: AbortSignal.timeout(15_000), policy: { allowExplicitLocal } })
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
  if (preset.kind === 'ollama') {
    const model = request.model ?? ambient.ELIA_MODEL
    if (!model) return { error: 'No Ollama model chosen. Start elia in a terminal to pick one of your local models, or run `/model ollama`.' }
    const host = request.baseURL ?? ollamaHost()
    try {
      assertOllamaHost(host)
    } catch (error) {
      return { error: `Ollama at ${host}: ${error instanceof Error ? error.message : String(error)}. Plain HTTP is allowed only on this machine (127.0.0.1); use HTTPS for a remote server.` }
    }
    const apiKey = (request.apiKeyEnv ? process.env[request.apiKeyEnv] : undefined) ?? process.env.OLLAMA_API_KEY
    return { provider: createOllamaProvider(model, host, { ...(request.thinking ? { thinking: request.thinking } : {}), ...(apiKey ? { apiKey } : {}) }), providerName, model }
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
      : createOpenAICompatibleProvider(apiKey, model, baseURL, {
          thinking: request.thinking,
          reasoningSummary: isInceptionEndpoint(baseURL) && process.env.ELIA_REASONING_SUMMARY !== 'off',
          reasoningEffort: isInceptionEndpoint(baseURL),
          gemini: isGeminiEndpoint(baseURL),
        })

  return { provider, providerName, model }
}

/**
 * Inception's API (the `mercury` preset, or `custom` pointed at it) is the one
 * OpenAI-compatible endpoint here that hides its reasoning unless the request
 * asks for a summary, and that takes a per-request `reasoning_effort` with an
 * `instant` level. Any other endpoint gets neither — OpenAI itself rejects
 * unrecognised request arguments.
 */
export function isInceptionEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    const host = new URL(baseURL).hostname
    return host === 'inceptionlabs.ai' || host.endsWith('.inceptionlabs.ai')
  } catch {
    return false
  }
}

/** Google's OpenAI-compatible Gemini API (the `google` preset, or `custom` pointed at it). */
export function isGeminiEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    return new URL(baseURL).hostname === 'generativelanguage.googleapis.com'
  } catch {
    return false
  }
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}
