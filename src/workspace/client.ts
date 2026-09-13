/**
 * `WorkspaceClient` — a thin JSON-RPC-over-WebSocket client for the workspace
 * server, used by the CLI and by agent runtimes.
 *
 * It multiplexes request/response by id over one socket and delivers the
 * server's pushed event stream to a listener. Mirrors the shape of
 * `src/daemon/client.ts`, minus the auto-spawn (the CLI decides whether to
 * start a local server — see cli.ts).
 */

import { WORKSPACE_PROTOCOL_VERSION, type WorkspaceRpcMethod, type WorkspaceServerMessage } from './protocol.ts'
import type { PersistedEvent } from './events.ts'

export class WorkspaceClientError extends Error {}

export interface WorkspaceHelloInfo {
  protocol: number
  caller: { kind: 'member' | 'agent'; id: string; name: string; role: string }
  latestSeq: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface WorkspaceClientOptions {
  url: string
  token: string
  onEvent?: (event: PersistedEvent) => void
  onClose?: (code: number, reason: string) => void
}

export class WorkspaceClient {
  private ws: WebSocket | undefined
  private nextId = 1
  private readonly pending = new Map<string, Pending>()
  private helloResolve: ((info: WorkspaceHelloInfo) => void) | undefined
  private helloReject: ((error: Error) => void) | undefined
  private helloTimer: ReturnType<typeof setTimeout> | undefined
  hello: WorkspaceHelloInfo | undefined

  private constructor(private readonly options: WorkspaceClientOptions) {}

  static async connect(options: WorkspaceClientOptions, timeoutMs = 8_000): Promise<WorkspaceClient> {
    const client = new WorkspaceClient(options)
    await client.open(timeoutMs)
    return client
  }

  private open(timeoutMs: number): Promise<WorkspaceHelloInfo> {
    // Header only (Bun's WebSocket honours a `headers` init) — the server
    // refuses a ?token= query string, which would leak into logs.
    const ws = new WebSocket(this.options.url, { headers: { Authorization: `Bearer ${this.options.token}` } } as never)
    this.ws = ws

    return new Promise<WorkspaceHelloInfo>((resolve, reject) => {
      this.helloResolve = resolve
      this.helloReject = reject
      const timer = setTimeout(() => {
        // The open timeout is only about waiting for `hello`. Timing it out
        // must not also strand the socket: reject the pending open and let the
        // close handler settle the connection.
        clearTimeout(this.helloTimer)
        this.helloResolve = undefined
        this.helloReject = undefined
        try {
          ws.close(1000, 'hello timeout')
        } catch {
          /* already closing */
        }
        reject(new WorkspaceClientError('workspace server did not send hello within timeout'))
      }, timeoutMs)
      this.helloTimer = timer

      ws.addEventListener('open', () => {
        // Wait for `hello` rather than resolving here.
      })
      ws.addEventListener('message', (event) => {
        this.onMessage(typeof event.data === 'string' ? event.data : '')
      })
      ws.addEventListener('error', () => {
        clearTimeout(this.helloTimer)
        const error = new WorkspaceClientError(`cannot reach workspace server at ${this.options.url}`)
        this.failAll(error)
        this.helloReject?.(error)
      })
      ws.addEventListener('close', (event) => {
        clearTimeout(this.helloTimer)
        const error = new WorkspaceClientError(`workspace connection closed (${event.code})`)
        this.failAll(error)
        this.helloReject?.(error)
        this.options.onClose?.(event.code, String(event.reason ?? ''))
      })
    })
  }

  private onMessage(raw: string): void {
    if (!raw) return
    let message: WorkspaceServerMessage
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.type === 'hello') {
      this.hello = { protocol: message.protocol, caller: message.caller, latestSeq: message.latestSeq }
      if (message.protocol !== WORKSPACE_PROTOCOL_VERSION) {
        clearTimeout(this.helloTimer)
        const rejectHello = this.helloReject
        this.helloResolve = undefined
        this.helloReject = undefined
        rejectHello?.(new WorkspaceClientError(`server protocol ${message.protocol}, client expects ${WORKSPACE_PROTOCOL_VERSION}`))
        return
      }
      clearTimeout(this.helloTimer)
      this.helloResolve?.(this.hello)
      return
    }
    if (message.type === 'event') {
      this.options.onEvent?.(message.event)
      return
    }
    if (message.type === 'response') {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(new WorkspaceClientError(message.error ?? 'workspace RPC failed'))
    }
  }

  call<T = unknown>(method: WorkspaceRpcMethod, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new WorkspaceClientError('workspace client is not connected'))
    const id = `req_${this.nextId++}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new WorkspaceClientError(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    try {
      this.ws?.close(1000, 'client done')
    } catch {
      /* already closing */
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}
