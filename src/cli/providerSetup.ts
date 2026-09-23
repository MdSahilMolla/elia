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
import { readUserConfigValues, userConfigPath, writeUserConfig } from '../userConfig.ts'
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
  const { PROVIDER_PRESET_NAMES, providerPresetDefaultModel, providerReadiness } = await import('../providers/registry.ts')
  const { detectOllama } = await import('../providers/ollama.ts')
  // A running Ollama with models is the one choice that needs no key, so it leads.
  const ollama = await detectOllama()
  const names = ollama.running && ollama.models.length > 0 ? ['ollama', ...PROVIDER_PRESET_NAMES.filter((name) => name !== 'ollama')] : PROVIDER_PRESET_NAMES
  const options = names.map((provider) => ({
    label: provider,
    detail: `${providerReadiness(provider)} · ${provider === 'ollama' ? 'models on this machine' : (providerPresetDefaultModel(provider) ?? 'custom endpoint and model')}`,
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
      detail: model.detail ?? model.name ?? model.ownedBy ?? 'available model',
      value: model.id,
    }))
    const title = provider === 'ollama' ? `Which Ollama model should elia run? (${options.length} on this machine)` : `Select a model for ${provider}`
    const result = await pick(title, options, Math.max(0, options.findIndex((option) => option.value === defaultModel)))
    if (result.type === 'select') {
      const warning = discovery.models.find((model) => model.id === result.value)?.warning
      if (warning) writeNotice(warning)
      return result.value
    }
    if (result.type === 'cancel') return undefined
  }
  if (discovery.error) writeNotice(provider === 'ollama' ? discovery.error : `Model discovery unavailable: ${discovery.error}`)
  // Ollama can only run a model that is already pulled; typing another name would fail at the first turn.
  if (provider === 'ollama' && discovery.models.length === 0) return undefined
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
  if (provider === 'ollama') {
    const model = await chooseModelForSetup('ollama')
    if (!model) {
      writeNotice('Provider setup cancelled. No settings were changed.')
      return undefined
    }
    try {
      const saved = saveProviderConfiguration({ provider, apiKey: '', model })
      writeNotice(`Saved: elia will run ${model} on Ollama (${saved.path}). No API key needed. /model ollama switches models any time.`)
      return saved
    } catch (error) {
      writeError(`Provider setup failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
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

/**
 * Makes a provider saved during startup the one this session uses.
 *
 * `config.ts` resolves its provider when it loads, which is before any setup
 * runs, so a provider chosen at first run used to be saved for the next launch
 * and leave this one unconfigured. The routing mode the person set is kept.
 */
async function activateSaved(saved: { provider: string; model: string }): Promise<boolean> {
  const { config, switchModel } = await import('../config.ts')
  const routingMode = config.routingMode
  const result = switchModel({ providerName: saved.provider, model: saved.model })
  config.routingMode = routingMode
  if (!result.ok) writeError(`Saved ${saved.provider}, but could not start it in this session: ${result.error}`)
  return result.ok
}

/** Set in the user config once elia has offered a running Ollama, so it asks once rather than every launch. */
export const OLLAMA_OFFERED_KEY = 'ELIA_OLLAMA_OFFERED'

export type OllamaStartupAction =
  | { kind: 'none' }
  /** Ollama is the provider but is not answering: say so before the first turn fails. */
  | { kind: 'not-running'; message: string }
  /** Ollama is the provider and the chosen model is missing, or none was chosen: ask which to run. */
  | { kind: 'choose'; reason: string }
  /** Another provider is set and Ollama is running with models it has not been offered: offer them once. */
  | { kind: 'offer' }

/** What startup should do about Ollama. Pure — the detection is done by the caller. */
export function ollamaStartupAction(input: {
  provider: string
  model?: string
  detection: { running: boolean; models: { name: string }[]; error?: string }
  offered: boolean
}): OllamaStartupAction {
  const { provider, model, detection } = input
  if (provider === 'ollama') {
    if (!detection.running) return { kind: 'not-running', message: detection.error ?? 'Ollama is not running' }
    if (detection.models.length === 0) return { kind: 'not-running', message: detection.error ?? 'Ollama has no models pulled' }
    if (!model) return { kind: 'choose', reason: 'No Ollama model is chosen yet.' }
    // `ollama pull qwen3` lists as `qwen3:latest`; either spelling names it.
    const present = detection.models.some((candidate) => candidate.name === model || candidate.name === `${model}:latest`)
    if (!present) return { kind: 'choose', reason: `${model} is not among the models Ollama has on this machine.` }
    return { kind: 'none' }
  }
  if (input.offered || !detection.running || detection.models.length === 0) return { kind: 'none' }
  return { kind: 'offer' }
}

/**
 * The interactive REPL's startup check for Ollama: warns when it is the provider
 * but not answering, asks which model to run when the chosen one is gone, and
 * — once — offers the local models to someone using a hosted provider.
 * `ELIA_OLLAMA_DETECT=off` skips it.
 */
export async function reviewOllamaAtStartup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return
  const { detectOllama } = await import('../providers/ollama.ts')
  const provider = (process.env.ELIA_PROVIDER ?? 'anthropic').trim().toLowerCase()
  const offered = Boolean(process.env[OLLAMA_OFFERED_KEY] ?? readUserConfigValues()[OLLAMA_OFFERED_KEY])
  if (provider !== 'ollama' && offered) return
  const detection = await detectOllama()
  const action = ollamaStartupAction({ provider, model: process.env.ELIA_MODEL?.trim() || undefined, detection, offered })
  if (action.kind === 'none') return
  if (action.kind === 'not-running') {
    writeNotice(`${action.message}. elia is set to use Ollama, so requests will fail until it is — or pick another provider with /model.`)
    return
  }
  if (action.kind === 'choose') {
    writeNotice(action.reason)
    const model = await chooseModelForSetup('ollama')
    if (!model) return
    const saved = saveProviderConfiguration({ provider: 'ollama', apiKey: '', model })
    if (await activateSaved(saved)) writeNotice(`elia will run ${model} on Ollama.`)
    return
  }
  // The offer: keep what is set, or run a local model instead. Asked once either way.
  writeUserConfig({ [OLLAMA_OFFERED_KEY]: '1' })
  process.env[OLLAMA_OFFERED_KEY] = '1'
  const { listProviderModels } = await import('../providers/registry.ts')
  const discovery = await listProviderModels('ollama')
  if (discovery.models.length === 0) return
  const current = `${provider}${process.env.ELIA_MODEL ? ` · ${process.env.ELIA_MODEL}` : ''}`
  const options = [
    { label: `Keep ${current}`, detail: 'use /model ollama to switch any time', value: '' },
    ...discovery.models.map((model) => ({ label: model.id, detail: model.detail ?? 'local model', value: model.id })),
  ]
  const result = await pick(`Ollama is running on this machine with ${discovery.models.length} model${discovery.models.length === 1 ? '' : 's'}. Run one of them instead? (asked once)`, options, 0)
  if (result.type !== 'select' || !result.value) return
  const warning = discovery.models.find((model) => model.id === result.value)?.warning
  if (warning) writeNotice(warning)
  const saved = saveProviderConfiguration({ provider: 'ollama', apiKey: '', model: result.value })
  if (await activateSaved(saved)) writeNotice(`Switched to ${result.value} on Ollama. /model switches back.`)
}

export async function ensureFirstRunProviderSetup(options: { interactive?: boolean } = {}): Promise<boolean> {
  if (!activeProviderNeedsSetup()) {
    if (options.interactive) await reviewOllamaAtStartup().catch(() => {})
    prewarmActiveProvider()
    return true
  }
  const { detectOllama } = await import('../providers/ollama.ts')
  const ollama = await detectOllama()
  const ollamaReady = ollama.running && ollama.models.length > 0
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    writeError(
      'No provider is configured. Run `elia config set --provider <name> --api-key-stdin --model <model-id>` from a secure shell, or run elia in an interactive terminal for first-run setup.' +
        (ollamaReady ? ` Ollama is running here: \`elia config set --provider ollama --model ${ollama.models[0]!.name}\` needs no key.` : ''),
    )
    process.exitCode = 1
    return false
  }
  let saved: SavedProviderConfiguration | undefined
  if ((process.env.ELIA_PROVIDER ?? '').trim().toLowerCase() === 'ollama') {
    // Ollama is already the provider; only the model is missing.
    const model = ollamaReady ? await chooseModelForSetup('ollama') : undefined
    if (!ollamaReady) writeError(ollama.error ?? 'Ollama is not available.')
    if (model) saved = saveProviderConfiguration({ provider: 'ollama', apiKey: '', model })
  } else {
    writeNotice(
      ollamaReady
        ? `No provider is configured yet. Ollama is running on this machine with ${ollama.models.length} model${ollama.models.length === 1 ? '' : 's'} — choose "ollama" to run one with no API key, or pick a hosted provider.`
        : 'No complete provider configuration was found. Elia will ask for a provider, hidden API key, and model before starting.',
    )
    saved = await interactiveProviderSetup('first-run')
  }
  if (!saved) return false
  if (!(await activateSaved(saved))) return false
  prewarmActiveProvider()
  return true
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
