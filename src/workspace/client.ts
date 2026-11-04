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
      // A WebSocket failure carries no usable status. Bun reports a refused
      // upgrade as a close with the reason "Expected 101 status code", which says
      // only that *something* answered; a rejected token and a dead port are
      // indistinguishable from it. So on any failure before `hello`, ask the
      // server what it said. One request, on the failure path only, and the
      // difference between "your token was refused" and "nothing is listening"
      // is the difference between a one-line fix and an afternoon spent looking
      // at the wrong half of the system.
      const refuseWith = (summary: (reason: string) => string) => {
        void this.describeRefusal().then((reason) => {
          const error = new WorkspaceClientError(summary(reason))
          this.failAll(error)
          this.helloReject?.(error)
        })
      }

      ws.addEventListener('error', () => {
        clearTimeout(this.helloTimer)
        refuseWith((reason) => `cannot reach workspace server at ${this.options.url}${reason}`)
      })
      ws.addEventListener('close', (event) => {
        clearTimeout(this.helloTimer)
        const reason = String(event.reason ?? '')
        const settled = (detail: string) => {
          this.failAll(new WorkspaceClientError(detail))
          this.options.onClose?.(event.code, reason)
        }
        if (this.helloReject !== undefined) {
          // Closed before `hello`, so this is a failed open rather than a
          // connection that worked and then ended.
          refuseWith((server) =>
            `workspace connection closed (${event.code}${reason === '' ? '' : `: ${reason}`})${server}`,
          )
          return
        }
        // The reason is carried by the closing side and costs nothing to include.
        // A bare code leaves the reader to look up what 1006 means, which is not
        // a thing anyone should have to do while a system is failing.
        settled(`workspace connection closed (${event.code}${reason === '' ? '' : `: ${reason}`})`)
      })
    })
  }

  /**
   * Asks the server why it would not upgrade, for the error message.
   *
   * Best effort throughout: a server that is simply not there fails this too,
   * and then the original message stands, which is the right thing to say in
   * that case.
   */
  private async describeRefusal(): Promise<string> {
    // The URL is a WebSocket one, and `fetch` refuses `ws:` outright — with an
    // error that says nothing about the server and reads like the server being
    // down. Swapping the scheme is what turns "cannot reach" into the actual
    // status the server returned.
    const url = this.options.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(3_000),
      })
      if (response.status === 401) return ': the server refused this token (401)'
      if (response.status === 403) return ': the server refused this origin (403)'
      if (response.status === 400) return `: ${await response.text()}`
      return `: the server answered ${response.status}`
    } catch {
      return ' (nothing is listening)'
    }
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
