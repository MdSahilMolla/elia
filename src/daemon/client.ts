/**
 * Client for `eliad`, Elia's resident daemon.
 *
 * The daemon holds a warm shell pool (and, in later workstreams, warm provider
 * connections and the MCP supervisor). This client is the *only* seam between
 * the TypeScript conductor and that process: it dials the socket, spawns the
 * daemon if nothing answers, checks the protocol version, and multiplexes
 * newline-delimited JSON-RPC over one connection.
 *
 * Every call can fail with {@link DaemonUnavailable}; callers are expected to
 * catch it and fall back to their in-process path. Nothing here is required for
 * correctness.
 */

import net from 'node:net'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../statePaths.ts'
import {
  PROTOCOL_VERSION,
  type DaemonInfo,
  type ParseCheckParams,
  type ParseCheckResult,
  type RpcResponse,
  type ShellExecResult,
} from './types.ts'

export class DaemonUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonUnavailable'
  }
}

/** `off` (default) — never touch the daemon. `auto` — use it, fall back on any
 * failure. `require` — use it and surface failures (for benchmarking the
 * intended path). */
export type DaemonMode = 'off' | 'auto' | 'require'

export function daemonMode(): DaemonMode {
  const raw = (process.env.ELIA_DAEMON ?? 'off').toLowerCase()
  return raw === 'auto' || raw === 'require' ? raw : 'off'
}

export function daemonEnabled(): boolean {
  return daemonMode() !== 'off'
}

function userTag(): string {
  const raw = process.env.USER || process.env.USERNAME || 'default'
  return (raw.match(/[A-Za-z0-9_-]/g) ?? []).join('').slice(0, 32) || 'default'
}

/** The listener address — must match `crates/eliad/src/socket.rs`. */
export function socketPath(): string {
  const explicit = process.env.ELIA_ELIAD_SOCKET
  if (explicit) {
    // On Windows the daemon treats the override as a bare pipe name; `net`
    // needs the full `\\.\pipe\` form.
    if (process.platform === 'win32' && !explicit.startsWith('\\\\')) return `\\\\.\\pipe\\${explicit}`
    return explicit
  }
  if (process.platform === 'win32') return `\\\\.\\pipe\\elia-eliad-${userTag()}`
  const dir = process.env.XDG_RUNTIME_DIR || join(process.env.HOME ?? '.', '.elia')
  return join(dir, `eliad-${userTag()}.sock`)
}

/** Locate the `eliad` binary: an explicit override, then a published platform
 * package, then whichever local cargo build is newest (so `cargo build` and
 * `cargo build --release` both "just work" during development). */
export function resolveEliadPath(): string | undefined {
  const exe = process.platform === 'win32' ? 'eliad.exe' : 'eliad'
  if (process.env.ELIA_ELIAD_PATH && existsSync(process.env.ELIA_ELIAD_PATH)) {
    return process.env.ELIA_ELIAD_PATH
  }
  const published = join(ELIA_ROOT, 'node_modules', `@elia/native-${process.platform}-${process.arch}`, exe)
  if (existsSync(published)) return published

  // Local builds: target/{debug,release}/ and target/<triple>/{debug,release}/.
  const targetRoot = join(ELIA_ROOT, 'target')
  const dirs = ['', ...safeReaddir(targetRoot)]
  let newest: { path: string; mtimeMs: number } | undefined
  for (const dir of dirs) {
    for (const profile of ['debug', 'release']) {
      const candidate = join(targetRoot, dir, profile, exe)
      try {
        const { mtimeMs } = statSync(candidate)
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs }
      } catch {
        // not built for this profile/target
      }
    }
  }
  return newest?.path
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

class DaemonClient {
  private socket: net.Socket | undefined
  private connecting: Promise<void> | undefined
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private spawnedThisProcess = false

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    if (this.connecting) return this.connecting
    this.connecting = this.connect().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  private async connect(): Promise<void> {
    try {
      await this.dial()
    } catch {
      await this.spawnDaemon()
      await this.dialWithRetry()
    }
    await this.handshake()
  }

  private dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath() })
      const onError = (err: Error) => {
        socket.destroy()
        reject(err)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        socket.setNoDelay(true)
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => this.onData(chunk))
        socket.on('close', () => this.onClose())
        socket.on('error', () => this.onClose())
        this.socket = socket
        resolve()
      })
    })
  }

  private async dialWithRetry(): Promise<void> {
    const deadline = Date.now() + 8_000
    let lastErr: unknown
    while (Date.now() < deadline) {
      try {
        await this.dial()
        return
      } catch (err) {
        lastErr = err
        await sleep(120)
      }
    }
    throw new DaemonUnavailable(`eliad did not come up: ${String(lastErr)}`)
  }

  private async spawnDaemon(): Promise<void> {
    if (this.spawnedThisProcess) {
      // Already tried once this process; do not fork-bomb.
      throw new DaemonUnavailable('eliad is not running and a spawn was already attempted')
    }
    this.spawnedThisProcess = true
    const bin = resolveEliadPath()
    if (!bin) throw new DaemonUnavailable('eliad binary not found (build crates/eliad or install @elia/native)')
    const child = Bun.spawn([bin], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      // Bun snapshots the environment at spawn and does not pick up runtime
      // `process.env` writes unless `env` is passed explicitly — the daemon must
      // see the same ELIA_* vars this process has.
      env: { ...process.env },
      // Outlive this CLI invocation so the next one reuses it.
      detached: true,
    })
    child.unref()
  }

  private async handshake(): Promise<void> {
    const info = (await this.rawCall('daemon.info', {}, 5_000)) as DaemonInfo
    if (info.protocol !== PROTOCOL_VERSION) {
      // A stale daemon from an older build. Ask it to exit and start fresh.
      await this.rawCall('daemon.shutdown', {}, 2_000).catch(() => {})
      this.socket?.destroy()
      this.socket = undefined
      this.spawnedThisProcess = false
      await this.spawnDaemon()
      await this.dialWithRetry()
      const fresh = (await this.rawCall('daemon.info', {}, 5_000)) as DaemonInfo
      if (fresh.protocol !== PROTOCOL_VERSION) {
        throw new DaemonUnavailable(
          `eliad protocol ${fresh.protocol}, expected ${PROTOCOL_VERSION}`,
        )
      }
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let msg: RpcResponse
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = this.pending.get(msg.id)
      if (!waiter) continue
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new DaemonUnavailable(`rpc error ${msg.error.code}: ${msg.error.message}`))
      else waiter.resolve(msg.result)
    }
  }

  private onClose(): void {
    this.socket = undefined
    const err = new DaemonUnavailable('connection to eliad closed')
    for (const waiter of this.pending.values()) waiter.reject(err)
    this.pending.clear()
  }

  private rawCall(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return this.send(this.nextId++, method, params, timeoutMs)
  }

  private send(id: number, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new DaemonUnavailable('not connected'))
    const payload = JSON.stringify({ id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new DaemonUnavailable(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      socket.write(payload, (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer)
          reject(new DaemonUnavailable(`write failed: ${err.message}`))
        }
      })
    })
  }

  /** Public call used by feature clients. `id` is the request id used for
   * targeted cancellation. */
  async call(method: string, params: unknown, timeoutMs: number): Promise<{ id: number; result: unknown }> {
    await this.ensureConnected()
    const id = this.nextId++
    const result = await this.send(id, method, params, timeoutMs)
    return { id, result }
  }

  cancel(target: number): void {
    // Fire-and-forget; the socket may already be gone.
    this.rawCall('shell.cancel', { target }, 1_000).catch(() => {})
  }

  async info(): Promise<DaemonInfo> {
    await this.ensureConnected()
    return (await this.rawCall('daemon.info', {}, 5_000)) as DaemonInfo
  }
}

let singleton: DaemonClient | undefined

export function daemonClient(): DaemonClient {
  if (!singleton) singleton = new DaemonClient()
  return singleton
}

/** Test-only: drop the shared client so the next call reconnects from scratch. */
export function resetDaemonClientForTests(): void {
  singleton = undefined
}

export interface DaemonShellRequest {
  command: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Run one command through the daemon's persistent shell. Throws
 * {@link DaemonUnavailable} on any transport problem — the caller falls back to
 * spawning a shell in-process.
 */
export async function daemonShellExec(req: DaemonShellRequest): Promise<ShellExecResult> {
  if (!daemonEnabled()) throw new DaemonUnavailable('ELIA_DAEMON=off')
  const client = daemonClient()
  const { id, result } = await client.call(
    'shell.exec',
    { command: req.command, cwd: req.cwd, timeout_ms: req.timeoutMs },
    req.timeoutMs + 10_000,
  )
  if (req.signal) {
    if (req.signal.aborted) client.cancel(id)
    else req.signal.addEventListener('abort', () => client.cancel(id), { once: true })
  }
  return result as ShellExecResult
}

/**
 * Structural check of a proposed file edit, via the daemon's C++ validator
 * (`native/elia-parse`). Sub-millisecond; catches unbalanced brackets and
 * unterminated strings/comments before a build round-trip does. Throws
 * {@link DaemonUnavailable} when the daemon is off or unreachable.
 */
export async function daemonParseCheck(params: ParseCheckParams): Promise<ParseCheckResult> {
  if (!daemonEnabled()) throw new DaemonUnavailable('ELIA_DAEMON=off')
  const { result } = await daemonClient().call('parse.check', params, 5_000)
  return result as ParseCheckResult
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
