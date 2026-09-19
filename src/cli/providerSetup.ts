/**
 * First-run and `elia config` provider setup, and the Codex subscription login.
 *
 * Both the REPL and the `codex-login` subcommand need these, so they cannot
 * stay in index.ts once the REPL moves out — index.ts would import the REPL and
 * the REPL would import back for `ensureFirstRunProviderSetup`. Breaking that
 * cycle is the reason this file exists; the grouping is the natural one anyway,
 * since every function here exists to put a working provider in the config.
 */
import * as readline from 'node:readline/promises'
import { writeNotice, writeError } from '../ui/stream.ts'
import { pick } from '../ui/picker.ts'
import { userConfigPath, writeUserConfig } from '../userConfig.ts'
import { activeProviderNeedsSetup, saveProviderConfiguration, type SavedProviderConfiguration } from '../providerSettings.ts'

/**
 * Subscription authentication belongs to the official Codex CLI, not Elia's
 * OpenAI API adapter. Keeping it in the external client means Elia never reads
 * or persists a ChatGPT session token; the subscription provider invokes the
 * signed-in client only for its responses.
 */
export async function runCodexLogin(): Promise<boolean> {
  const { codexAvailable } = await import('../tools/codex.ts')
  if (!(await codexAvailable())) {
    writeError('Codex CLI is not installed or not on PATH. Install @openai/codex, then run `elia codex-login` again.')
    process.exitCode = 1
    return false
  }

  writeNotice('Opening the Codex sign-in flow. Complete authentication in Codex; Elia never receives or stores your ChatGPT credentials.')
  try {
    const proc = Bun.spawn(['codex', 'login'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    const exitCode = await proc.exited
    if (exitCode === 0) {
      writeNotice('Codex sign-in finished. You can now select ChatGPT subscription (Codex) as Elia’s active model.')
      return true
    }
    else {
      writeError(`Codex sign-in ended with exit code ${exitCode}. Your existing Elia API-provider configuration was not changed.`)
      process.exitCode = 1
      return false
    }
  } catch (error) {
    writeError(`Could not start Codex sign-in: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return false
  }
}

export async function readStdinText(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += Buffer.from(chunk as Uint8Array).toString('utf8')
  return text
}

export async function readLineInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return ''
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(prompt)).trim()
  } finally {
    rl.close()
  }
}

export async function readSecretInput(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY || !stdin.setRawMode) return ''
  process.stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return await new Promise<string>((resolve) => {
    let value = ''
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          process.stdout.write('\n')
          cleanup()
          resolve('')
          return
        }
        if (char === '\r' || char === '\n') {
          process.stdout.write('\n')
          cleanup()
          resolve(value)
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
    }
    stdin.on('data', onData)
  })
}

export async function chooseProviderForSetup(title: string): Promise<string | undefined> {
  const { PROVIDER_PRESET_NAMES, isProviderPresetConfigured, providerPresetDefaultModel } = await import('../providers/registry.ts')
  const options = PROVIDER_PRESET_NAMES.map((provider) => ({
    label: provider,
    detail: `${isProviderPresetConfigured(provider) ? 'configured' : 'not configured'} · ${providerPresetDefaultModel(provider) ?? 'custom endpoint and model'}`,
    value: provider,
  }))
  const result = await pick(title, options)
  if (result.type === 'select') return result.value
  if (result.type === 'cancel') return undefined
  const entered = (await readLineInput(`Provider [${options[0]?.value ?? 'anthropic'}]: `)).toLowerCase()
  const selected = entered || options[0]?.value
  if (!selected || !PROVIDER_PRESET_NAMES.includes(selected)) {
    writeError(`Unknown provider "${entered}". No credentials were changed.`)
    return undefined
  }
  return selected
}

export async function chooseModelForSetup(provider: string, suggestedModel?: string): Promise<string | undefined> {
  const { listProviderModels, providerPresetDefaultModel } = await import('../providers/registry.ts')
  const discovery = await listProviderModels(provider)
  const defaultModel = suggestedModel ?? providerPresetDefaultModel(provider)
  if (discovery.models.length > 0) {
    const options = discovery.models.map((model) => ({
      label: model.id === defaultModel ? `${model.id} (recommended)` : model.id,
      detail: model.name ?? model.ownedBy ?? 'available model',
      value: model.id,
    }))
    const result = await pick(`Select a model for ${provider}`, options, Math.max(0, options.findIndex((option) => option.value === defaultModel)))
    if (result.type === 'select') return result.value
    if (result.type === 'cancel') return undefined
  }
  if (discovery.error) writeNotice(`Model discovery unavailable: ${discovery.error}`)
  if (!defaultModel) return readLineInput(`Enter the model id for ${provider}: `)
  const entered = await readLineInput(`Model id [${defaultModel}]: `)
  return entered || defaultModel
}

export async function interactiveProviderSetup(reason: 'first-run' | 'settings'): Promise<SavedProviderConfiguration | undefined> {
  const provider = await chooseProviderForSetup(reason === 'first-run' ? 'First-run provider setup' : 'Add or update provider')
  if (!provider) {
    writeNotice('Provider setup cancelled. No credentials were changed.')
    return undefined
  }
  if (provider === 'codex') {
    if (!(await runCodexLogin())) return undefined
    const model = 'default'
    const path = userConfigPath()
    writeUserConfig({ ELIA_PROVIDER: provider, ELIA_MODEL: model, ELIA_BASE_URL: undefined }, path)
    process.env.ELIA_PROVIDER = provider
    process.env.ELIA_MODEL = model
    delete process.env.ELIA_BASE_URL
    return { provider, apiKeyEnv: 'managed by Codex', model, path }
  }
  const { providerPresetApiKeyEnv } = await import('../providers/registry.ts')
  const apiKeyEnv = providerPresetApiKeyEnv(provider)
  if (!apiKeyEnv) {
    writeError(`Provider "${provider}" does not define an API key variable`)
    return undefined
  }
  const baseURL = provider === 'custom' ? await readLineInput('Custom HTTPS base URL: ') : undefined
  if (provider === 'custom' && !baseURL) {
    writeNotice('Provider setup cancelled. A custom provider requires a base URL.')
    return undefined
  }
  const apiKey = await readSecretInput(`Enter ${apiKeyEnv} (input hidden): `)
  if (!apiKey) {
    writeNotice('Provider setup cancelled. No credentials were changed.')
    return undefined
  }

  const previousKey = process.env[apiKeyEnv]
  const previousBaseURL = process.env.ELIA_BASE_URL
  process.env[apiKeyEnv] = apiKey
  if (baseURL) process.env.ELIA_BASE_URL = baseURL
  let savedConfiguration: SavedProviderConfiguration | undefined
  try {
    const model = await chooseModelForSetup(provider)
    if (!model) {
      writeNotice('Provider setup cancelled. No credentials were changed.')
      return undefined
    }
    savedConfiguration = saveProviderConfiguration({ provider, apiKey, model, baseURL })
    writeNotice(`Saved ${provider} configuration to ${savedConfiguration.path}.`)
    writeNotice(`Model: ${savedConfiguration.model}`)
    writeNotice('The API key was saved without displaying its value.')
    return savedConfiguration
  } catch (error) {
    writeError(`Provider setup failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    if (!savedConfiguration) {
      if (process.env[apiKeyEnv] === apiKey && previousKey !== undefined) process.env[apiKeyEnv] = previousKey
      else if (previousKey === undefined && process.env[apiKeyEnv] === apiKey) delete process.env[apiKeyEnv]
      if (baseURL && process.env.ELIA_BASE_URL === baseURL && previousBaseURL !== undefined) process.env.ELIA_BASE_URL = previousBaseURL
      else if (baseURL && previousBaseURL === undefined && process.env.ELIA_BASE_URL === baseURL) delete process.env.ELIA_BASE_URL
    }
  }
}

export async function ensureFirstRunProviderSetup(): Promise<boolean> {
  if (!activeProviderNeedsSetup()) {
    prewarmActiveProvider()
    return true
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    writeError('No provider is configured. Run `elia config set --provider <name> --api-key-stdin --model <model-id>` from a secure shell, or run elia in an interactive terminal for first-run setup.')
    process.exitCode = 1
    return false
  }
  writeNotice('No complete provider configuration was found. Elia will ask for a provider, hidden API key, and model before starting.')
  const ok = Boolean(await interactiveProviderSetup('first-run'))
  if (ok) prewarmActiveProvider()
  return ok
}

/**
 * Fire-and-forget: open a pooled connection to the active model host so the
 * first turn's request skips DNS + TLS + HTTP/2 setup on its critical path.
 * Runs while the user is still reading the intro or typing. Never throws.
 */
/**
 * Open a pooled connection to every model host a run might touch — the deep
 * tier, the fast tier if it is a distinct provider, and any role override — so
 * the first request on each (an orientation scout is often the very first thing
 * a task does, on the fast tier) skips connection setup. `warmConnection`
 * dedupes per origin, so tiers that share a host cost one probe.
 */
export function prewarmActiveProvider(): void {
  void Promise.all([import('../config.ts'), import('../autonomy/mode.ts')])
    .then(([{ config, systemPromptForMode }, { activeMode }]) => {
      // Give the deep tier the resolved session prompt so an agentic provider
      // (the ChatGPT subscription) can pre-start its workspace thread, not just
      // its connection. The fast tier / role overrides only need a connection.
      const deepHint = { system: systemPromptForMode(activeMode()) }
      const seen = new Set<import('../providers/types.ts').Provider>()
      const warm = (provider?: { prewarm?: (hint?: { system?: string }) => void }, hint?: { system?: string }): void => {
        if (!provider || seen.has(provider as import('../providers/types.ts').Provider)) return
        seen.add(provider as import('../providers/types.ts').Provider)
        provider.prewarm?.(hint)
      }
      warm(config.tiers.deep.provider, deepHint)
      warm(config.tiers.fast.provider)
      for (const route of Object.values(config.roleOverrides)) warm(route?.provider)
    })
    .catch(() => {})
}
