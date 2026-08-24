import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import { EventEmitter } from 'node:events'

export type BridgeMethod =
  | 'chat.send'
  | 'autonomous.start'
  | 'autonomous.approve'
  | 'autonomous.control'
  | 'tasks.list'
  | 'task.control'
  | 'runs.list'
  | 'runs.inspect'
  | 'skills.list'
  | 'git.diff'
  | 'environment.inspect'
  | 'deployment.run'
  | 'shutdown'

export interface BridgeEvent {
  event: string
  data: Record<string, unknown>
}

interface BridgeResponse {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export interface BridgeClientOptions {
  workspaceRoot: string
  cliPath: string
  runtime: 'auto' | 'bun' | 'node'
  onEvent?: (event: BridgeEvent) => void
  onStderr?: (message: string) => void
}

export class EliaBridgeClient extends EventEmitter {
  private readonly options: BridgeClientOptions
  private child?: ChildProcessWithoutNullStreams
  private stdout?: readline.Interface
  private readonly pending = new Map<string, PendingRequest>()
  private started?: Promise<void>
  private stopped = false

  constructor(options: BridgeClientOptions) {
    super()
    this.options = options
  }

  async start(): Promise<void> {
    if (this.child) return
    if (this.started) return this.started
    this.started = new Promise<void>((resolve, reject) => {
      const launch = this.launchCommand()
      const child = spawn(launch.command, launch.args, {
        cwd: this.options.workspaceRoot,
        env: { ...process.env, ELIA_UI_MODE: 'json', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child
      child.once('error', (error) => {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)))
        if (!this.started) reject(error)
        this.emitEvent('bridge_error', { message: error.message })
      })
      child.once('spawn', () => {
        resolve()
        this.emitEvent('bridge_started', { command: launch.command, args: launch.args })
      })
      child.once('exit', (code, signal) => {
        this.child = undefined
        this.stdout?.close()
        this.stdout = undefined
        const detail = `Elia bridge exited${code === null ? ` by ${signal ?? 'signal'}` : ` with code ${code}`}`
        this.emitEvent('bridge_exit', { code, signal, message: detail })
        this.rejectAll(new Error(detail))
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        const message = String(chunk).trim()
        if (message) this.options.onStderr?.(message)
      })
      this.stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      this.stdout.on('line', (line) => this.consumeLine(line))
    })
    return this.started
  }

  async request(method: BridgeMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.stopped) throw new Error('Elia bridge is stopped')
    await this.start()
    const child = this.child
    if (!child || !child.stdin.writable) throw new Error('Elia bridge stdin is not writable')
    const id = randomUUID()
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return promise
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.stopped = true
      return
    }
    try {
      await this.request('shutdown')
    } catch {
      // The child may already be exiting.
    }
    this.stopped = true
    this.child.kill()
    this.child = undefined
    this.stdout?.close()
    this.stdout = undefined
    this.rejectAll(new Error('Elia bridge stopped'))
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.emitEvent('bridge_output', { message: line.slice(0, 4_000) })
      return
    }
    if (isResponse(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error ?? 'Elia bridge request failed'))
      return
    }
    if (isBridgeEvent(message)) {
      this.emitEvent(message.event, message.data ?? {})
      return
    }
    if (isNativeEvent(message)) {
      const { type, ...data } = message
      this.emitEvent(type, data)
      return
    }
    this.emitEvent('bridge_output', { message: JSON.stringify(message).slice(0, 4_000) })
  }

  private emitEvent(event: string, data: Record<string, unknown>): void {
    const value = { event, data }
    this.options.onEvent?.(value)
    this.emit('event', value)
    this.emit(event, data)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private launchCommand(): { command: string; args: string[] } {
    const configured = this.options.cliPath.trim() || 'elia'
    const looksLikeTypeScript = configured.endsWith('.ts') || configured.endsWith('.mts')
    if (looksLikeTypeScript) {
      if (this.options.runtime === 'node') return { command: 'node', args: [configured, 'bridge', '--json'] }
      return { command: 'bun', args: [configured, 'bridge', '--json'] }
    }
    return { command: configured, args: ['bridge', '--json'] }
  }
}

function isResponse(value: unknown): value is BridgeResponse {
  if (!isRecord(value)) return false
  return value.type === 'response' && typeof value.id === 'string' && typeof value.ok === 'boolean'
}

function isBridgeEvent(value: unknown): value is { type: 'event'; event: string; data?: Record<string, unknown> } {
  if (!isRecord(value)) return false
  return value.type === 'event' && typeof value.event === 'string'
}

function isNativeEvent(value: unknown): value is { type: string; [key: string]: unknown } {
  return isRecord(value) && typeof value.type === 'string'
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
