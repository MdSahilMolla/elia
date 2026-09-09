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
  type JvmCheckParams,
  type JvmCheckResult,
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
  // Prefer the release build — it starts several times faster than a 30 MB+
  // debug binary, and picking purely by mtime meant a stale `cargo build` could
  // shadow a fresh `cargo build --release`. `ELIA_ELIAD_PROFILE=debug` forces
  // the debug build for iterating on the daemon itself. Within the chosen
  // profile, newest wins (covers multiple target triples).
  const targetRoot = join(ELIA_ROOT, 'target')
  const dirs = ['', ...safeReaddir(targetRoot)]
  const preferred = process.env.ELIA_ELIAD_PROFILE === 'debug' ? ['debug', 'release'] : ['release', 'debug']
  for (const profile of preferred) {
    let newest: { path: string; mtimeMs: number } | undefined
    for (const dir of dirs) {
      const candidate = join(targetRoot, dir, profile, exe)
      try {
        const { mtimeMs } = statSync(candidate)
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs }
      } catch {
        // not built for this profile/target
      }
    }
    if (newest) return newest.path
  }
  return undefined
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The `elia-jvm-bridge` jar, so the daemon can find it (it has no notion of the
 * repo root). Honoured via `ELIA_JVM_BRIDGE_JAR`, which we set when spawning. */
export function resolveJvmBridgeJar(): string | undefined {
  if (process.env.ELIA_JVM_BRIDGE_JAR && existsSync(process.env.ELIA_JVM_BRIDGE_JAR)) {
    return process.env.ELIA_JVM_BRIDGE_JAR
  }
  const candidates = [
    join(ELIA_ROOT, 'node_modules', '@elia/native', 'elia-jvm-bridge.jar'),
    join(ELIA_ROOT, 'jvm', 'elia-jvm-bridge', 'build', 'elia-jvm-bridge.jar'),
  ]
  return candidates.find((p) => existsSync(p))
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
    if (!(await this.dial())) {
      await this.spawnDaemon()
      await this.dialWithRetry()
    }
    await this.handshake()
  }

  /**
   * Try once to connect. Resolves `true` on success (and stashes the socket),
   * `false` on any failure — it never rejects and never lets an error escape.
   * Three separate failure shapes are swallowed here:
   *   - `net.createConnection` throwing *synchronously* on a missing socket path
   *     (bun's node:net does this for ENOENT rather than emitting 'error');
   *   - the async 'error' event on a refused/missing socket;
   *   - a trailing 'error' on the now-destroyed socket.
   * Under `bun test` any of these otherwise fails whichever test is mid-flight.
   */
  private dial(): Promise<boolean> {
    return new Promise((resolve) => {
      const path = socketPath()
      // bun 1.3.0's node:net raises the ENOENT from a missing unix socket inside
      // its own connect callback, where neither this try/catch nor a
      // `socket.on('error')` listener can intercept it — under `bun test` it
      // fails whichever test is mid-flight. When the socket file plainly isn't
      // there yet (the cold-start path), skip the dial entirely.
      if (process.platform !== 'win32' && !existsSync(path)) {
        resolve(false)
        return
      }
      let settled = false
      let socket: net.Socket
      try {
        socket = net.createConnection({ path })
      } catch {
        resolve(false)
        return
      }
      const onError = () => {
        if (settled) return
        settled = true
        socket.removeListener('connect', onConnect)
        socket.on('error', () => {})
        socket.destroy()
        resolve(false)
      }
      const onConnect = () => {
        settled = true
        socket.removeListener('error', onError)
        socket.setNoDelay(true)
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => this.onData(chunk))
        socket.on('close', () => this.onClose())
        socket.on('error', () => this.onClose())
        this.socket = socket
        resolve(true)
      }
      socket.once('error', onError)
      socket.once('connect', onConnect)
    })
  }

  private async dialWithRetry(): Promise<void> {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (await this.dial()) return
      await sleep(120)
    }
    throw new DaemonUnavailable('eliad did not come up within 8s of being spawned')
  }

  private async spawnDaemon(): Promise<void> {
    if (this.spawnedThisProcess) {
      // Already tried once this process; do not fork-bomb.
      throw new DaemonUnavailable('eliad is not running and a spawn was already attempted')
    }
    this.spawnedThisProcess = true
    const bin = resolveEliadPath()
    if (!bin) throw new DaemonUnavailable('eliad binary not found (build crates/eliad or install @elia/native)')
    const jar = resolveJvmBridgeJar()
    const child = Bun.spawn([bin], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      // Bun snapshots the environment at spawn and does not pick up runtime
      // `process.env` writes unless `env` is passed explicitly — the daemon must
      // see the same ELIA_* vars this process has.
      env: { ...process.env, ...(jar ? { ELIA_JVM_BRIDGE_JAR: jar } : {}) },
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
   * targeted cancellation.
   *
   * `signal` is wired to `shell.cancel` *before* the response is awaited:
   * `shell.exec` does not resolve until the command finishes, so a listener
   * attached after the await would never see an abort that arrives while the
   * command is still running. On abort the pending call is also rejected so the
   * caller stops waiting instead of hanging until `timeoutMs`. */
  async call(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ id: number; result: unknown }> {
    if (signal?.aborted) throw new DaemonUnavailable(`${method} aborted before start`)
    await this.ensureConnected()
    const id = this.nextId++
    const onAbort = (): void => {
      this.cancel(id)
      const waiter = this.pending.get(id)
      if (waiter && this.pending.delete(id)) waiter.reject(new DaemonUnavailable(`${method} aborted`))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await this.send(id, method, params, timeoutMs)
      return { id, result }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
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
  const { result } = await client.call(
    'shell.exec',
    { command: req.command, cwd: req.cwd, timeout_ms: req.timeoutMs },
    req.timeoutMs + 10_000,
    req.signal,
  )
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

/**
 * Type-check a proposed Java edit with the JDK compiler, via the daemon's
 * `elia-jvm-bridge` (Java) child. First call pays JVM start (~1s); warm calls
 * are a few hundred ms. Throws {@link DaemonUnavailable} when the daemon is off,
 * or a plain error when no JDK / bridge jar is available.
 */
export async function daemonJvmCheck(params: JvmCheckParams): Promise<JvmCheckResult> {
  if (!daemonEnabled()) throw new DaemonUnavailable('ELIA_DAEMON=off')
  const { result } = await daemonClient().call('jvm.check', params, 35_000)
  return result as JvmCheckResult
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
