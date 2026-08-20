import { createAnthropicProvider } from './anthropic.ts'
import { createOpenAICompatibleProvider } from './openaiCompatible.ts'
import type { Provider, ThinkingOption } from './types.ts'

interface ProviderPreset {
  kind: 'anthropic' | 'openai-compatible'
  apiKeyEnv: string
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
  mercury: {
    kind: 'openai-compatible',
    apiKeyEnv: 'INCEPTION_API_KEY',
    baseURL: 'https://api.inceptionlabs.ai/v1',
    defaultModel: 'mercury-2',
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

/** Whether a preset's API key is actually set, so a "switch model" listing can show what's usable right now versus just known by name. */
export function isProviderPresetConfigured(providerName: string): boolean {
  const preset = PROVIDER_PRESETS[providerName]
  if (!preset) return false
  return Boolean(process.env[preset.apiKeyEnv] ?? process.env.ELIA_API_KEY)
}

export function providerPresetDefaultModel(providerName: string): string | undefined {
  return PROVIDER_PRESETS[providerName]?.defaultModel
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
  const providerName = request.providerName ?? ambient.ELIA_PROVIDER ?? 'anthropic'
  const preset = PROVIDER_PRESETS[providerName] ?? PROVIDER_PRESETS.custom!

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

  const baseURL = request.baseURL ?? ambient.ELIA_BASE_URL ?? preset.baseURL
  if (preset.kind === 'openai-compatible' && !baseURL) {
    return {
      error:
        `Provider "${providerName}" has no known base URL. ` +
        `Set ELIA_BASE_URL in your .env file to the provider's OpenAI-compatible endpoint (e.g. https://api.example.com/v1).`,
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
