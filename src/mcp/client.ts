import type { PipedSubprocess } from 'bun'
import type { McpServerConfig } from './config.ts'
import { isJsonRpcResponse, MCP_CLIENT_INFO, MCP_PROTOCOL_VERSION, type JsonRpcResponse, type McpToolCallResult, type McpToolsListResult } from './protocol.ts'

const CONNECT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 120_000

interface Pending {
  resolve(response: JsonRpcResponse): void
  reject(error: Error): void
}

/**
 * One live connection to an MCP server over stdio. Line-delimited JSON-RPC 2.0,
 * per the MCP stdio transport spec — no Content-Length framing, one message per line.
 */
export class McpClient {
  readonly name: string
  private proc: PipedSubprocess | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private closed = false
  private readLoop: Promise<void> | undefined

  constructor(private readonly config: McpServerConfig) {
    this.name = config.name
  }

  async connect(): Promise<void> {
    this.proc = Bun.spawn([this.config.command, ...(this.config.args ?? [])], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...this.config.env } as Record<string, string>,
    })
    this.readLoop = this.pumpStdout().catch(() => {
      // A dead read loop just means every pending/future call now times out and
      // rejects on its own — nothing else to do here.
    })

    await this.withTimeout(
      this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      }),
      CONNECT_TIMEOUT_MS,
      `MCP server "${this.name}" did not respond to initialize within ${CONNECT_TIMEOUT_MS}ms`,
    )
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolsListResult> {
    const result = await this.withTimeout(this.request('tools/list', {}), CONNECT_TIMEOUT_MS, `MCP server "${this.name}" did not respond to tools/list`)
    return result as McpToolsListResult
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.withTimeout(
      this.request('tools/call', { name, arguments: args }),
      CALL_TIMEOUT_MS,
      `MCP server "${this.name}" timed out calling tool "${name}"`,
    )
    return result as McpToolCallResult
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error(`MCP server "${this.name}" closed`))
    this.pending.clear()
    try {
      this.proc?.kill()
    } catch {
      // Best-effort — process may already be gone.
    }
  }

  /**
   * Same as close(), but waits for the OS to actually reap the process before
   * returning. close() itself stays synchronous (it doubles as a
   * registerShutdownCleanup callback, which is fire-and-forget by contract) —
   * this is for callers, chiefly tests, that need the subprocess and its pipes
   * fully gone before moving on, so nothing is left for a later, unrelated
   * teardown to race against.
   */
  async closeAndWait(): Promise<void> {
    const proc = this.proc
    this.close()
    if (proc) await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 2000))])
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error(`MCP server "${this.name}" is not connected`))
    const id = this.nextId++
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (response) => {
          if ('error' in response) reject(new Error(`${response.error.message} (${response.error.code})`))
          else resolve(response.result)
        },
        reject,
      })
    })
    try {
      this.proc.stdin.write(line)
      this.proc.stdin.flush()
    } catch (err) {
      // The server's stdin pipe can already be gone (crashed, or died right
      // after spawn) — reject this call instead of letting a raw EPIPE escape
      // as an unhandled error.
      this.pending.delete(id)
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    return promise
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed || !this.proc) return
    const line = `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
    try {
      this.proc.stdin.write(line)
      this.proc.stdin.flush()
    } catch {
      // Best-effort notification — nothing to reject, no reply is ever expected.
    }
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
        let newlineIndex: number
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newlineIndex).trim()
          this.buffer = this.buffer.slice(newlineIndex + 1)
          if (line) this.handleLine(line)
        }
      }
    } finally {
      const stillPending = [...this.pending.values()]
      this.pending.clear()
      for (const pending of stillPending) pending.reject(new Error(`MCP server "${this.name}" closed its stdout`))
    }
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // Not every line an MCP server prints is guaranteed to be a clean JSON-RPC
      // message (some servers log to stdout by mistake) — skip rather than crash.
      return
    }
    if (!isJsonRpcResponse(message)) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    pending.resolve(message)
  }
}
