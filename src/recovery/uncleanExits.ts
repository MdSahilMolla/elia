import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isProcessAlive } from '../fileLock.ts'
import { writeSecureFile } from '../securePersistence.ts'
import { relativeTime } from '../sessionCatalog.ts'
import { listKnownSessions } from '../sessionRegistry.ts'
import { paths } from '../statePaths.ts'
import { describeFault, readFaults, repeatedCrash, type FaultRecord } from './faults.ts'

/**
 * Finding out that elia died, on the next start.
 *
 * A crash handler can record an exception, but it cannot record a SIGKILL, an
 * out-of-memory kill, a closed laptop lid or a power cut — the process is gone
 * before any code of its own runs. So the evidence used here is the one that
 * survives all of them: every session writes a heartbeat and marks it ended on
 * a clean exit (sessionRegistry.ts), and every autonomous run writes `run-start`
 * and `run-end` (journal.ts). A heartbeat with no end, or a run with no end,
 * whose process no longer exists, died. That is true whatever killed it.
 *
 * What recovery means follows from what was lost. The conversation is saved
 * after every turn and the run's goal graph after every step, so the work up to
 * the last finished step is intact — what a person needs is to be told it died,
 * why if elia knows, and the one command that picks it back up. Each exit is
 * reported once.
 */

/** Older than this, a dead session is history, not something to recover. */
const RECENT_MS = 7 * 24 * 60 * 60_000

export interface UncleanExit {
  kind: 'session' | 'run'
  id: string
  /** When it was last seen alive. */
  at: number
  pid: number
  /** For a session: whether it died mid-turn. A run is always mid-work. */
  busy: boolean
  /** A session's last action, or a run's goal. */
  detail: string
  /** Whether there is anything to resume. */
  resumable: boolean
  /** The recorded exception that ended it, when a crash handler got to run. */
  fault?: FaultRecord
}

export interface FindOptions {
  sessionStatusDir?: string
  runsDir?: string
  sessionsDir?: string
  faultsPath?: string
  isAlive?: (pid: number) => boolean
  now?: number
  /** Exits already reported, by `${kind}:${id}`. */
  seen?: ReadonlySet<string>
}

interface RunStart {
  pid?: number
  goal?: string
  startedAt: number
  /** The last event's time — when the run was last seen alive. */
  at: number
  ended: boolean
}

function lastRunStart(eventsPath: string): RunStart | undefined {
  let text: string
  try {
    text = readFileSync(eventsPath, 'utf8')
  } catch {
    return undefined
  }
  let start: RunStart | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: { kind?: string; at?: number; data?: Record<string, unknown> }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.kind === 'run-start') {
      const at = typeof event.at === 'number' ? event.at : 0
      start = {
        pid: typeof event.data?.pid === 'number' ? event.data.pid : undefined,
        goal: typeof event.data?.goal === 'string' ? event.data.goal : undefined,
        startedAt: at,
        at,
        ended: false,
      }
    } else if (start) {
      if (typeof event.at === 'number') start.at = event.at
      if (event.kind === 'run-end') start.ended = true
    }
  }
  return start
}

export function exitKey(exit: Pick<UncleanExit, 'kind' | 'id'>): string {
  return `${exit.kind}:${exit.id}`
}

/**
 * Sessions and runs whose process died without a clean end, newest first.
 *
 * A pid that is alive is never reported, even if it might have been reused by
 * something else: claiming a live session died is the worse mistake. A run
 * from before `run-start` carried a pid is skipped for the same reason.
 */
export function findUncleanExits(options: FindOptions = {}): UncleanExit[] {
  const isAlive = options.isAlive ?? isProcessAlive
  const now = options.now ?? Date.now()
  const seen = options.seen ?? new Set<string>()
  const sessionsDir = options.sessionsDir ?? paths.sessions
  const faults = readFaults(options.faultsPath ?? paths.faults).filter((record) => record.fatal)
  // Bounded by the process's own lifetime, so a recycled pid cannot pin an old
  // crash on a session that never had it.
  const faultFor = (pid: number, since: number, sessionId?: string): FaultRecord | undefined =>
    [...faults].reverse().find((record) => {
      const at = Date.parse(record.at)
      return at >= since - 1_000 && (record.pid === pid || (sessionId !== undefined && record.sessionId === sessionId))
    })

  const exits: UncleanExit[] = []

  for (const beat of listKnownSessions(options.sessionStatusDir ?? paths.sessionStatus)) {
    if (now - beat.updatedAt > RECENT_MS) continue
    const exit: UncleanExit = {
      kind: 'session',
      id: beat.sessionId,
      at: beat.updatedAt,
      pid: beat.pid,
      busy: beat.busy,
      detail: beat.lastAction,
      resumable: beat.messageCount > 0 && existsSync(join(sessionsDir, `${beat.sessionId}.json`)),
    }
    if (seen.has(exitKey(exit)) || beat.pid === process.pid || isAlive(beat.pid)) continue
    // A crash handler that ran marks the session ended on its way out, so the
    // heartbeat alone says "clean". The fault record says otherwise.
    const fault = faultFor(beat.pid, beat.startedAt, beat.sessionId)
    if (beat.endedAt && !fault) continue
    exits.push(fault ? { ...exit, fault } : exit)
  }

  const runsDir = options.runsDir ?? paths.runs
  if (existsSync(runsDir)) {
    let names: string[] = []
    try {
      names = readdirSync(runsDir)
    } catch {
      names = []
    }
    for (const runId of names) {
      const eventsPath = join(runsDir, runId, 'events.ndjson')
      try {
        if (!existsSync(eventsPath) || now - statSync(eventsPath).mtimeMs > RECENT_MS) continue
      } catch {
        continue
      }
      const start = lastRunStart(eventsPath)
      if (!start || start.ended || start.pid === undefined) continue
      const exit: UncleanExit = {
        kind: 'run',
        id: runId,
        at: start.at,
        pid: start.pid,
        busy: true,
        detail: start.goal ?? '(unknown goal)',
        resumable: start.goal !== undefined,
      }
      if (seen.has(exitKey(exit)) || start.pid === process.pid || isAlive(start.pid)) continue
      const fault = faultFor(start.pid, start.startedAt)
      exits.push(fault ? { ...exit, fault } : exit)
    }
  }

  return exits.sort((a, b) => b.at - a.at)
}

export function readSeen(path: string = paths.recoverySeen): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { seen?: unknown }
    return new Set(Array.isArray(parsed.seen) ? parsed.seen.filter((key): key is string => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Remembers these exits as reported. Bounded, oldest dropped first. Never throws. */
export function markSeen(exits: readonly UncleanExit[], path: string = paths.recoverySeen): void {
  if (exits.length === 0) return
  try {
    const seen = [...readSeen(path), ...exits.map(exitKey)]
    writeSecureFile(path, JSON.stringify({ seen: [...new Set(seen)].slice(-500) }))
  } catch {
    // Being told twice is the cost of a failed write; failing a start is not.
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What died, why if elia knows, and the command that picks each one back up. */
export function describeUncleanExits(exits: readonly UncleanExit[], now = Date.now()): string | undefined {
  if (exits.length === 0) return undefined
  const lines = [exits.length === 1 ? 'elia did not exit cleanly last time:' : `elia did not exit cleanly ${exits.length} times:`]
  for (const exit of exits.slice(0, 5)) {
    const cause = exit.fault ? `it crashed: ${describeFault(exit.fault)}` : 'the process was killed or crashed before it could record why'
    if (exit.kind === 'session') {
      const state = exit.busy ? `mid-turn (${clip(exit.detail, 50)})` : 'while idle'
      lines.push(`  · session ${exit.id} stopped ${state} ${relativeTime(exit.at, now)} — ${cause}`)
      lines.push(exit.resumable ? `    its conversation up to the last finished turn is saved: elia --resume ${exit.id}` : '    it had no conversation to resume')
    } else {
      lines.push(`  · autonomous run ${exit.id} ("${clip(exit.detail, 60)}") was interrupted ${relativeTime(exit.at, now)} — ${cause}`)
      lines.push(`    its completed steps are kept: elia resume ${exit.id}`)
    }
  }
  if (exits.length > 5) lines.push(`  … and ${exits.length - 5} more (elia doctor lists them)`)
  if (exits.some((exit) => exit.fault)) lines.push('  elia doctor shows the recorded errors; elia doctor --repair fixes elia itself on a branch and merges nothing.')
  return lines.join('\n')
}

/**
 * The start-of-session notice: every unclean exit not yet reported, each once.
 * Never throws — finding out about the last crash must not become the next one.
 */
export function takeRecoveryNotice(options: FindOptions & { seenPath?: string } = {}): string | undefined {
  try {
    const exits = findUncleanExits({ ...options, seen: readSeen(options.seenPath) })
    const text = describeUncleanExits(exits, options.now)
    markSeen(exits, options.seenPath)
    return text
  } catch {
    return undefined
  }
}

/**
 * Whether the same bug has recently ended elia more than once. Starting the
 * same unattended work again would most likely end the same way, so the
 * caller holds it back and says why.
 */
export function crashLoop(options: { faultsPath?: string; now?: number } = {}): { signature: string; count: number; summary: string } | undefined {
  try {
    return repeatedCrash(readFaults(options.faultsPath ?? paths.faults), options.now)
  } catch {
    return undefined
  }
}
