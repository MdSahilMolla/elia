import { totalmem } from 'node:os'
import { validateNetworkUrl } from '../networkPolicy.ts'
import { activeMode } from '../autonomy/mode.ts'
import { declareContextWindow } from '../contextWindow.ts'
import { declareLocalModel } from '../usage.ts'
import { streamIdleMs } from './openaiCompatible.ts'
import type { ChatMessage, ContentBlock, Provider, StreamTurnParams, ThinkingOption, ToolDefinition, Usage } from './types.ts'

/**
 * Ollama, spoken natively.
 *
 * Ollama also serves an OpenAI-compatible `/v1`, and elia's `custom` provider
 * could already be pointed at it — but that route cannot work for an agent this
 * size. `/v1` has no way to set the context window, so every request runs at
 * the server's default: 4k tokens on a machine with under 24 GB of VRAM. elia
 * sends about 17k (its system prompt and 49 tool definitions) before the first
 * user message, and Ollama drops whatever does not fit from the front without
 * an error. The model never sees its instructions or its tools.
 *
 * `/api/chat` takes `options.num_ctx` per request, so this adapter sets a window
 * that holds the prompt — as much of the model's maximum as this machine's
 * memory holds (`memoryFitNumCtx`), never less than `DEFAULT_NUM_CTX` — and
 * declares it to `contextWindow.ts`, so compaction plans for the window that is
 * really there. The same `num_ctx` goes on every request: Ollama reloads the
 * model when it changes.
 *
 * A local model is slow to read a long prompt, so in dev mode it is not offered
 * the specialist tools (`LOCAL_MODEL_OMITTED_TOOLS`): their definitions were
 * three quarters of every request. One server runs one request at a time, so
 * requests to it queue here (`OLLAMA_NUM_PARALLEL` slots) rather than inside
 * Ollama, where a queued request would look like a stalled one.
 *
 * No API key is needed. `OLLAMA_API_KEY`, when set, is sent as a bearer token
 * for a hosted or authenticated server. Plain HTTP is allowed only to this
 * machine's loopback address; anything else must be HTTPS.
 */

export const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434'

/** The window elia asks for when the model allows it. Holds the ~17k fixed prompt with room for a working conversation. */
export const DEFAULT_NUM_CTX = 32_768

/** The most `memoryFitNumCtx` asks for: past this, a long conversation is re-read slower than it is worth on local hardware. */
export const MAX_AUTO_NUM_CTX = 131_072

/** Below this the fixed prompt alone does not fit; such a model cannot run elia's tools. */
export const MIN_USABLE_CONTEXT = 24_576

/**
 * The server address, read the way Ollama itself reads `OLLAMA_HOST`: a bare
 * host, `host:port`, or a full URL, defaulting to port 11434. A server told to
 * listen on every interface (`0.0.0.0`) is reached on this machine at loopback.
 */
export function ollamaHost(env: Record<string, string | undefined> = process.env): string {
  const raw = env.OLLAMA_HOST?.trim()
  if (!raw) return OLLAMA_DEFAULT_HOST
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return OLLAMA_DEFAULT_HOST
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1'
  // `URL` drops a default port, so whether one was written is read off the text.
  const authority = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? ''
  if (url.protocol === 'http:' && !/:\d+$/.test(authority)) url.port = '11434'
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function isLoopback(host: string): boolean {
  try {
    const name = new URL(host).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1' || name === '::1'
  } catch {
    return false
  }
}

/** Loopback over HTTP, anything else over HTTPS to a public address. Throws with the reason otherwise. */
export function assertOllamaHost(host: string): URL {
  return validateNetworkUrl(host, { allowExplicitLocal: true, requireHttps: true })
}

export interface OllamaModel {
  name: string
  sizeBytes?: number
  parameterSize?: string
  quantization?: string
  family?: string
  /** From `/api/show`: `completion`, `tools`, `vision`, `thinking`, … Undefined when the server did not say. */
  capabilities?: string[]
  /** The model's own maximum context, from `/api/show`. */
  contextLength?: number
  /** Bytes of f16 KV cache one token of context costs, from the attention shape `/api/show` reports. */
  kvBytesPerToken?: number
}

export interface OllamaDetection {
  host: string
  running: boolean
  models: OllamaModel[]
  /** Why it is not usable, in words a person can act on. */
  error?: string
}

let lastDetection: OllamaDetection | undefined

/** The most recent detection this process ran, for synchronous readiness checks. */
export function cachedOllamaDetection(): OllamaDetection | undefined {
  return lastDetection
}

/** Test-only. */
export function resetOllamaDetection(): void {
  lastDetection = undefined
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

async function getJson(url: string, init: RequestInit & { timeoutMs: number }): Promise<unknown> {
  // A timer rather than AbortSignal.timeout: Bun's has hung before in this repo (see probe.ts).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}${await errorDetail(response)}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const parsed = JSON.parse(text) as { error?: unknown }
    return typeof parsed.error === 'string' ? `: ${parsed.error}` : text ? `: ${text.slice(0, 200)}` : ''
  } catch {
    return ''
  }
}

function notRunning(host: string): string {
  return `Ollama is not running at ${host} — open the Ollama app or run \`ollama serve\` (or set OLLAMA_HOST to where it runs)`
}

/** `/api/tags` rows into models. Tolerates missing fields; drops rows without a name. */
export function parseTags(payload: unknown): OllamaModel[] {
  const rows = payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown }).models) ? (payload as { models: unknown[] }).models : []
  const models: OllamaModel[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const name = typeof item.name === 'string' && item.name ? item.name : typeof item.model === 'string' ? item.model : ''
    if (!name) continue
    const details = item.details && typeof item.details === 'object' ? (item.details as Record<string, unknown>) : {}
    models.push({
      name,
      ...(typeof item.size === 'number' ? { sizeBytes: item.size } : {}),
      ...(typeof details.parameter_size === 'string' ? { parameterSize: details.parameter_size } : {}),
      ...(typeof details.quantization_level === 'string' ? { quantization: details.quantization_level } : {}),
      ...(typeof details.family === 'string' ? { family: details.family } : {}),
    })
  }
  return models.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * KV cache per token: K and V, f16, for every attention layer's KV heads.
 * `head_count_kv` is a number, or a per-layer array in which a hybrid model
 * (qwen3.5: attention every fourth layer) gives its non-attention layers 0.
 * Undefined when the shape is not reported — then nothing is assumed.
 */
export function kvBytesPerToken(info: Record<string, unknown>): number | undefined {
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : undefined
  if (!arch) return undefined
  const num = (key: string) => (typeof info[`${arch}.${key}`] === 'number' ? (info[`${arch}.${key}`] as number) : undefined)
  const blocks = num('block_count')
  const heads = num('attention.head_count')
  const embedding = num('embedding_length')
  const headDim = heads && embedding ? embedding / heads : undefined
  const keyLength = num('attention.key_length') ?? headDim
  const valueLength = num('attention.value_length') ?? headDim
  if (!blocks || !keyLength || !valueLength) return undefined
  const rawKv = info[`${arch}.attention.head_count_kv`]
  let kvHeads: number | undefined
  if (Array.isArray(rawKv)) kvHeads = rawKv.reduce((sum: number, value) => sum + (typeof value === 'number' ? value : 0), 0)
  else if (typeof rawKv === 'number') {
    const interval = num('full_attention_interval')
    kvHeads = rawKv * (interval && interval > 1 ? Math.ceil(blocks / interval) : blocks)
  }
  if (!kvHeads) return undefined
  return kvHeads * (keyLength + valueLength) * 2
}

/** `/api/show` into capabilities, the model's maximum context (`<arch>.context_length` in `model_info`) and its KV cost per token. */
export function parseShow(payload: unknown): Pick<OllamaModel, 'capabilities' | 'contextLength' | 'kvBytesPerToken'> {
  if (!payload || typeof payload !== 'object') return {}
  const body = payload as { capabilities?: unknown; model_info?: unknown }
  const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is string => typeof value === 'string') : undefined
  let contextLength: number | undefined
  let kvBytes: number | undefined
  if (body.model_info && typeof body.model_info === 'object') {
    const info = body.model_info as Record<string, unknown>
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) contextLength = value
    }
    kvBytes = kvBytesPerToken(info)
  }
  return { ...(capabilities ? { capabilities } : {}), ...(contextLength ? { contextLength } : {}), ...(kvBytes ? { kvBytesPerToken: kvBytes } : {}) }
}

export async function showOllamaModel(model: string, options: { host?: string; apiKey?: string; timeoutMs?: number } = {}): Promise<Pick<OllamaModel, 'capabilities' | 'contextLength' | 'kvBytesPerToken'>> {
  const host = options.host ?? ollamaHost()
  const payload = await getJson(`${host}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(options.apiKey ?? process.env.OLLAMA_API_KEY) },
    body: JSON.stringify({ model }),
    timeoutMs: options.timeoutMs ?? 5_000,
  })
  return parseShow(payload)
}

export interface DetectOptions {
  host?: string
  /** How long to wait for the server to answer at all. A stopped server refuses at once; this bounds a host that hangs. */
  timeoutMs?: number
  /** Also ask each model what it can do (tools, thinking) and how much context it holds. */
  details?: boolean
  env?: Record<string, string | undefined>
}

/** Most models a detail pass asks about; each is one small request. */
const MAX_DETAILED = 40

/**
 * Whether an Ollama server is answering, and which models it has. Never throws.
 * `ELIA_OLLAMA_DETECT=off` skips the network entirely.
 */
export async function detectOllama(options: DetectOptions = {}): Promise<OllamaDetection> {
  const env = options.env ?? process.env
  const host = options.host ?? ollamaHost(env)
  const off = (env.ELIA_OLLAMA_DETECT ?? '').trim().toLowerCase()
  if (off === 'off' || off === '0' || off === 'false') {
    lastDetection = { host, running: false, models: [], error: 'Ollama detection is off (ELIA_OLLAMA_DETECT=off)' }
    return lastDetection
  }
  // Under `bun test` a developer's own Ollama must not change what the suite
  // sees; a test that wants detection names the server it started.
  if (env.NODE_ENV === 'test' && !options.host && !env.OLLAMA_HOST) {
    lastDetection = { host, running: false, models: [], error: 'Ollama detection is skipped under test' }
    return lastDetection
  }
  try {
    assertOllamaHost(host)
  } catch (error) {
    lastDetection = { host, running: false, models: [], error: error instanceof Error ? error.message : String(error) }
    return lastDetection
  }
  let models: OllamaModel[]
  try {
    models = parseTags(await getJson(`${host}/api/tags`, { headers: authHeaders(env.OLLAMA_API_KEY), timeoutMs: options.timeoutMs ?? 1_500 }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lastDetection = { host, running: false, models: [], error: /^HTTP \d/.test(message) ? `Ollama at ${host} answered ${message}` : notRunning(host) }
    return lastDetection
  }
  if (options.details) {
    const detailed = await Promise.all(
      models.slice(0, MAX_DETAILED).map(async (model) => {
        try {
          return { ...model, ...(await showOllamaModel(model.name, { host, apiKey: env.OLLAMA_API_KEY, timeoutMs: 5_000 })) }
        } catch {
          return model
        }
      }),
    )
    models = [...detailed, ...models.slice(MAX_DETAILED)]
  }
  lastDetection = {
    host,
    running: true,
    models,
    ...(models.length === 0 ? { error: 'Ollama is running but has no models yet — pull one first, e.g. `ollama pull qwen3`' } : {}),
  }
  return lastDetection
}

/** True, false, or undefined when the server did not report capabilities (Ollama before they existed). */
export function supportsTools(model: Pick<OllamaModel, 'capabilities'>): boolean | undefined {
  return model.capabilities ? model.capabilities.includes('tools') : undefined
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

function formatTokens(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens)
}

/** One line for a picker: "8.2B · Q4_K_M · 5.2 GB · tools · 40k context", with what stops elia using it said plainly. */
export function describeOllamaModel(model: OllamaModel): string {
  const parts = [model.parameterSize, model.quantization, model.sizeBytes ? formatBytes(model.sizeBytes) : undefined].filter(Boolean) as string[]
  const tools = supportsTools(model)
  if (tools === true) parts.push('tools')
  if (tools === false) parts.push('no tool calling — elia can talk with it but cannot act')
  if (model.capabilities?.includes('thinking')) parts.push('thinking')
  if (model.capabilities?.includes('vision')) parts.push('vision')
  if (model.contextLength) {
    parts.push(model.contextLength < MIN_USABLE_CONTEXT ? `${formatTokens(model.contextLength)} context — too small for elia's prompt` : `${formatTokens(model.contextLength)} context`)
  }
  return parts.join(' · ') || 'local model'
}

/** Picker order: models that can run elia's tools first, then unknown, then the ones that cannot. */
export function rankOllamaModels(models: readonly OllamaModel[]): OllamaModel[] {
  const score = (model: OllamaModel) => {
    const tools = supportsTools(model)
    const tooSmall = model.contextLength !== undefined && model.contextLength < MIN_USABLE_CONTEXT
    return (tools === true ? 0 : tools === undefined ? 1 : 2) + (tooSmall ? 2 : 0)
  }
  return [...models].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
}

/** Why `model` is a poor choice for elia, or undefined when nothing is known against it. */
export function ollamaModelWarning(model: OllamaModel): string | undefined {
  if (supportsTools(model) === false) return `${model.name} cannot call tools, so elia can talk with it but cannot read, edit or run anything. Pick a model marked "tools" for real work.`
  if (model.contextLength !== undefined && model.contextLength < MIN_USABLE_CONTEXT) {
    return `${model.name} holds ${formatTokens(model.contextLength)} tokens, less than elia's ~17k-token prompt plus a conversation. Expect it to lose its instructions.`
  }
  return undefined
}

/** `ELIA_OLLAMA_NUM_CTX`, when it is a sensible positive integer. */
export function numCtxOverride(env: Record<string, string | undefined> = process.env): number | undefined {
  const value = Number.parseInt(env.ELIA_OLLAMA_NUM_CTX?.trim() ?? '', 10)
  return Number.isFinite(value) && value >= 2_048 ? value : undefined
}

const GIB = 1024 ** 3

export interface MemoryFitInput {
  kvBytesPerToken?: number
  /** The model's size on disk, which is about what its weights take loaded. */
  modelBytes?: number
  totalMemoryBytes: number
  /** Apple silicon: the GPU draws on system memory, so its size is known here. */
  unifiedMemory: boolean
}

/**
 * The largest window this machine's memory holds beside the model, in steps of
 * 8k tokens, or undefined when that cannot be worked out. Only on unified
 * memory, where Metal lets the GPU use about two thirds of RAM (three quarters
 * from 36 GB); a discrete GPU's free VRAM is not visible from here. 2 GB stays
 * free for Ollama's compute buffers, so a fit never spills layers to the CPU.
 */
export function memoryFitNumCtx(input: MemoryFitInput): number | undefined {
  if (!input.unifiedMemory || !input.kvBytesPerToken || !input.modelBytes) return undefined
  const gpuShare = input.totalMemoryBytes >= 36 * GIB ? 0.75 : 0.66
  const free = input.totalMemoryBytes * gpuShare - input.modelBytes - 2 * GIB
  if (free <= 0) return undefined
  return Math.floor(free / input.kvBytesPerToken / 8_192) * 8_192
}

/**
 * The window to run a `contextLength`-limited model at: the override, else what
 * memory holds (`fitted`, between DEFAULT_NUM_CTX and MAX_AUTO_NUM_CTX), else
 * DEFAULT_NUM_CTX — never more than the model's own maximum.
 */
export function chooseNumCtx(contextLength: number | undefined, env: Record<string, string | undefined> = process.env, fitted?: number): number {
  const override = numCtxOverride(env)
  if (override !== undefined) return override
  const cap = fitted !== undefined ? Math.min(MAX_AUTO_NUM_CTX, Math.max(DEFAULT_NUM_CTX, fitted)) : DEFAULT_NUM_CTX
  return contextLength !== undefined ? Math.min(contextLength, cap) : cap
}

/**
 * How long Ollama keeps the model loaded after a request: `ELIA_OLLAMA_KEEP_ALIVE`,
 * else 30 minutes. Ollama's own 5 minutes is shorter than a person reading a
 * diff, and reloading a model costs seconds to minutes. A bare number is seconds
 * (`-1` keeps it loaded, `0` unloads it), as Ollama reads it.
 */
export function ollamaKeepAlive(env: Record<string, string | undefined> = process.env): string | number {
  const raw = env.ELIA_OLLAMA_KEEP_ALIVE?.trim()
  if (!raw) return '30m'
  return /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw
}

/** Requests one Ollama server runs at once: its `OLLAMA_NUM_PARALLEL` when set here too, else 1. */
export function ollamaParallelSlots(env: Record<string, string | undefined> = process.env): number {
  const value = Number.parseInt(env.OLLAMA_NUM_PARALLEL?.trim() ?? '', 10)
  return Number.isFinite(value) && value >= 1 ? value : 1
}

/**
 * Specialist tools a local model is not offered in dev mode. Their definitions
 * were ~12k of the ~17k tokens of tools on every request, which a local model
 * reads at a few hundred tokens a second. The core — files, search, shell,
 * processes, plan, memory, web — stays, and a call to an omitted tool is
 * answered with the tools that exist. `ELIA_OLLAMA_TOOLS=full` offers them all.
 */
export const LOCAL_MODEL_OMITTED_TOOLS: ReadonlySet<string> = new Set([
  'github', 'task', 'preview', 'codex_delegate', 'communication', 'deployment', 'finance', 'paper', 'knowledge', 'visualize',
  'data_science', 'fitness', 'sports', 'federated_collab', 'codebase_memory', 'arch_drift', 'cross_project_learn',
  'causal_debug', 'causal_fix', 'causal_verify', 'multi_modal_review', 'adversarial_verify', 'self_healing_monitor',
  'spec_verify', 'predictive_impact', 'temporal_analysis', 'dependency_audit', 'production_readiness', 'provision_environment',
])

/** What a local model is not offered right now: nothing outside dev mode, whose other modes are built on these tools. */
export function ollamaOmittedTools(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  const setting = env.ELIA_OLLAMA_TOOLS?.trim().toLowerCase()
  if (setting === 'full' || setting === 'all') return new Set()
  return activeMode() === 'dev' ? LOCAL_MODEL_OMITTED_TOOLS : new Set()
}

const slotsByHost = new Map<string, { active: number; waiting: Array<() => void> }>()

/** Waits for one of `limit` request slots on `host`; resolves to its release. Rejects if `signal` aborts while waiting. */
export async function acquireOllamaSlot(host: string, limit: number, signal?: AbortSignal): Promise<() => void> {
  let slots = slotsByHost.get(host)
  if (!slots) slotsByHost.set(host, (slots = { active: 0, waiting: [] }))
  const state = slots
  if (state.active >= limit) {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        state.waiting.splice(state.waiting.indexOf(wake), 1)
        reject(signal?.reason ?? new Error('aborted'))
      }
      state.waiting.push(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  // A woken waiter inherits the releasing request's slot; only a fresh one takes a new one.
  else state.active++
  let released = false
  return () => {
    if (released) return
    released = true
    const next = state.waiting.shift()
    if (next) next()
    else state.active--
  }
}

// ---------------------------------------------------------------------------
// The chat adapter
// ---------------------------------------------------------------------------

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
  /** Which tool a `tool` message answers. Newer Ollama templates use it; older ones ignore unknown fields. */
  tool_name?: string
}

/**
 * elia's history into Ollama's. Tool results answer the assistant message just
 * before them, so they go first in a user turn, then anything the person typed
 * alongside. Ollama tool calls carry no id, so each result names its tool.
 * Thinking is not replayed: Ollama models reason afresh each step.
 */
export function toOllamaMessages(system: string, messages: readonly ChatMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: system }]
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map((block) => block.text).join('')
      const calls = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      for (const call of calls) toolNames.set(call.id, call.name)
      out.push({
        role: 'assistant',
        content: text,
        ...(calls.length > 0 ? { tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.input } })) } : {}),
      })
      continue
    }
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      const name = toolNames.get(block.tool_use_id)
      out.push({ role: 'tool', content: block.is_error ? `Error: ${block.content}` : block.content, ...(name ? { tool_name: name } : {}) })
    }
    const text = message.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map((block) => block.text).join('')
    const images = message.content.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image').map((block) => block.data)
    if (text || images.length > 0) out.push({ role: 'user', content: text, ...(images.length > 0 ? { images } : {}) })
  }
  return out
}

function toOllamaTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }))
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // A malformed argument string is an empty call the model can retry, not a crashed turn.
    }
  }
  return {}
}

/**
 * How long a started response may stay silent. Longer than for a hosted API:
 * a local model can spend minutes loading from disk and reading a 17k-token
 * prompt before its first token, and none of that is a stall.
 */
export function ollamaIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.ELIA_STREAM_IDLE_MS ? streamIdleMs(env) : 600_000
}

export interface OllamaProviderOptions {
  thinking?: ThinkingOption
  apiKey?: string
  /** A fixed window; otherwise `chooseNumCtx` from the model's own maximum. */
  numCtx?: number
}

let callSequence = 0

export function createOllamaProvider(model: string, host: string = ollamaHost(), options: OllamaProviderOptions = {}): Provider {
  const base = assertOllamaHost(host).toString().replace(/\/+$/, '')
  const headers = { 'Content-Type': 'application/json', ...authHeaders(options.apiKey) }
  let numCtx = options.numCtx ?? chooseNumCtx(undefined)
  let capabilities: string[] | undefined
  const keepAlive = ollamaKeepAlive()
  const local = isLoopback(base)
  // Compaction must plan for this window from the first turn; `/api/show` may lower it.
  declareContextWindow(model, numCtx)
  // Running on this machine: no API price, so $0 rather than "cost unknown" — unless the
  // server is remote, where someone may well be paying for it.
  if (local) declareLocalModel(model)

  /** The model's size on disk, for the memory fit; only a server on this machine shares its memory. */
  const modelBytes = async (): Promise<number | undefined> => {
    if (!local) return undefined
    const known = cachedOllamaDetection()?.models.find((entry) => entry.name === model)?.sizeBytes
    if (known) return known
    try {
      return parseTags(await getJson(`${base}/api/tags`, { headers, timeoutMs: 5_000 })).find((entry) => entry.name === model)?.sizeBytes
    } catch {
      return undefined
    }
  }

  let info: Promise<void> | undefined
  const ensureInfo = () => {
    info ??= Promise.all([showOllamaModel(model, { host: base, apiKey: options.apiKey, timeoutMs: 10_000 }), modelBytes()])
      .then(([shown, bytes]) => {
        capabilities = shown.capabilities
        const fitted = memoryFitNumCtx({
          kvBytesPerToken: shown.kvBytesPerToken,
          modelBytes: bytes,
          totalMemoryBytes: totalmem(),
          unifiedMemory: local && process.platform === 'darwin' && process.arch === 'arm64',
        })
        if (options.numCtx === undefined) numCtx = chooseNumCtx(shown.contextLength, process.env, fitted)
        declareContextWindow(model, numCtx)
      })
      .catch(() => {
        // Unknown capabilities: run with the default window and let the request say what is wrong.
      })
    return info
  }

  /** `think` only where the model has it; a model without thinking rejects the field. */
  const thinkField = (): Record<string, boolean> => {
    if (!capabilities?.includes('thinking')) return {}
    if (options.thinking && !options.thinking.enabled) return { think: false }
    return { think: true }
  }

  async function post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body), signal })
    } catch (error) {
      if (signal.aborted) throw error
      throw new Error(notRunning(base))
    }
    if (response.ok) return response
    const detail = await errorDetail(response)
    if (response.status === 404) throw new Error(`Ollama has no model "${model}" (404 not found${detail}) — run \`ollama pull ${model}\`, or pick another with /model ollama`)
    throw new Error(`Ollama returned HTTP ${response.status}${detail}`)
  }

  return {
    omitTools: () => ollamaOmittedTools(),

    prewarm() {
      // Loading a model from disk takes seconds to minutes; an empty chat loads
      // it (with the same num_ctx, or the first real request would reload it)
      // while the person is still typing. Failures are the first request's to report.
      void ensureInfo()
        .then(() => fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [], options: { num_ctx: numCtx }, keep_alive: keepAlive }) }))
        .then((response) => response.body?.cancel())
        .catch(() => {})
    },

    async streamTurn({ system, systemDynamic, messages, tools, onText, onThinking, onToolBlock, signal }: StreamTurnParams) {
      await ensureInfo()
      const fullSystem = systemDynamic && systemDynamic.trim() ? `${system}\n\n${systemDynamic}` : system
      // Before the stall clock starts: time spent queued behind another request is not a stall.
      const release = await acquireOllamaSlot(base, ollamaParallelSlots(), signal)
      const idleMs = ollamaIdleMs()
      const stall = new AbortController()
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const stillAlive = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => stall.abort(), idleMs)
      }
      stillAlive()
      const requestSignal = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal

      const turn = ++callSequence
      let text = ''
      let thinking = ''
      const calls: Extract<ContentBlock, { type: 'tool_use' }>[] = []
      const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

      const handle = (chunk: Record<string, unknown>) => {
        if (typeof chunk.error === 'string') throw new Error(`Ollama: ${chunk.error}`)
        const message = chunk.message && typeof chunk.message === 'object' ? (chunk.message as Record<string, unknown>) : undefined
        if (message) {
          if (typeof message.thinking === 'string' && message.thinking) {
            thinking += message.thinking
            onThinking?.(message.thinking)
          }
          if (typeof message.content === 'string' && message.content) {
            text += message.content
            onText(message.content)
          }
          if (Array.isArray(message.tool_calls)) {
            for (const raw of message.tool_calls) {
              const fn = raw && typeof raw === 'object' ? (raw as { function?: { name?: unknown; arguments?: unknown } }).function : undefined
              if (!fn || typeof fn.name !== 'string' || !fn.name) continue
              const block = { type: 'tool_use' as const, id: `ollama_${turn}_${calls.length}`, name: fn.name, input: parseArguments(fn.arguments) }
              calls.push(block)
              onToolBlock?.(block)
            }
          }
        }
        if (chunk.done === true) {
          if (typeof chunk.prompt_eval_count === 'number') usage.inputTokens = chunk.prompt_eval_count
          if (typeof chunk.eval_count === 'number') usage.outputTokens = chunk.eval_count
        }
      }

      try {
        const response = await post(
          {
            model,
            messages: toOllamaMessages(fullSystem, messages),
            ...(tools.length > 0 ? { tools: toOllamaTools(tools) } : {}),
            stream: true,
            options: { num_ctx: numCtx },
            keep_alive: keepAlive,
            ...thinkField(),
          },
          requestSignal,
        )
        if (!response.body) throw new Error('Ollama returned no response body')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          stillAlive()
          pending += decoder.decode(value, { stream: true })
          let newline = pending.indexOf('\n')
          while (newline >= 0) {
            const line = pending.slice(0, newline).trim()
            pending = pending.slice(newline + 1)
            if (line) {
              let chunk: unknown
              try {
                chunk = JSON.parse(line)
              } catch {
                // A torn or non-JSON line must not kill an otherwise-finished
                // turn; every other streaming adapter skips the bad line.
                continue
              }
              handle(chunk as Record<string, unknown>)
            }
            newline = pending.indexOf('\n')
          }
        }
        const last = (pending + decoder.decode()).trim()
        if (last) {
          let chunk: unknown
          try {
            chunk = JSON.parse(last)
          } catch {
            // Same guard as the per-line parse above: the flushed tail of a
            // streamed response may be torn mid-write.
            chunk = undefined
          }
          if (chunk !== undefined) handle(chunk as Record<string, unknown>)
        }
      } catch (error) {
        // Worded to read as a timeout, which is what routes to the next provider.
        if (stall.signal.aborted && !signal?.aborted) throw new Error(`response stalled: nothing arrived from Ollama for ${Math.round(idleMs / 1000)}s (timed out)`)
        throw error
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        release()
      }

      const content: ContentBlock[] = []
      if (thinking && (options.thinking?.enabled ?? true)) content.push({ type: 'thinking', text: thinking, signature: '' })
      if (text) content.push({ type: 'text', text })
      content.push(...calls)
      return { content, usage }
    },
  }
}
