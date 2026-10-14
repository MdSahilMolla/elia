/**
 * Supervises the mesh sidecar: spawn `workspace attach`, decode its NDJSON
 * stream, and restart it with a capped exponential backoff when it dies.
 *
 * Elia does not pair. Starting a session into an unpaired folder would either
 * fail or, worse, mint a join code no user asked for. So `auto` starts only a
 * workspace the sidecar already considers paired, and the deliberate `attach
 * --serve` / `attach --join` flows stay in the user's hands. `require` is the
 * escape hatch for exercising the intended path.
 *
 * The restart loop is bounded by backoff, not by an attempt count: a mesh that
 * is down should recover when the network does, but each restart is reported so
 * a supervisor can show it rather than spin silently.
 */

import { readBoundedOutput, terminateProcessGroup } from '../shell.ts'
import { buildFileChangedPayload, type FileChangeMeta, type IncomingFileChange } from '../workspace/fileChange.ts'
import { encodeMeshControl, MESH_PROTOCOL_VERSION, parseMeshFrame, toIncomingFileChange, type MeshChange, type MeshControl, type MeshEvent, type MeshInvite, type MeshReady } from './frames.ts'
import { meshHostAdvertiseAddress, meshHostListenAddress, meshPathProblem, meshMode, resolveMeshPath, type MeshMode } from './mode.ts'
import { isMeshPaired, readMeshPairing, type MeshPairing } from './pairing.ts'

/** A change as it arrives, split into its durable and ephemeral forms. */
export interface MeshFileChange {
  /** The persistable payload; the withholding decision is already applied. */
  meta: FileChangeMeta
  /** The change with its ephemeral diff body, for display only. */
  incoming: IncomingFileChange
  /** True when the change was refused or preserved rather than applied. */
  conflict: boolean
  keptPath?: string
  reason?: string
}

export type MeshDecision =
  | { start: true; reason: 'paired' | 'required' }
  | { start: false; reason: 'mode-off' | 'no-binary' | 'no-workspace' | 'not-paired' }

export interface MeshRestart {
  /** 1 for the first restart after the initial start. */
  attempt: number
  delayMs: number
  /** Why the previous process ended. */
  reason: string
}

/**
 * The spawn signature the supervisor needs; `Bun.spawn` satisfies it.
 *
 * `stdin` is a pipe because the control plane rides the same process: Elia
 * writes relayed workspace events to the sidecar's stdin, which forwards them
 * to the peer over the connection it has already authenticated.
 */
export type MeshSpawn = (
  argv: string[],
  options: { cwd: string; stdin: 'pipe'; stdout: 'pipe'; stderr: 'pipe'; env: Record<string, string | undefined> },
) => Bun.Subprocess

export interface MeshSupervisorOptions {
  root: string
  /** Defaults to `ELIA_WORKSPACE_MESH`. */
  mode?: MeshMode
  /** Defaults to `ELIA_RWS_PATH`. */
  meshPath?: string
  signal?: AbortSignal
  onDecision?: (decision: MeshDecision) => void
  onReady?: (ready: MeshReady) => void
  onInvite?: (invite: MeshInvite) => void
  onFileChange?: (change: MeshFileChange) => void
  onEvent?: (event: MeshEvent) => void
  /** Workspace events relayed from the peer. */
  onControl?: (control: MeshControl) => void
  onFailure?: (message: string) => void
  onRestart?: (restart: MeshRestart) => void
  /**
   * Receives every line the sidecar writes to stdout, undecoded.
   *
   * The decoded callbacks above are a lossy view: a frame type this build does
   * not understand is dropped on the floor, and everything the sidecar says
   * about itself — which root it opened, which workspace it thinks it is in — is
   * not part of any frame. That is exactly the information needed when two peers
   * will not talk to each other, and without it the only symptom is silence.
   */
  onLine?: (line: string) => void
  backoff?: MeshBackoffOptions
  /** Test seams. */
  spawn?: MeshSpawn
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  pairing?: MeshPairing
}

export interface MeshSupervisorHandle {
  readonly decision: MeshDecision
  /** Resolves when the supervisor stops (aborted, or never started). */
  readonly done: Promise<void>
  stop(): void
  /**
   * Relay a control batch to the peer.
   *
   * Returns false when there is no live sidecar to write to. That is the normal
   * answer while the process is restarting or was never started, and callers
   * must treat it as "try again when the next one is ready" rather than as an
   * error: replication is retried from the peer's cursor, so a dropped batch
   * costs a delay, not an event.
   */
  sendControl(control: MeshControl): boolean
}

export interface MeshBackoffOptions {
  baseMs?: number
  factor?: number
  capMs?: number
}

const BACKOFF_DEFAULTS: Required<MeshBackoffOptions> = { baseMs: 500, factor: 2, capMs: 30_000 }

/**
 * The delay before restart number `attempt` (1-based). Exponential from
 * `baseMs`, capped at `capMs`. No jitter: with exactly two peers a thundering
 * herd is not a failure mode, and a deterministic delay is one fewer thing a
 * test has to mock.
 */
export function meshRestartDelayMs(attempt: number, options: MeshBackoffOptions = {}): number {
  const { baseMs, factor, capMs } = { ...BACKOFF_DEFAULTS, ...options }
  const exponent = Math.min(Math.max(1, Math.floor(attempt)) - 1, 30)
  return Math.min(capMs, Math.round(baseMs * Math.pow(factor, exponent)))
}

/** The start policy, split out so it can be asserted without spawning. */
export function decideMeshStart(input: { mode: MeshMode; binary: string | undefined; pairing: MeshPairing }): MeshDecision {
  if (input.mode === 'off') return { start: false, reason: 'mode-off' }
  if (input.binary === undefined) return { start: false, reason: 'no-binary' }
  if (!input.pairing.present) return { start: false, reason: 'no-workspace' }
  if (input.mode === 'require') return { start: true, reason: 'required' }
  return isMeshPaired(input.pairing) ? { start: true, reason: 'paired' } : { start: false, reason: 'not-paired' }
}

/** Starts supervising the mesh. Returns immediately; work runs in the background. */
export function startMeshSupervisor(options: MeshSupervisorOptions): MeshSupervisorHandle {
  const mode = options.mode ?? meshMode()
  const binary = options.meshPath ?? resolveMeshPath()
  const pairing = options.pairing ?? readMeshPairing(options.root)
  const decision = decideMeshStart({ mode, binary, pairing })
  options.onDecision?.(decision)

  if (!decision.start || binary === undefined) {
    reportUnstarted(options, decision)
    return { decision, done: Promise.resolve(), stop: () => {}, sendControl: () => false }
  }

  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })

  const spawn = options.spawn ?? (Bun.spawn as unknown as MeshSpawn)
  const sleep = options.sleep ?? sleepUnlessAborted
  // The live sidecar's stdin, republished on every restart. Held here rather
  // than threaded through the loop so a caller can hold the handle across
  // restarts and still send; it is null whenever no process is running.
  let writer: MeshWriter | null = null
  const done = runLoop({ ...options, pairing, binary, spawn, sleep, signal: controller.signal, backoff: options.backoff ?? {}, setWriter: (next) => { writer = next } }).finally(() => {
    options.signal?.removeEventListener('abort', forwardAbort)
    writer = null
  })

  return {
    decision,
    done,
    stop: () => controller.abort(),
    sendControl: (control) => {
      if (writer === null) return false
      return writer(encodeMeshControl(control))
    },
  }
}

/** Writes one already-encoded line to a running sidecar. Returns false once it is gone. */
type MeshWriter = (line: string) => boolean

function reportUnstarted(options: MeshSupervisorOptions, decision: MeshDecision): void {
  if (decision.start) return
  switch (decision.reason) {
    case 'no-binary': {
      const problem = meshPathProblem()
      options.onFailure?.(problem ?? 'mesh is enabled but ELIA_RWS_PATH is not set, so the workspace sidecar cannot be found')
      break
    }
    case 'no-workspace':
      options.onEvent?.({ kind: 'mesh', message: 'no workspace in this folder yet; run the workspace setup before Elia can mesh the folder' })
      break
    case 'not-paired':
      options.onEvent?.({ kind: 'mesh', message: 'workspace is not paired; Elia starts the mesh only after a deliberate pairing' })
      break
    case 'mode-off':
      break
  }
}

interface RunContext {
  root: string
  binary: string
  pairing: MeshPairing
  signal: AbortSignal
  spawn: MeshSpawn
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  backoff: MeshBackoffOptions
  onReady?: (ready: MeshReady) => void
  onInvite?: (invite: MeshInvite) => void
  onFileChange?: (change: MeshFileChange) => void
  onEvent?: (event: MeshEvent) => void
  onControl?: (control: MeshControl) => void
  onFailure?: (message: string) => void
  onRestart?: (restart: MeshRestart) => void
  onLine?: (line: string) => void
  setWriter: (writer: MeshWriter | null) => void
}

/**
 * The sidecar invocation for this workspace.
 *
 * A host is told how it is reached, because a member that already paired will
 * come back to the address it was given once and a host that binds a random port
 * on every restart is unreachable afterwards. A member is told nothing: it
 * reconnects to the address pairing recorded, and passing a second address would
 * only be another thing to disagree with that record.
 */
function attachArgs(binary: string, pairing: MeshPairing): string[] {
  const args = [binary, 'attach']
  if (pairing.role !== 'host') return args
  args.push('--listen', meshHostListenAddress())
  const advertise = meshHostAdvertiseAddress()
  if (advertise !== undefined) args.push('--advertise', advertise)
  return args
}

async function runLoop(ctx: RunContext): Promise<void> {
  let attempt = 0
  while (!ctx.signal.aborted) {
    const reason = await runOnce(ctx)
    ctx.setWriter(null)
    if (ctx.signal.aborted) return
    attempt += 1
    const delayMs = meshRestartDelayMs(attempt, ctx.backoff)
    ctx.onRestart?.({ attempt, delayMs, reason })
    await ctx.sleep(delayMs, ctx.signal)
  }
}

/** Runs one sidecar process to completion and reports why it ended. */
async function runOnce(ctx: RunContext): Promise<string> {
  let proc: Bun.Subprocess
  try {
    proc = ctx.spawn(attachArgs(ctx.binary, ctx.pairing), {
      cwd: ctx.root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })
  } catch (error) {
    return `could not start the sidecar: ${message(error)}`
  }
  ctx.setWriter(writerFor(proc))

  const onAbort = () => terminateProcessGroup(proc)
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  const stderr =
    proc.stderr && typeof proc.stderr === 'object'
      ? readBoundedOutput(proc.stderr, 64_000).catch(() => '')
      : Promise.resolve('')

  let sawReady = false
  const handleLine = (line: string) => {
    ctx.onLine?.(line)
    const frame = parseMeshFrame(line)
    if (frame === undefined) return
    switch (frame.type) {
      case 'ready':
        if (frame.ready.protocol !== MESH_PROTOCOL_VERSION) {
          ctx.onFailure?.(`the workspace sidecar speaks protocol ${frame.ready.protocol}, but Elia understands ${MESH_PROTOCOL_VERSION}`)
          return
        }
        sawReady = true
        ctx.onReady?.(frame.ready)
        break
      case 'invite':
        ctx.onInvite?.(frame.invite)
        break
      case 'change':
        ctx.onFileChange?.(toFileChange(frame.change))
        break
      case 'event':
        ctx.onEvent?.(frame.event)
        break
      case 'control':
        ctx.onControl?.(frame.control)
        break
      case 'error':
        ctx.onFailure?.(frame.message)
        break
    }
  }

  try {
    const [exitCode, err] = await Promise.all([
      proc.stdout && typeof proc.stdout === 'object' ? pumpLines(proc.stdout, handleLine).then(() => proc.exited) : proc.exited,
      stderr,
    ])
    if (ctx.signal.aborted) return 'stopped'
    const detail = lastNonEmptyLine(err)
    if (exitCode !== 0) return `exited with code ${exitCode}${detail ? `: ${detail}` : ''}`
    return sawReady ? 'exited cleanly' : 'exited before it was ready'
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
    // A stop while the process is alive must take the whole group down, not
    // just the frame reader.
    if (ctx.signal.aborted) terminateProcessGroup(proc)
  }
}

/**
 * A stdin writer for a running sidecar.
 *
 * `write` is asynchronous and the sidecar may already be gone, so a rejected
 * write is reported as false rather than thrown: replication treats that as
 * "not delivered", keeps its cursor, and retries. Throwing here would land in a
 * background timer where nothing surfaces it.
 */
function writerFor(proc: Bun.Subprocess): MeshWriter {
  const sink = proc.stdin as unknown as { write?(chunk: string | Uint8Array): number | Promise<number>; end?(): void } | undefined
  if (!sink || typeof sink.write !== 'function') return () => false
  return (line) => {
    try {
      const result = sink.write!(line)
      if (result instanceof Promise) {
        result.then(undefined, () => {})
        return true
      }
      return true
    } catch {
      return false
    }
  }
}

function toFileChange(change: MeshChange): MeshFileChange {
  const incoming = toIncomingFileChange(change)
  return {
    meta: buildFileChangedPayload(incoming),
    incoming,
    conflict: change.conflict,
    ...(change.keptPath !== undefined ? { keptPath: change.keptPath } : {}),
    ...(change.reason !== undefined ? { reason: change.reason } : {}),
  }
}

/** Decodes a byte stream into lines, tolerating CRLF and a final unterminated line. */
async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const flush = (raw: string) => onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        flush(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer !== '') flush(buffer)
  } finally {
    reader.releaseLock()
  }
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.at(-1)
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
