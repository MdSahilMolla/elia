import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logSwallowedError } from '../diagnostics.ts'
import { appendSecureFile, hardenSecureFile } from '../securePersistence.ts'
import { redactArchiveValue, redactSecrets } from '../ui/redact.ts'
import type { Transcript, TranscriptItem } from '../ui/transcript.ts'

/**
 * The live half of an Elia Book: everything a session does, appended to disk as
 * it happens.
 *
 * A Book used to exist only if someone remembered to `/eliabook save` at the end,
 * and what it kept was a snapshot taken at that moment — a session that crashed,
 * was killed, or simply was never saved left nothing behind. The recorder taps
 * the session transcript (`Transcript.observe`), the one place every user line,
 * reply, tool call and its full result, notice, error and shell output already
 * passes through, so it sees exactly what the session saw, including its
 * sub-agents, and writes each event as one NDJSON line the moment it lands. The
 * file is the source of truth: the playbook, the search index and crash recovery
 * are all derived from it (see eliaBook.ts and recordingIndex.ts).
 *
 * On by default, because a recorder that has to be remembered is the thing it
 * replaces. What keeps that safe: every string goes through the same secret
 * redaction the transcript export uses; private reasoning is never written;
 * one event is clipped at `MAX_EVENT_TEXT` and one recording stops at
 * `MAX_RECORDING_BYTES` (with a row saying so, never silently); the files are
 * owner-only; and old recordings are pruned. `ELIA_RECORD=off` or `--no-record`
 * turns it off.
 */

const SAFE_SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,99}$/i

/** One event's text or tool input; a `write_file` of a whole module would otherwise dominate the file. */
const MAX_EVENT_TEXT = 20_000
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024

const DEFAULT_KEEP = 60
const DEFAULT_MAX_AGE_MS = 45 * 86_400_000

export interface RecordedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
  elapsedMs: number
}

type Body =
  | { kind: 'session-start'; sessionId: string; mode: string; model: string; resumedFrom?: string }
  | { kind: 'user' | 'assistant' | 'notice' | 'error' | 'shell'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; status: 'ok' | 'error' | 'cached'; result: string; durationMs: number; actor?: string; decision?: string }
  /** Written by the REPL when a turn ends: what it did to the tree and how it was judged. */
  | { kind: 'turn-end'; outcome: string; verify: string; repairAttempts: number; touched: string[]; usage: RecordedUsage }
  /** A lesson this turn taught; `from` is the first event of that turn, so the lesson points at what produced it. */
  | { kind: 'lesson'; text: string; from: number }
  | { kind: 'truncated'; reason: string }
  | { kind: 'session-end'; recovered?: boolean }

export type RecordedEvent = { seq: number; at: number; turn: number } & Body

export interface RecordingFile {
  sessionId: string
  path: string
  size: number
  mtimeMs: number
}

export function recordingsDir(cwd: string): string {
  return join(cwd, '.elia', 'recordings')
}

/** Where a session's recording lives, or `undefined` for an id that could not be a session (it names a file). */
export function recordingPath(cwd: string, sessionId: string): string | undefined {
  return SAFE_SESSION_ID.test(sessionId) ? join(recordingsDir(cwd), `${sessionId}.ndjson`) : undefined
}

/** The project-relative name a Book records, so a Book can be moved with its project. */
export function recordingReference(sessionId: string): string {
  return `.elia/recordings/${sessionId}.ndjson`
}

/** Recording is on unless the environment says otherwise; the CLI's `--no-record` is applied by the caller. */
export function recordingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !['0', 'false', 'off', 'no'].includes(env.ELIA_RECORD?.trim().toLowerCase() ?? '')
}

/** Every event in a recording; a torn last line (a killed process) costs that line and nothing before it. */
export function readRecording(path: string): RecordedEvent[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line) as Partial<RecordedEvent> | null
      return value && typeof value === 'object' && typeof value.seq === 'number' && typeof value.kind === 'string' ? [value as RecordedEvent] : []
    } catch {
      return []
    }
  })
}

/** Enough to hold the last event even when it is a clipped 20,000-character tool result. */
const TAIL_BYTES = 65_536

/**
 * The last event in a recording, read from the end of the file. Starting up
 * asks this of every recording in the project, and a recording can be 25 MB;
 * parsing all of it to learn how it ended would be paid on every launch.
 */
export function lastRecordedEvent(path: string): RecordedEvent | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]!.trim()) continue
      try {
        const value = JSON.parse(lines[index]!) as Partial<RecordedEvent> | null
        if (value && typeof value.seq === 'number' && typeof value.kind === 'string') return value as RecordedEvent
      } catch {
        // A torn line, or the cut-off start of the tail: keep looking backwards.
      }
    }
  } catch {
    // No such file, or unreadable.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return undefined
}

/**
 * Closes a recording whose process never did — a kill, a crash, a closed
 * terminal — by appending the `session-end` row it missed, marked `recovered`.
 * False when it was already closed or has nothing in it.
 */
export function closeOrphanedRecording(path: string, at: number = Date.now()): boolean {
  const last = lastRecordedEvent(path)
  if (!last || last.kind === 'session-end') return false
  appendSecureFile(path, `${JSON.stringify({ seq: last.seq + 1, at, turn: last.turn, kind: 'session-end', recovered: true })}\n`)
  return true
}

/** Recordings in a project, newest first. */
export function listRecordings(cwd: string): RecordingFile[] {
  const dir = recordingsDir(cwd)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.ndjson'))
    .flatMap((name) => {
      const sessionId = name.slice(0, -'.ndjson'.length)
      if (!SAFE_SESSION_ID.test(sessionId)) return []
      try {
        const stats = statSync(join(dir, name))
        return [{ sessionId, path: join(dir, name), size: stats.size, mtimeMs: stats.mtimeMs }]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export interface PruneOptions {
  /** Sessions whose recording a Book still points at — never removed. */
  protect?: ReadonlySet<string>
  /** The session in progress. */
  current?: string
  keep?: number
  maxAgeMs?: number
  now?: number
}

/** Removes recordings past the newest `keep` or older than `maxAgeMs`, except protected ones. Returns how many went. */
export function pruneRecordings(cwd: string, options: PruneOptions = {}): number {
  const keep = options.keep ?? DEFAULT_KEEP
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const now = options.now ?? Date.now()
  let removed = 0
  listRecordings(cwd).forEach((file, index) => {
    if (file.sessionId === options.current || options.protect?.has(file.sessionId)) return
    if (index < keep && now - file.mtimeMs <= maxAgeMs) return
    try {
      rmSync(file.path, { force: true })
      removed += 1
    } catch {
      // Held open or already gone; the next start prunes again.
    }
  })
  return removed
}

export interface RecorderSession {
  sessionId: string
  path: string
  /** The sequence number the next event will get. */
  nextSeq: number
  /** The first event of the turn in progress. */
  turnStart: number
}

export interface SessionRecorder {
  /** Start listening to a transcript. Returns the function that stops. */
  attach(transcript: Transcript): () => void
  /** Begin recording `sessionId` (appending, if it has a recording already). Does nothing when recording is off. */
  begin(sessionId: string, info: { mode: string; model: string; resumedFrom?: string }): void
  turnEnd(info: { outcome: string; verify: string; repairAttempts: number; touched: string[]; usage: RecordedUsage }): void
  lesson(text: string): void
  /** Closes the recording in progress and says which one it was; `undefined` when nothing was being recorded. */
  finish(): { sessionId: string; path: string } | undefined
  current(): RecorderSession | undefined
}

function clip(text: string): string {
  const redacted = redactSecrets(text)
  return redacted.length > MAX_EVENT_TEXT ? `${redacted.slice(0, MAX_EVENT_TEXT)}\n…[${redacted.length - MAX_EVENT_TEXT} more characters not recorded]` : redacted
}

function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactArchiveValue(input) as Record<string, unknown>
  const json = JSON.stringify(redacted)
  return json.length > MAX_EVENT_TEXT ? { _truncated: clip(json) } : redacted
}

export function createSessionRecorder(options: { cwd: string; enabled?: boolean; now?: () => number; maxBytes?: number }): SessionRecorder {
  const now = options.now ?? Date.now
  const maxBytes = options.maxBytes ?? MAX_RECORDING_BYTES
  let session: { id: string; path: string } | undefined
  let seq = 0
  let bytes = 0
  let turn = 0
  let turnStart = 0
  let stopped = false
  let ended = false

  /** `force` is for the closing row, which must land even in a recording that hit its cap. */
  function emit(body: Body, force = false): number | undefined {
    if (!session || (stopped && !force)) return undefined
    const event = { seq, at: now(), turn, ...body } as RecordedEvent
    let line = `${JSON.stringify(event)}\n`
    if (!force && bytes + Buffer.byteLength(line) > maxBytes) {
      // Say so in the file: a cap that failed silently would read as a complete recording.
      stopped = true
      line = `${JSON.stringify({ seq, at: event.at, turn, kind: 'truncated', reason: `recording reached its ${Math.round(maxBytes / 1024)} KB limit` })}\n`
    }
    try {
      appendSecureFile(session.path, line)
    } catch (error) {
      stopped = true
      logSwallowedError('session-recorder', error, { sessionId: session.id })
      return undefined
    }
    bytes += Buffer.byteLength(line)
    seq += 1
    return event.seq
  }

  function record(item: TranscriptItem): void {
    turn = item.turn
    // Private reasoning is never written down; the transcript export leaves it out too.
    if (item.kind === 'thinking') return
    if (item.kind === 'user') turnStart = seq
    if (item.kind === 'tool') {
      emit({ kind: 'tool', name: item.name, input: clipInput(item.input), status: item.status, result: clip(item.result), durationMs: item.durationMs, ...(item.actor ? { actor: item.actor } : {}), ...(item.decision ? { decision: item.decision } : {}) })
    } else {
      emit({ kind: item.kind, text: clip(item.text) })
    }
  }

  return {
    attach: (transcript) => transcript.observe(record),
    begin(sessionId, info) {
      session = undefined
      ended = false
      if (options.enabled === false) return
      const path = recordingPath(options.cwd, sessionId)
      if (!path) return
      seq = (lastRecordedEvent(path)?.seq ?? -1) + 1
      bytes = existsSync(path) ? statSync(path).size : 0
      stopped = bytes >= maxBytes
      turn = 0
      turnStart = seq
      session = { id: sessionId, path }
      emit({ kind: 'session-start', sessionId, mode: info.mode, model: info.model, ...(info.resumedFrom ? { resumedFrom: info.resumedFrom } : {}) })
    },
    turnEnd(info) {
      emit({ kind: 'turn-end', outcome: info.outcome, verify: info.verify, repairAttempts: info.repairAttempts, touched: info.touched.slice(0, 200), usage: info.usage })
    },
    lesson(text) {
      emit({ kind: 'lesson', text: clip(text), from: turnStart })
    },
    finish() {
      if (!session || ended) return undefined
      ended = true
      emit({ kind: 'session-end' }, true)
      return { sessionId: session.id, path: session.path }
    },
    current: () => (session ? { sessionId: session.id, path: session.path, nextSeq: seq, turnStart } : undefined),
  }
}
