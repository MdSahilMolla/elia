import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config.ts'
import type { ConversationMessage } from '../agentLoop.ts'

/**
 * An append-only log of everything an autonomous run did.
 *
 * This is not telemetry — it is what makes a run *re-enterable*. Because every
 * phase writes a checkpoint of the exact message array it started from, any run
 * can later be rewound to a decision point and re-run differently (see
 * rewind.ts). Agents normally leave behind only a transcript you can read; this
 * leaves behind one you can branch from.
 */

export type JournalEventKind =
  | 'run-start'
  | 'phase'
  | 'proposal'
  | 'approval'
  | 'step-start'
  | 'step-end'
  | 'tool'
  | 'verify'
  | 'verdict'
  | 'lesson'
  | 'checkpoint'
  | 'run-end'

export interface JournalEvent {
  seq: number
  at: number
  kind: JournalEventKind
  data: Record<string, unknown>
}

export interface Journal {
  runId: string
  dir: string
  append(kind: JournalEventKind, data?: Record<string, unknown>): JournalEvent
  /** Snapshots a message array so this point in the run can be forked later. Returns the checkpoint id. */
  checkpoint(label: string, messages: ConversationMessage[]): number
  events(): JournalEvent[]
}

export function newRunId(): string {
  return `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).slice(-4)}-${Math.random().toString(36).slice(2, 6)}`
}

export function runDir(runId: string): string {
  return join(paths.runs, runId)
}

export function createJournal(runId: string, goal: string): Journal {
  const dir = runDir(runId)
  mkdirSync(join(dir, 'checkpoints'), { recursive: true })
  const logPath = join(dir, 'events.ndjson')

  let seq = 0
  let checkpointCount = 0
  const recorded: JournalEvent[] = []

  const journal: Journal = {
    runId,
    dir,
    append(kind, data = {}) {
      const event: JournalEvent = { seq: seq++, at: Date.now(), kind, data }
      recorded.push(event)
      try {
        appendFileSync(logPath, `${JSON.stringify(event)}\n`)
      } catch {
        // A journal write failure must never abort the work it is describing.
      }
      return event
    },
    checkpoint(label, messages) {
      const id = checkpointCount++
      try {
        writeFileSync(
          join(dir, 'checkpoints', `${id}.json`),
          JSON.stringify({ id, label, at: Date.now(), messages }),
        )
        journal.append('checkpoint', { id, label, messageCount: messages.length })
      } catch {
        // Same: losing the ability to fork is not worth failing the run over.
      }
      return id
    },
    events() {
      return [...recorded]
    },
  }

  journal.append('run-start', { runId, goal, cwd: process.cwd() })
  return journal
}

export interface StoredCheckpoint {
  id: number
  label: string
  at: number
  messages: ConversationMessage[]
}

export function readEvents(runId: string): JournalEvent[] {
  const logPath = join(runDir(runId), 'events.ndjson')
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JournalEvent]
      } catch {
        return [] // a torn final line from an interrupted run
      }
    })
}

export function readCheckpoint(runId: string, id: number): StoredCheckpoint | undefined {
  const path = join(runDir(runId), 'checkpoints', `${id}.json`)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredCheckpoint
  } catch {
    return undefined
  }
}

export function listCheckpoints(runId: string): StoredCheckpoint[] {
  const dir = join(runDir(runId), 'checkpoints')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readCheckpoint(runId, Number.parseInt(name, 10)))
    .filter((checkpoint): checkpoint is StoredCheckpoint => checkpoint !== undefined)
    .sort((a, b) => a.id - b.id)
}

export interface RunSummary {
  runId: string
  goal: string
  startedAt: number
  updatedAt: number
  checkpoints: number
  outcome: string
}

export function listRuns(limit = 20): RunSummary[] {
  if (!existsSync(paths.runs)) return []

  return readdirSync(paths.runs)
    .filter((name) => existsSync(join(paths.runs, name, 'events.ndjson')))
    .map((runId): RunSummary => {
      const events = readEvents(runId)
      const start = events.find((event) => event.kind === 'run-start')
      const end = [...events].reverse().find((event) => event.kind === 'run-end')
      return {
        runId,
        goal: typeof start?.data.goal === 'string' ? start.data.goal : '(unknown goal)',
        startedAt: start?.at ?? statSync(join(paths.runs, runId)).mtimeMs,
        updatedAt: events.at(-1)?.at ?? 0,
        checkpoints: events.filter((event) => event.kind === 'checkpoint').length,
        outcome: typeof end?.data.outcome === 'string' ? end.data.outcome : 'incomplete',
      }
    })
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
}
