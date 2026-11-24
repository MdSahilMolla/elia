import type { PipedSubprocess } from 'bun'
import type { McpServerConfig } from './config.ts'
import type { McpTransport } from './transport.ts'
import { isJsonRpcResponse, MCP_CLIENT_INFO, MCP_PROTOCOL_VERSION, type JsonRpcResponse, type McpToolCallResult, type McpToolsListResult } from './protocol.ts'
import { CircuitBreaker } from './circuit.ts'
import { MCP_CALL_TIMEOUT_MS, MCP_CONNECT_TIMEOUT_MS } from './timeouts.ts'
import { terminateProcessGroup } from '../shell.ts'
import { logSwallowedError } from '../diagnostics.ts'

// npx-backed browser servers can cold-start slowly on Windows while the package
// runner validates its cache. Keep the boundary finite, but allow one full
// startup/list-tools window before declaring an otherwise healthy MCP missing.
const CONNECT_TIMEOUT_MS = MCP_CONNECT_TIMEOUT_MS
const CALL_TIMEOUT_MS = MCP_CALL_TIMEOUT_MS
const MAX_STDERR_TAIL = 4_000

interface Pending {
  resolve(response: JsonRpcResponse): void
  reject(error: Error): void
}

// Bun's FileSink write()/flush()/end() return `number | Promise<number>`. On the
// happy path it's a number; when the peer process has been killed the write can
// fail asynchronously with EPIPE. Nobody awaits these, so an unhandled rejection
// would escape and (under `bun test`) get pinned on whatever test is running.
function swallow(result: unknown, scope: string, context?: Record<string, unknown>): void {
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
    void Promise.resolve(result).catch((err) => logSwallowedError(scope, err, context))
  }
}

/**
 * What an MCP server process inherits from elia. A server is third-party code
 * (often a repo-supplied `npx`/`uvx` package), so it does not get elia's whole
 * environment — provider API keys, tokens and `ELIA_*` settings stay behind.
 * It gets what a program needs to run at all (PATH, HOME, locale, temp dirs,
 * terminal, proxies and CA bundles, the Windows system variables), plus
 * whatever the server's own `env` block asks for explicitly.
 */
const MCP_ENV_ALLOWLIST = new Set([
  // Windows stores this one as `Path`, so match both spellings or the child is
  // spawned without a usable PATH and cannot resolve any executable.
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'COLORTERM', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH', 'BUN_INSTALL', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME',
  'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'UV_CACHE_DIR', 'PIPX_HOME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'SystemRoot', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROGRAMFILES', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH',
])

export function mcpChildEnv(explicit: Record<string, string> | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (MCP_ENV_ALLOWLIST.has(key) || key.startsWith('LC_')) env[key] = value
  }
  return { ...env, ...explicit }
}

/**
 * One live connection to an MCP server over stdio. Line-delimited JSON-RPC 2.0,
 * per the MCP stdio transport spec — no Content-Length framing, one message per line.
 */
export class McpClient implements McpTransport {
  readonly name: string
  private proc: PipedSubprocess | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private closed = false
  private readLoop: Promise<void> | undefined
  private stderrLoop: Promise<void> | undefined
  private stderrTail = ''
  private readonly breaker: CircuitBreaker

  constructor(private readonly config: McpServerConfig) {
    this.name = config.name
    this.breaker = new CircuitBreaker(config.name)
  }

  async connect(): Promise<void> {
    if (!this.config.command) throw new Error(`MCP server "${this.name}" has no "command" to spawn`)
    this.proc = Bun.spawn([this.config.command, ...(this.config.args ?? [])], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: mcpChildEnv(this.config.env),
        // Its own process group on POSIX, so close() can take the whole tree.
        // `npx`-backed servers are exactly the case that leaks: npx is the
        // direct child, and the package it is about to exec is the grandchild.
        ...(process.platform === 'win32' ? {} : { detached: true }),
      })
    this.readLoop = this.pumpStdout().catch(() => {
      // A dead read loop just means every pending/future call now times out and
      // rejects on its own — nothing else to do here.
    })
    // stdout/stderr are the same OS pipe capacity class: if stderr is never read, a
    // chatty server that fills its stderr buffer blocks on write() and the whole
    // connection wedges. Draining it also lets a crash surface immediately instead
    // of every in-flight call burning its full timeout waiting on a dead process.
    this.stderrLoop = this.pumpStderr().catch(() => {})

    await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
      CONNECT_TIMEOUT_MS,
      `MCP server "${this.name}" did not respond to initialize within ${CONNECT_TIMEOUT_MS}ms`,
    )
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolsListResult> {
    const result = await this.request('tools/list', {}, CONNECT_TIMEOUT_MS, `MCP server "${this.name}" did not respond to tools/list`)
    return result as McpToolsListResult
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.request(
      'tools/call',
      { name, arguments: args },
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
    // Release our end of the stdin pipe first. A hard tree-kill (taskkill /F on
    // Windows) yanks the process out from under Bun's still-open FileSink, and
    // Bun then surfaces the dangling write handle as an uncaught EPIPE when it
    // finalizes. Ending the sink ourselves closes that window — but end() can
    // itself reject asynchronously if the pipe is already broken, so swallow
    // both the sync throw and the async rejection.
    try {
      swallow(this.proc?.stdin.end(), 'mcp.client.close.stdinEnd', { server: this.name })
    } catch {
      // already gone
    }
    try {
      if (this.proc) terminateProcessGroup(this.proc)
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

  /** `onTimeout`, when given, runs right before the timeout rejects — used to
   * drop the now-abandoned entry from `this.pending` so a request whose id the
   * server never answers doesn't stay allocated forever. */
  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.()
        // A request the server simply never answers counts against the circuit:
        // three of those in a row open the breaker so the next call fails fast
        // instead of pinning for another full timeout.
        this.breaker.recordFailure()
        reject(new Error(message))
      }, ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  /** `timeoutMs`/`timeoutMessage` are optional so internal fire-and-forget
   * notifications-adjacent calls can skip the timeout race entirely; every
   * real caller below passes both. */
  private request(method: string, params: unknown, timeoutMs?: number, timeoutMessage?: string): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error(`MCP server "${this.name}" is not connected`))
    // Open circuit: the server has already failed the last `threshold` calls;
    // reject immediately instead of committing the call to another full timeout.
    if (this.breaker.isOpen()) return Promise.reject(new Error(`MCP server "${this.name}" is open-circuited after repeated failures`))
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
      swallow(this.proc.stdin.write(line), 'mcp.client.request.write', { server: this.name, method })
      swallow(this.proc.stdin.flush(), 'mcp.client.request.flush', { server: this.name, method })
    } catch (err) {
      // The server's stdin pipe can already be gone (crashed, or died right
      // after spawn) — reject this call instead of letting a raw EPIPE escape
      // as an unhandled error.
      this.pending.delete(id)
      this.breaker.recordFailure()
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    if (timeoutMs === undefined) return promise
    return this.withTimeout(promise, timeoutMs, timeoutMessage ?? `MCP server "${this.name}" timed out waiting for a response`, () => this.pending.delete(id))
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed || !this.proc) return
    const line = `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
    try {
      swallow(this.proc.stdin.write(line), 'mcp.client.notify.write', { server: this.name, method })
      swallow(this.proc.stdin.flush(), 'mcp.client.notify.flush', { server: this.name, method })
    } catch (err) {
      // Best-effort notification — nothing to reject, no reply is ever expected —
      // but still worth a record if the pipe is repeatedly gone.
      logSwallowedError('mcp.client.notify', err, { server: this.name, method })
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
      // A crash is diagnosed from its stderr tail. When the server dies its
      // pipes close together, and stdout's EOF can land before the stderr loop
      // finishes draining — if we report "closed its stdout" at that instant,
      // the diagnosis is lost and pending calls reject with the unhelpful EOF
      // reason. Give the stderr loop a bounded instant to finish (it ends at
      // the same process death) so its richer reason wins when there is one.
      const stderrSettle = Promise.race([this.stderrLoop, new Promise((resolve) => setTimeout(resolve, 100))])
      await stderrSettle.catch(() => {})
      this.onTransportEnded(
        this.stderrTail
          ? `MCP server "${this.name}" exited unexpectedly: ${this.stderrTail.trim()}`
          : `MCP server "${this.name}" closed its stdout`,
      )
    }
  }

  private async pumpStderr(): Promise<void> {
    if (!this.proc) return
    const reader = this.proc.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-MAX_STDERR_TAIL)
      }
    } finally {
      // A server that dies before ever writing to stdout (crash on startup, missing
      // binary once spawned via a shell, etc.) may close stderr well before stdout
      // does — or not close stdout cleanly at all. Either loop ending is proof the
      // process is gone, so either one is enough to stop burning full call timeouts.
      this.onTransportEnded(`MCP server "${this.name}" exited unexpectedly${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`)
    }
  }

  /** Idempotent: the first of pumpStdout/pumpStderr to end the connection wins; the second is a no-op. */
  private onTransportEnded(reason: string): void {
    if (this.closed) return
    // The server can end on its own without close() ever being called (the process
    // died on its own). Mark this client closed here too, so subsequent
    // request()/notify() calls fail fast on the "closed" check instead of attempting
    // a doomed write against a dead process.
    this.closed = true
    const stillPending = [...this.pending.values()]
    this.pending.clear()
    for (const pending of stillPending) pending.reject(new Error(reason))
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
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    // A live round-trip answers the circuit — even an application-level error
    // response proves the server is talking.
    this.breaker.recordSuccess()
    pending.resolve(message)
  }
}
