import { isProviderPresetConfigured, providerPresetApiKeyEnv, providerPresetBaseURL, providerPresetDefaultModel, PROVIDER_PRESET_NAMES } from './providers/registry.ts'
import { assertProviderEndpoint, validateNetworkUrl } from './networkPolicy.ts'
import { removeUserConfig, readUserConfigValues, userConfigPath, writeUserConfig } from './userConfig.ts'

export interface SaveProviderConfigurationInput {
  provider: string
  apiKey: string
  model?: string
  baseURL?: string
  filePath?: string
}

export interface SavedProviderConfiguration {
  provider: string
  apiKeyEnv: string
  model: string
  baseURL?: string
  path: string
}

export function savedProviderNames(filePath = userConfigPath()): string[] {
  const stored = readUserConfigValues(filePath)
  return PROVIDER_PRESET_NAMES.filter((provider) => {
    const apiKeyEnv = providerPresetApiKeyEnv(provider)
    return apiKeyEnv !== undefined && stored[apiKeyEnv] !== undefined
  })
}

export function activeProviderNeedsSetup(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = (env.ELIA_PROVIDER ?? 'anthropic').trim().toLowerCase()
  if (provider === 'codex') return !isProviderPresetConfigured('codex')
  const keyEnv = providerPresetApiKeyEnv(provider)
  if (!keyEnv || !env[keyEnv]?.trim()) return true
  if (provider === 'custom' && !env.ELIA_BASE_URL?.trim()) return true
  if (provider === 'custom' && !env.ELIA_MODEL?.trim()) return true
  return false
}

export function saveProviderConfiguration(input: SaveProviderConfigurationInput): SavedProviderConfiguration {
  const provider = input.provider.trim().toLowerCase()
  if (!PROVIDER_PRESET_NAMES.includes(provider)) throw new Error(`Unknown provider "${provider}". Choose one of: ${PROVIDER_PRESET_NAMES.join(', ')}`)
  const apiKeyEnv = providerPresetApiKeyEnv(provider)
  if (!apiKeyEnv) throw new Error(`Provider "${provider}" does not define an API key variable`)
  const apiKey = input.apiKey.trim()
  if (!apiKey) throw new Error('API key cannot be empty')

  const model = input.model?.trim() || providerPresetDefaultModel(provider)
  if (!model) throw new Error(`Provider "${provider}" requires a model id`)
  const baseURL = input.baseURL?.trim() || (provider === 'custom' ? undefined : providerPresetBaseURL(provider))
  if (provider === 'custom' && !baseURL) throw new Error('Custom providers require a base URL')
  if (baseURL) validateNetworkUrl(baseURL, { allowExplicitLocal: process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT === '1', requireHttps: true })

  const path = input.filePath ?? userConfigPath()
  writeUserConfig({ ELIA_PROVIDER: provider, [apiKeyEnv]: apiKey, ELIA_MODEL: model, ELIA_BASE_URL: provider === 'custom' ? baseURL : undefined }, path)
  process.env.ELIA_PROVIDER = provider
  process.env[apiKeyEnv] = apiKey
  process.env.ELIA_MODEL = model
  if (provider === 'custom' && baseURL) process.env.ELIA_BASE_URL = baseURL
  else delete process.env.ELIA_BASE_URL

  return { provider, apiKeyEnv, model, baseURL, path }
}

export function removeProviderConfiguration(providerName: string, filePath = userConfigPath()): { provider: string; apiKeyEnv: string; removed: boolean; path: string } {
  const provider = providerName.trim().toLowerCase()
  if (!PROVIDER_PRESET_NAMES.includes(provider)) throw new Error(`Unknown provider "${provider}"`)
  const apiKeyEnv = providerPresetApiKeyEnv(provider)
  if (!apiKeyEnv) throw new Error(`Provider "${provider}" does not define an API key variable`)
  const stored = readUserConfigValues(filePath)
  const keys = [apiKeyEnv]
  if (stored.ELIA_PROVIDER?.toLowerCase() === provider) {
    keys.push('ELIA_PROVIDER', 'ELIA_MODEL')
    if (provider === 'custom') keys.push('ELIA_BASE_URL')
  }
  const hadStoredValue = keys.some((key) => stored[key] !== undefined)
  removeUserConfig(keys, filePath)

  for (const key of keys) {
    if (stored[key] !== undefined && process.env[key] === stored[key]) delete process.env[key]
  }
  return { provider, apiKeyEnv, removed: hadStoredValue, path: filePath }
}

/** Network validation is intentionally exposed for settings tests without exposing any credential values. */
export async function validateSavedProviderEndpoint(baseURL: string): Promise<URL> {
  return assertProviderEndpoint(baseURL)
}
