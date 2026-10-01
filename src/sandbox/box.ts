import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ShellResult } from '../shell.ts'
import { logSwallowedError } from '../diagnostics.ts'

/**
 * elia-box: Elia's own agent sandbox (crates/elia-box, native/elia-box-fs,
 * go/cmd/elia-egress). A run happens in a deny-by-default confinement with a
 * cleared environment, a bounded budget, an optional brokered network, and a
 * sealed receipt of what was allowed and what happened.
 *
 * Opt-in (`ELIA_SANDBOX=box`) and fail-closed: if the box is requested but
 * cannot run, the command is refused, never quietly run outside it. Falling
 * back to the host is a separate, explicit choice (`ELIA_BOX_FALLBACK=host`).
 */

export class BoxUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoxUnavailable'
  }
}

export interface BoxReceipt {
  schema: string
  id: string
  backend: 'seatbelt' | 'docker'
  argv: string[]
  policyHash: string
  exit: { code: number | null; signal: number | null; timedOut: boolean; interrupted: boolean; limitHit: string | null; stragglersKilled: boolean }
  usage: { wallMs: number; cpuUserMs: number | null; cpuSysMs: number | null; maxRssKb: number | null; peakTreeRssKb: number | null; peakProcs: number | null }
  output: { stdoutBytes: number; stderrBytes: number; stdoutSha256: string; stderrSha256: string; truncated: boolean }
  workspace: { path: string; mode: 'inplace' | 'fork'; forked: boolean; copyOnWrite: boolean; forkPath: string | null; snapshot: { before: string; after: string; changes: { added: string[]; modified: string[]; deleted: string[] } } | null }
  network: { mode: 'none' | 'brokered' | 'open'; allow: string[]; broker: { allowed: number; denied: number; events: Array<{ host: string; port: number; allowed: boolean; reason: string | null }> } | null }
  containment: { enforced: string[]; notEnforced: string[] }
  receiptHash: string
  receiptMac?: string
}

export interface BoxPolicy {
  version?: 1
  backend?: 'auto' | 'seatbelt' | 'docker'
  workspace: string
  mode?: 'inplace' | 'fork'
  readPaths?: string[]
  writePaths?: string[]
  network?: { mode: 'none' | 'brokered' | 'open'; allow?: string[] }
  limits?: Partial<{ wallMs: number; cpuSeconds: number; memoryMb: number; pids: number; fileSizeMb: number; openFiles: number; outputBytes: number }>
  env?: Record<string, string>
  envPassthrough?: string[]
  snapshot?: boolean
  exclude?: string[]
  image?: string
  keepFork?: boolean
}

export interface BoxRun {
  stdout: string
  stderr: string
  receipt: BoxReceipt
}

export function boxSandboxRequested(): boolean {
  return (process.env.ELIA_SANDBOX ?? '').trim().toLowerCase() === 'box'
}

/** Falling back to unsandboxed host execution must be asked for by name. */
export function boxFallbackToHost(): boolean {
  return (process.env.ELIA_BOX_FALLBACK ?? '').trim().toLowerCase() === 'host'
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

export function findBoxBinary(): string | undefined {
  const explicit = process.env.ELIA_BOX_BIN?.trim()
  if (explicit) return existsSync(explicit) ? explicit : undefined
  for (const candidate of [join(REPO_ROOT, 'bin', 'elia-box'), join(REPO_ROOT, 'target', 'release', 'elia-box')]) {
    if (existsSync(candidate)) return candidate
  }
  return Bun.which('elia-box') ?? undefined
}

/** Per-user tool installs that hold no secrets, and that ordinary toolchains need to read. */
const HOME_TOOL_DIRS = ['.bun', '.rustup', '.cargo/bin', '.nvm', '.volta', '.pyenv', '.local/bin', '.deno']

/** Directories the command may read: everything on PATH plus the user's tool installs, when they exist. */
export function toolReadPaths(pathEnv = process.env.PATH ?? '', home = homedir()): string[] {
  const out = new Set<string>()
  for (const dir of pathEnv.split(delimiter)) {
    if (dir && dir.startsWith('/') && existsSync(dir)) out.add(dir)
  }
  for (const rel of HOME_TOOL_DIRS) {
    const dir = join(home, rel)
    if (existsSync(dir)) out.add(dir)
  }
  return [...out]
}

const PASSTHROUGH = ['TERM', 'LANG', 'LC_ALL', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'TZ']

/** A name that reads as a credential (provider API keys included) is never carried into the box, whoever asked for it. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH/i

/**
 * The per-call environment a box run may add. Callers hand in a full copy of the
 * host environment (workspaceScopedEnv), so anything that merely repeats the host's
 * own value is dropped (the harmless names ride in via envPassthrough): the box gets PATH and what
 * the call itself changed or added, minus anything named like a credential.
 */
export function boxSafeEnv(env: Record<string, string> | undefined, host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env ?? {})) {
    if (SECRET_NAME.test(name)) continue
    if (name !== 'PATH' && host[name] === value) continue
    out[name] = value
  }
  return out
}

export function boxPolicyFor(cwd: string, timeoutMs: number, env?: Record<string, string>): BoxPolicy {
  const network = (process.env.ELIA_BOX_NETWORK ?? 'none').trim().toLowerCase()
  const allow = (process.env.ELIA_BOX_ALLOW ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  const backend = (process.env.ELIA_BOX_BACKEND ?? 'auto').trim().toLowerCase()
  const policy: BoxPolicy = {
    version: 1,
    backend: backend === 'seatbelt' || backend === 'docker' ? backend : 'auto',
    workspace: cwd,
    mode: 'inplace',
    readPaths: toolReadPaths(),
    network: network === 'open' ? { mode: 'open' } : network === 'brokered' ? { mode: 'brokered', allow } : { mode: 'none' },
    limits: { wallMs: Math.max(1, timeoutMs) },
    // PATH is the one host variable the command needs to find its tools; nothing else that
    // could carry a credential is inherited. Per-call `env` overrides layer on top, filtered
    // by boxSafeEnv so a copy of the host environment cannot smuggle secrets in.
    env: { PATH: process.env.PATH ?? '', ...boxSafeEnv(env) },
    envPassthrough: PASSTHROUGH,
  }
  if (process.env.ELIA_BOX_IMAGE?.trim()) policy.image = process.env.ELIA_BOX_IMAGE.trim()
  return policy
}

const recent: BoxReceipt[] = []

/** The most recent receipts from this process, newest last. A gate can read these to see what a run was held to. */
export function recentBoxReceipts(): readonly BoxReceipt[] {
  return recent
}

export function resetBoxReceiptsForTests(): void {
  recent.length = 0
}

function remember(receipt: BoxReceipt): void {
  recent.push(receipt)
  if (recent.length > 50) recent.shift()
}

interface RawError {
  error: { kind: 'policy' | 'unavailable' | 'backend' | 'internal'; message: string }
}

/**
 * Runs `argv` in elia-box under `policy`. Throws {@link BoxUnavailable} only when
 * the box itself cannot run (no binary, no usable backend, missing broker or image).
 * A policy the box refuses, or an internal failure, is a plain Error; the command
 * is not run in either case.
 */
export async function runInBox(policy: BoxPolicy, argv: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<BoxRun> {
  if (process.platform === 'win32') throw new BoxUnavailable('elia-box has no Windows backend yet')
  const bin = findBoxBinary()
  if (!bin) {
    throw new BoxUnavailable('elia-box is not built: run `cargo build --release -p elia-box` and copy target/release/elia-box to bin/, or set ELIA_BOX_BIN')
  }
  const wallMs = policy.limits?.wallMs ?? 120_000
  const proc = Bun.spawn([bin, 'run', '--policy', '-', '--', ...argv], {
    stdin: new Blob([JSON.stringify(policy)]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  // The box enforces the wall clock itself; this is only the backstop for a wedged box.
  const backstop = setTimeout(() => proc.kill('SIGKILL'), (opts.timeoutMs ?? wallMs) + 15_000)
  const onAbort = () => proc.kill('SIGTERM')
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    let parsed: BoxRun | RawError
    try {
      parsed = JSON.parse(out) as BoxRun | RawError
    } catch {
      throw new Error(`elia-box produced no result (exit ${code}): ${(err || out).trim().slice(0, 300)}`)
    }
    if ('error' in parsed) {
      const { kind, message } = parsed.error
      if (kind === 'unavailable' || kind === 'backend') throw new BoxUnavailable(message)
      throw new Error(`elia-box refused the run (${kind}): ${message}`)
    }
    remember(parsed.receipt)
    return parsed
  } finally {
    clearTimeout(backstop)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** Maps a box run onto the ShellResult the rest of elia already understands. */
export function shellResultFromBox(command: string, run: BoxRun): ShellResult {
  const { receipt } = run
  const { exit } = receipt
  const exitCode = exit.code ?? (exit.signal !== null ? 128 + exit.signal : 1)
  let stderr = run.stderr
  const notes: string[] = []
  if (exit.timedOut) notes.push('killed: wall-clock limit reached')
  if (exit.limitHit) notes.push(`killed: ${exit.limitHit} limit reached`)
  if (exit.interrupted) notes.push('interrupted')
  if (receipt.output.truncated) notes.push('output truncated')
  if (notes.length) stderr = `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}[elia-box ${receipt.id}: ${notes.join('; ')}]`
  return { command, exitCode, stdout: run.stdout, stderr, elapsedMs: receipt.usage.wallMs, timedOut: exit.timedOut }
}

export async function runShellInBox(command: string, timeoutMs: number, cwd?: string, signal?: AbortSignal, env?: Record<string, string>): Promise<ShellResult> {
  const workspace = cwd ?? process.cwd()
  const run = await runInBox(boxPolicyFor(workspace, timeoutMs, env), ['/bin/sh', '-c', command], { signal, timeoutMs })
  return shellResultFromBox(command, run)
}

/** Runs one executable with an explicit argv in the box, the way runShellInBox runs a shell line. */
export async function runProcessInBox(argv: string[], timeoutMs: number, cwd?: string, signal?: AbortSignal, env?: Record<string, string>): Promise<ShellResult> {
  const workspace = cwd ?? process.cwd()
  const run = await runInBox(boxPolicyFor(workspace, timeoutMs, env), argv, { signal, timeoutMs })
  return shellResultFromBox(argv.join(' '), run)
}

let warnedThisProcess = false
export function noteBoxFallback(reason: string): void {
  if (warnedThisProcess) return
  warnedThisProcess = true
  logSwallowedError('sandbox.box.fallbackToHost', new Error(reason))
}

/** Test seam. */
export function resetBoxFallbackWarningForTests(): void {
  warnedThisProcess = false
}
