import type { PipedSubprocess } from 'bun'
import { pathToFileURL } from 'node:url'
import { LSP_CLIENT_INFO, type Diagnostic, type PublishDiagnosticsParams } from './protocol.ts'
import { terminateProcessGroup } from '../shell.ts'

const CONNECT_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 15_000

interface Pending {
  resolve(result: unknown): void
  reject(error: Error): void
}

// Bun's FileSink write()/flush()/end() return `number | Promise<number>`. On the
// happy path it's a number; when the peer process has been killed the write can
// fail asynchronously with EPIPE. Nobody awaits these, so an unhandled rejection
// would escape and (under `bun test`) get pinned on whatever test is running.
// Mirrors src/mcp/client.ts's swallow() helper.
function swallow(result: unknown): void {
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
    void Promise.resolve(result).catch(() => {})
  }
}

export function fileUri(path: string): string {
  return pathToFileURL(path).href
}

/**
 * One live connection to a language server over stdio, using LSP's
 * Content-Length-framed JSON-RPC (distinct from MCP's line-delimited framing —
 * see src/mcp/client.ts for that variant of the same request/response bookkeeping).
 */
export class LspClient {
  readonly languageId: string
  private proc: PipedSubprocess | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer: Uint8Array = new Uint8Array(0)
  private closed = false
  private openDocs = new Map<string, number>() // uri -> version
  private diagnostics = new Map<string, Diagnostic[]>()
  private diagnosticsWaiters = new Map<string, (() => void)[]>()

  constructor(
    private readonly command: string,
    private readonly args: string[],
    languageId: string,
    private readonly rootPath: string,
  ) {
    this.languageId = languageId
  }

  async connect(): Promise<void> {
    this.proc = Bun.spawn([this.command, ...this.args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: this.rootPath,
    })
    this.pump().catch(() => {
      // A dead read loop just means every pending/future call now times out and
      // rejects on its own.
    })

    await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: LSP_CLIENT_INFO,
        rootUri: fileUri(this.rootPath),
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: false },
            synchronization: { didSave: false, willSave: false },
          },
        },
      },
      CONNECT_TIMEOUT_MS,
      `LSP server "${this.languageId}" did not respond to initialize within ${CONNECT_TIMEOUT_MS}ms`,
    )
    this.notify('initialized', {})
  }

  /** Opens (or, if already open, replaces the content of) a document and returns its current diagnostics after a bounded wait for the server to (re)publish them. */
  async diagnosticsFor(path: string, text: string, waitMs = 4000): Promise<Diagnostic[]> {
    const uri = fileUri(path)
    const version = (this.openDocs.get(uri) ?? 0) + 1
    this.openDocs.set(uri, version)

    const waiter = this.waitForNextPublish(uri, waitMs)
    if (version === 1) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.languageId, version, text } })
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    }
    await waiter
    return this.diagnostics.get(uri) ?? []
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error(`LSP server "${this.languageId}" closed`))
    this.pending.clear()
    // Release our end of the stdin pipe first. A hard tree-kill (taskkill /F on
    // Windows) yanks the process out from under Bun's still-open FileSink, and
    // Bun then surfaces the dangling write handle as an uncaught EPIPE when it
    // finalizes. Ending the sink ourselves closes that window — but end() can
    // itself reject asynchronously if the pipe is already broken, so swallow
    // both the sync throw and the async rejection.
    try {
      swallow(this.proc?.stdin.end())
    } catch {
      // already gone
    }
    try {
      if (process.platform === 'win32' && this.proc) terminateProcessGroup(this.proc)
      else this.proc?.kill()
    } catch {
      // Best-effort — process may already be gone.
    }
  }

  async closeAndWait(): Promise<void> {
    const proc = this.proc
    this.close()
    if (proc) await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 2000))])
  }

  /** Resolves as soon as a fresh publishDiagnostics arrives for uri, or after waitMs — whichever first. Never rejects. */
  private waitForNextPublish(uri: string, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        const waiters = this.diagnosticsWaiters.get(uri)
        if (waiters) this.diagnosticsWaiters.set(uri, waiters.filter((w) => w !== finish))
        resolve()
      }
      const timer = setTimeout(finish, waitMs)
      const waiters = this.diagnosticsWaiters.get(uri) ?? []
      waiters.push(finish)
      this.diagnosticsWaiters.set(uri, waiters)
    })
  }

  /** `onTimeout`, when given, runs right before the timeout rejects — used to
   * drop the now-abandoned entry from `this.pending` so a request whose id the
   * server never answers doesn't stay allocated forever. */
  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.()
        reject(new Error(message))
      }, ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number, timeoutMessage?: string): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error(`LSP server "${this.languageId}" is not connected`))
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    try {
      this.send({ jsonrpc: '2.0', id, method, params })
    } catch (err) {
      this.pending.delete(id)
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    if (timeoutMs === undefined) return promise
    return this.withTimeout(promise, timeoutMs, timeoutMessage ?? `LSP server "${this.languageId}" timed out waiting for a response`, () => this.pending.delete(id))
  }

  private notify(method: string, params: unknown): void {
    if (this.closed || !this.proc) return
    try {
      this.send({ jsonrpc: '2.0', method, params })
    } catch {
      // Best-effort notification — nothing to reject, no reply is ever expected.
    }
  }

  private send(message: unknown): void {
    if (!this.proc) return
    const body = JSON.stringify(message)
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
    // write()/flush() can reject asynchronously when the child's stdin is
    // already gone (e.g. a request fired in the same tick as close()).
    // Swallow both here — the pending request is rejected by close()/pump()
    // anyway, and an unhandled rejection would otherwise surface as a
    // spurious failure.
    swallow(this.proc.stdin.write(header + body))
    swallow(this.proc.stdin.flush())
  }

  private async pump(): Promise<void> {
    if (!this.proc) return
    const reader = this.proc.stdout.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        this.buffer = concat(this.buffer, value)
        this.drainMessages()
      }
    } finally {
      const stillPending = [...this.pending.values()]
      this.pending.clear()
      for (const pending of stillPending) pending.reject(new Error(`LSP server "${this.languageId}" closed its stdout`))
    }
  }

  private drainMessages(): void {
    while (true) {
      const text = Buffer.from(this.buffer).toString('latin1')
      const headerEnd = text.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const headerText = text.slice(0, headerEnd)
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText)
      if (!lengthMatch) {
        // Malformed frame — drop everything buffered so far rather than spin forever.
        this.buffer = new Uint8Array(0)
        return
      }
      const contentLength = Number(lengthMatch[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + contentLength) return // wait for more data

      const bodyBytes = this.buffer.slice(bodyStart, bodyStart + contentLength)
      this.buffer = this.buffer.slice(bodyStart + contentLength)
      this.handleMessage(Buffer.from(bodyBytes).toString('utf8'))
    }
  }

  private handleMessage(json: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }
    try {
      message = JSON.parse(json)
    } catch {
      return
    }

    if (typeof message.method === 'string') {
      if (message.method === 'textDocument/publishDiagnostics') {
        const params = message.params as PublishDiagnosticsParams
        this.diagnostics.set(params.uri, params.diagnostics)
        for (const waiter of this.diagnosticsWaiters.get(params.uri) ?? []) waiter()
      }
      // Server->client requests (e.g. workspace/configuration) are ignored — elia's
      // client doesn't need to answer them for diagnostics-only usage.
      return
    }

    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`))
    else pending.resolve(message.result)
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
