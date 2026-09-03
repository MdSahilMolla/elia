import type { PipedSubprocess } from 'bun'
import { readBoundedOutput } from '../shell.ts'
import type { ProviderActivity, Usage } from './types.ts'

const CONNECT_TIMEOUT_MS = 10_000
// Starting a thread or a turn can involve a model-catalogue fetch and cold
// process work on the Codex side; 10s (the request default) is too tight and
// surfaced as spurious turn failures and retries. The turn itself keeps the
// long ceiling.
const TURN_SETUP_TIMEOUT_MS = 60_000
const TURN_TIMEOUT_MS = 10 * 60_000
const MAX_STDERR_LENGTH = 20_000
const MAX_ACTIVITY_DETAIL_LENGTH = 8_000
// Codex streams command stdout/stderr in fine-grained deltas. One activity per
// line floods the transcript (a single `bun test` is hundreds of lines), so
// each command's output is buffered to a rolling window and surfaced once, as a
// bounded tail digest when the command finishes — the shape Elia already uses
// for its own `run_command`.
const COMMAND_OUTPUT_WINDOW_CHARS = 16_000
const COMMAND_OUTPUT_TAIL_LINES = 12
const COMMAND_OUTPUT_TAIL_CHARS = 1_400
// The cumulative workspace diff is re-sent on every keystroke Codex makes.
// Emit it at most this often while the turn runs, then force the final one.
const DIFF_MIN_INTERVAL_MS = 3_000

type RequestId = number | string
type Message = Record<string, unknown>
type Listener = (message: Message) => void

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

export interface CodexTurnOptions {
  threadId: string
  text: string
  cwd: string
  model?: string
  onText(delta: string): void
  onThinking?(delta: string): void
  onActivity?(activity: ProviderActivity): void
  signal?: AbortSignal
}

export interface CodexTurnResult {
  text: string
  usage: Usage
}

/** Persistent line-delimited JSON-RPC client for the installed Codex app-server. */
export class CodexAppServerClient {
  private proc: PipedSubprocess | undefined
  private nextId = 1
  private pending = new Map<string, Pending>()
  private listeners = new Set<Listener>()
  private buffer = ''
  private closed = false

  constructor(private readonly command = ['codex', 'app-server', '--stdio']) {}

  get isClosed(): boolean {
    return this.closed
  }

  async connect(): Promise<void> {
    if (this.proc && !this.closed) return
    this.closed = false
    this.proc = Bun.spawn(this.command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    void this.pumpStdout().catch(() => {
      // pumpStdout rejects every pending request when the server closes.
    })
    // Drain stderr for the lifetime of the process so a noisy server cannot
    // block on a full pipe. Request errors carry their structured RPC message.
    void readBoundedOutput(this.proc.stderr, MAX_STDERR_LENGTH).catch(() => {})

    try {
      await this.withTimeout(
        this.request('initialize', {
          clientInfo: { name: 'elia', title: 'Elia', version: '0.1.0' },
          capabilities: {},
        }),
        CONNECT_TIMEOUT_MS,
        'Codex app server did not initialize in time',
      )
      this.notify('initialized')
    } catch (error) {
      this.close()
      throw error
    }
  }

  request(method: string, params: unknown, timeoutMs = CONNECT_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error('Codex app server is not connected'))
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject })
      try {
        this.send({ id, method, params })
      } catch (error) {
        this.pending.delete(String(id))
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return this.withTimeout(promise, timeoutMs, `Codex app server timed out handling ${method}`)
  }

  async runTurn(options: CodexTurnOptions): Promise<CodexTurnResult> {
    let turnId: string | undefined
    let streamedText = ''
    let finalText = ''
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const commandOutput = new Map<string, string>()
    let lastPlan = ''
    let lastDiff = ''
    let pendingDiff = ''
    let lastDiffEmitAt = 0
    let resolveCompleted!: (message: Message) => void
    let rejectCompleted!: (error: Error) => void
    const completed = new Promise<Message>((resolve, reject) => {
      resolveCompleted = resolve
      rejectCompleted = reject
    })

    const emit = (activity: ProviderActivity | undefined) => {
      if (activity) options.onActivity?.(activity)
    }
    const appendCommandOutput = (itemId: string, delta: string) => {
      const next = (commandOutput.get(itemId) ?? '') + delta
      commandOutput.set(itemId, next.length > COMMAND_OUTPUT_WINDOW_CHARS ? next.slice(next.length - COMMAND_OUTPUT_WINDOW_CHARS) : next)
    }
    const emitCommandOutput = (itemId: string) => {
      const buffer = commandOutput.get(itemId) ?? commandOutput.get('command')
      commandOutput.delete(itemId)
      commandOutput.delete('command')
      if (buffer && buffer.trim()) {
        emit({ kind: 'command_output', title: 'Command output', detail: tailLines(buffer, COMMAND_OUTPUT_TAIL_LINES, COMMAND_OUTPUT_TAIL_CHARS), status: 'updated' })
      }
    }
    const emitDiff = (diff: string, force: boolean) => {
      if (!diff || diff === lastDiff) return
      if (!force && Date.now() - lastDiffEmitAt < DIFF_MIN_INTERVAL_MS) {
        pendingDiff = diff
        return
      }
      lastDiff = diff
      pendingDiff = ''
      lastDiffEmitAt = Date.now()
      emit({ kind: 'diff', title: 'Workspace diff updated', detail: diff, status: 'updated' })
    }

    const removeListener = this.onMessage((message) => {
      const method = typeof message.method === 'string' ? message.method : ''
      const params = isObject(message.params) ? message.params : undefined
      if (!params) return
      if (typeof params.threadId === 'string' && params.threadId !== options.threadId) return
      const messageTurnId = typeof params.turnId === 'string'
        ? params.turnId
        : isObject(params.turn) && typeof params.turn.id === 'string' ? params.turn.id : undefined
      if (turnId && messageTurnId && messageTurnId !== turnId) return

      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        streamedText += params.delta
        options.onText(params.delta)
      } else if (method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string') {
        options.onThinking?.(params.delta)
      } else if (method === 'item/commandExecution/outputDelta' && typeof params.delta === 'string') {
        appendCommandOutput(typeof params.itemId === 'string' ? params.itemId : 'command', params.delta)
      } else if (method === 'item/started' && isObject(params.item)) {
        emit(activityForItem(params.item, false))
      } else if (method === 'item/completed' && isObject(params.item)) {
        const item = params.item
        const itemId = typeof item.id === 'string' ? item.id : 'command'
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          finalText = item.text
        } else if (item.type === 'commandExecution') {
          emitCommandOutput(itemId)
          emit(activityForItem(item, true))
        } else {
          emit(activityForItem(item, true))
        }
      } else if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
        const plan = formatPlan(params.plan, typeof params.explanation === 'string' ? params.explanation : undefined)
        if (plan && plan !== lastPlan) {
          lastPlan = plan
          emit({ kind: 'plan', title: 'Plan updated', detail: plan, status: 'updated' })
        }
      } else if (method === 'turn/diff/updated' && typeof params.diff === 'string') {
        emitDiff(boundText(params.diff, MAX_ACTIVITY_DETAIL_LENGTH), false)
      } else if (method === 'warning' && typeof params.message === 'string') {
        emit({ kind: 'warning', title: 'Codex warning', detail: params.message, status: 'warning' })
      } else if (method === 'configWarning') {
        const summary = typeof params.summary === 'string' ? params.summary : 'Codex configuration warning'
        emit({ kind: 'warning', title: summary, detail: typeof params.details === 'string' ? params.details : undefined, status: 'warning' })
      } else if (method === 'model/rerouted') {
        const from = typeof params.fromModel === 'string' ? params.fromModel : 'selected model'
        const to = typeof params.toModel === 'string' ? params.toModel : 'another model'
        emit({ kind: 'model', title: `Model rerouted: ${from} → ${to}`, detail: typeof params.reason === 'string' ? params.reason : undefined, status: 'updated' })
      } else if (method === 'model/safetyBuffering/updated') {
        emit({ kind: 'model', title: params.showBufferingUi === true ? 'Model safety buffering' : 'Model safety buffering cleared', detail: stringList(params.reasons), status: 'updated' })
      } else if (method === 'model/verification') {
        emit({ kind: 'model', title: 'Model verification required', detail: safeJson(params.verifications), status: 'warning' })
      } else if (method === 'hook/started' || method === 'hook/completed') {
        emit({ kind: 'status', title: method === 'hook/started' ? 'Codex hook started' : 'Codex hook completed', detail: safeJson(params.run), status: method === 'hook/started' ? 'started' : 'completed' })
      } else if (method === 'serverRequest/resolved') {
        emit({ kind: 'status', title: 'Codex request resolved', status: 'completed' })
      } else if (method === 'thread/tokenUsage/updated' && isObject(params.tokenUsage) && isObject(params.tokenUsage.last)) {
        usage = usageFrom(params.tokenUsage.last)
      } else if (method === 'turn/completed' && isObject(params.turn)) {
        for (const itemId of [...commandOutput.keys()]) emitCommandOutput(itemId)
        if (pendingDiff) emitDiff(pendingDiff, true)
        resolveCompleted(params.turn)
      } else if (method === 'error') {
        const error = isObject(params.error) && typeof params.error.message === 'string'
          ? params.error.message
          : typeof params.message === 'string' ? params.message : 'Codex app server reported a turn error'
        emit({ kind: 'warning', title: 'Codex error', detail: error, status: 'failed' })
        rejectCompleted(new Error(error))
      }
    })

    const interrupt = () => {
      if (!turnId) return
      void this.request('turn/interrupt', { threadId: options.threadId, turnId }).catch(() => {})
    }
    options.signal?.addEventListener('abort', interrupt, { once: true })

    try {
      if (options.signal?.aborted) throw new Error('Codex request cancelled')
      emit({ kind: 'turn', title: 'Starting Codex turn', status: 'started' })
      const start = await this.request('turn/start', {
        threadId: options.threadId,
        input: [{ type: 'text', text: options.text }],
        cwd: options.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [options.cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        ...(options.model && options.model !== 'default' ? { model: options.model } : {}),
      }, TURN_SETUP_TIMEOUT_MS)
      if (!isObject(start) || !isObject(start.turn) || typeof start.turn.id !== 'string') {
        throw new Error('Codex app server returned no turn id')
      }
      turnId = start.turn.id
      if (options.signal?.aborted) interrupt()

      const turn = await this.withTimeout(completed, TURN_TIMEOUT_MS, 'Codex subscription turn timed out')
      const status = typeof turn.status === 'string' ? turn.status : 'failed'
      if (options.signal?.aborted || status === 'interrupted') throw new Error('Codex request cancelled')
      if (status !== 'completed') {
        const error = isObject(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : `Codex turn ended with status ${status}`
        throw new Error(error)
      }

      emit({ kind: 'turn', title: 'Codex turn completed', status: 'completed' })

      const text = streamedText || finalText || finalAgentText(turn)
      if (!text) throw new Error('Codex returned no response')
      if (!streamedText) options.onText(text)
      return { text, usage }
    } finally {
      options.signal?.removeEventListener('abort', interrupt)
      removeListener()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('Codex app server closed'))
    this.pending.clear()
    this.listeners.clear()
    try {
      this.proc?.kill()
    } catch {
      // Best effort: the child may already have exited.
    }
  }

  async closeAndWait(): Promise<void> {
    const proc = this.proc
    this.close()
    if (proc) await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed || !this.proc) return
    try {
      this.send(params === undefined ? { method } : { method, params })
    } catch {
      // Notifications are best effort and have no response to reject.
    }
  }

  private send(message: Message): void {
    if (this.closed || !this.proc) throw new Error('Codex app server is not connected')
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
    this.proc.stdin.flush()
  }

  private onMessage(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async pumpStdout(): Promise<void> {
    if (!this.proc) return
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newline).trim()
          this.buffer = this.buffer.slice(newline + 1)
          if (line) this.handleLine(line)
        }
      }
    } finally {
      this.closed = true
      const pending = [...this.pending.values()]
      this.pending.clear()
      for (const item of pending) item.reject(new Error('Codex app server closed its stdout'))
    }
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!isObject(message)) return

    if ((typeof message.id === 'number' || typeof message.id === 'string') && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(String(message.id))
      if (!pending) return
      this.pending.delete(String(message.id))
      if (isObject(message.error)) pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'Codex app server rejected the request'))
      else pending.resolve(message.result)
      return
    }

    if ((typeof message.id === 'number' || typeof message.id === 'string') && typeof message.method === 'string') {
      this.resolveServerRequest(message.id, message.method)
      return
    }

    if (typeof message.method === 'string') {
      for (const listener of this.listeners) listener(message)
    }
  }

  private resolveServerRequest(id: RequestId, method: string): void {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval' || method === 'execCommandApproval') {
      this.send({ id, result: { decision: 'decline' } })
      return
    }
    this.send({ id, error: { code: -32601, message: `Elia does not expose ${method} through the subscription adapter` } })
  }

  private async withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), milliseconds)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function usageFrom(value: Record<string, unknown>): Usage {
  const input = number(value.inputTokens)
  const cached = number(value.cachedInputTokens)
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: number(value.outputTokens),
    cacheReadTokens: cached,
    cacheWriteTokens: number(value.cacheWriteInputTokens),
  }
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function activityForItem(item: Message, completed: boolean): ProviderActivity | undefined {
  const status = completed
    ? item.status === 'failed' || item.status === 'declined' ? 'failed' : 'completed'
    : 'started'
  const type = typeof item.type === 'string' ? item.type : 'activity'

  if (type === 'commandExecution') {
    const command = renderCommand(item.command)
    const metadata = completed
      ? [typeof item.exitCode === 'number' ? `exit ${item.exitCode}` : undefined, typeof item.durationMs === 'number' ? `${item.durationMs}ms` : undefined].filter(Boolean).join(' · ')
      : typeof item.cwd === 'string' ? `cwd: ${item.cwd}` : ''
    return {
      kind: 'command',
      title: completed ? `Command ${status === 'failed' ? 'failed' : 'completed'}` : 'Running command',
      detail: [command, metadata].filter(Boolean).join('\n'),
      status,
    }
  }

  if (type === 'fileChange') {
    return {
      kind: 'file_change',
      title: completed ? `File changes ${status === 'failed' ? 'failed' : 'completed'}` : 'Changing files',
      detail: formatChanges(item.changes),
      status,
    }
  }

  if (type === 'plan' && typeof item.text === 'string') return { kind: 'plan', title: 'Plan', detail: item.text, status }
  if (type === 'mcpToolCall') return { kind: 'tool', title: `MCP tool: ${string(item.tool) || string(item.server) || 'call'}`, detail: safeJson(item.arguments), status }
  if (type === 'dynamicToolCall') return { kind: 'tool', title: `Tool: ${string(item.tool) || 'dynamic call'}`, detail: safeJson(item.arguments), status }
  if (type === 'collabToolCall') return { kind: 'tool', title: `Collaboration: ${string(item.tool) || 'agent call'}`, detail: string(item.prompt), status }
  if (type === 'webSearch') return { kind: 'tool', title: 'Web search', detail: string(item.query), status }
  if (type === 'imageView') return { kind: 'tool', title: 'Viewing image', detail: string(item.path), status }
  if (type === 'contextCompaction') return { kind: 'status', title: 'Compacting conversation context', status }
  if (type === 'enteredReviewMode') return { kind: 'status', title: 'Review started', detail: string(item.review), status }
  if (type === 'exitedReviewMode') return { kind: 'status', title: 'Review completed', detail: string(item.review), status }
  if (type === 'userMessage' || type === 'agentMessage' || type === 'reasoning') return undefined
  return { kind: 'status', title: `Codex ${type}`, status }
}

function formatPlan(value: unknown[], explanation?: string): string {
  const steps = value.flatMap((candidate) => {
    if (!isObject(candidate) || typeof candidate.step !== 'string') return []
    const marker = candidate.status === 'completed' ? '[done]' : candidate.status === 'inProgress' ? '[active]' : '[pending]'
    return [`${marker} ${candidate.step}`]
  })
  return boundText([explanation, ...steps].filter(Boolean).join('\n'), MAX_ACTIVITY_DETAIL_LENGTH)
}

function formatChanges(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const changes = value.flatMap((candidate) => {
    if (!isObject(candidate)) return []
    const path = string(candidate.path) || 'unknown path'
    const kind = string(candidate.kind) || 'change'
    const diff = string(candidate.diff)
    return [diff ? `${kind}: ${path}\n${diff}` : `${kind}: ${path}`]
  })
  return boundText(changes.join('\n'), MAX_ACTIVITY_DETAIL_LENGTH)
}

function renderCommand(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string').join(' ')
  return ''
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string')
  return items.length > 0 ? items.join(', ') : undefined
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return boundText(JSON.stringify(value), MAX_ACTIVITY_DETAIL_LENGTH)
  } catch {
    return '[unserializable]'
  }
}

function boundText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

/** The last `maxLines` non-trailing-blank lines of `value`, capped at `maxChars` (kept from the end). */
function tailLines(value: string, maxLines: number, maxChars: number): string {
  const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  const kept = lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trimStart()
  return kept.length > maxChars ? `…${kept.slice(kept.length - maxChars + 1)}` : kept
}

function finalAgentText(turn: Message): string {
  if (!Array.isArray(turn.items)) return ''
  const item = [...turn.items].reverse().find((candidate) => isObject(candidate) && candidate.type === 'agentMessage' && typeof candidate.text === 'string')
  return isObject(item) && typeof item.text === 'string' ? item.text : ''
}
