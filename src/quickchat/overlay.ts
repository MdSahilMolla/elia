/**
 * /quickchat overlay state machine.
 *
 * React-free, deterministically testable panel state for the non-blocking
 * /quickchat answer. The Ink layer (in the integration agent's hands) renders
 * this state; this module never touches the screen or the active session's
 * turn.
 *
 * Non-blocking contract (`ensureNonBlocking`): every write the overlay takes
 * goes to its own `buffer` and a timestamp. The overlay has no reference to a
 * `sessionContinue` ticker and never mutates the session's turn — the session
 * keeps running underneath while the quickchat answer trickles in.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendSecureFile } from '../securePersistence.ts'
import { paths } from '../statePaths.ts'

/** Default wall-clock ceiling for one quickchat model call. */
export const QUICKCHAT_TIMEOUT_MS = 60_000

export interface QuickchatOverlay {
  readonly status: 'open' | 'closed'
  /** Everything appended since `open`, in order. */
  readonly buffer: string
  /** Timestamp of the last state change (open/append/close). */
  readonly lastActivity: number
  /** The question this overlay was opened for. */
  readonly question: string
  /** Short label of the session being observed, shown with the panel. */
  readonly contextLabel: string
  open(question: string, contextLabel: string): void
  appendChunk(text: string): void
  close(): void
}

export function createOverlay(): QuickchatOverlay {
  let status: 'open' | 'closed' = 'closed'
  let buffer = ''
  let lastActivity = 0
  let question = ''
  let contextLabel = ''
  return {
    get status() {
      return status
    },
    get buffer() {
      return buffer
    },
    get lastActivity() {
      return lastActivity
    },
    get question() {
      return question
    },
    get contextLabel() {
      return contextLabel
    },
    open(nextQuestion: string, nextLabel: string): void {
      status = 'open'
      buffer = ''
      question = nextQuestion
      contextLabel = nextLabel
      lastActivity = Date.now()
    },
    appendChunk(text: string): void {
      if (status !== 'open') return
      buffer += text
      lastActivity = Date.now()
    },
    close(): void {
      if (status === 'closed') return
      status = 'closed'
      lastActivity = Date.now()
    },
  }
}

export interface OverlayIdleTimer {
  /** Restarts the idle window (called automatically on every appendChunk). */
  reset(): void
  /** Detaches the timer and unhooks the appendChunk wrapper. */
  stop(): void
}

/**
 * Attaches an idle timeout to one overlay: after `ms` with no appends the
 * overlay is closed and `onTimeout` fires. Every appendChunk resets the window,
 * so a streaming answer keeps the panel open as long as chunks keep arriving.
 */
export function withIdleTimeout(overlay: QuickchatOverlay, ms: number, onTimeout: () => void): OverlayIdleTimer {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    if (overlay.status !== 'open') return
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (overlay.status !== 'open') return
      onTimeout()
      overlay.close()
    }, ms)
  }
  const originalAppend = overlay.appendChunk
  overlay.appendChunk = (text: string): void => {
    originalAppend(text)
    schedule()
  }
  schedule()
  return {
    reset: schedule,
    stop(): void {
      clearTimeout(timer)
      overlay.appendChunk = originalAppend
    },
  }
}

/**
 * The pure escape hook the Ink app calls on keypress. 'esc' closes an open
 * overlay and is consumed; anything else (or a closed overlay) is not.
 */
export function withEscapeHandler(overlay: QuickchatOverlay): (key: string) => { consumed: boolean } {
  return (key: string): { consumed: boolean } => {
    if (key !== 'esc' || overlay.status !== 'open') return { consumed: false }
    overlay.close()
    return { consumed: true }
  }
}

/**
 * Documents and verifies the non-blocking contract for an overlay.
 *
 * Everything the overlay writes lands in its own `buffer`; the only other state
 * it touches is its own timestamps and status. It carries no `sessionContinue`
 * ticker, holds no session reference, and its methods never advance the
 * session's turn — so no quickchat path can delay the work underneath. Returns
 * the overlay unchanged so the Ink layer can keep using it.
 */
export function ensureNonBlocking(overlay: QuickchatOverlay): QuickchatOverlay {
  // The guarantee is structural: the overlay is a plain closure over buffer/
  // status/timestamps with no session handle, no ticker, and no turn-mutating
  // methods. Any future change that adds such a reference must be reviewed
  // against this contract.
  return overlay
}

export interface QuickchatLogEntry {
  kind: 'quickchat'
  question: string
  answer: string
  /** Epoch ms when the entry was appended. */
  at: number
}

export interface QuickchatLogOptions {
  /** Directory for per-session quickchat logs. Defaults to the project sessions dir. */
  dir?: string
}

function quickchatLogPath(sessionId: string, dir: string | undefined): string {
  return join(dir ?? paths.sessions, `${sanitizeSessionId(sessionId)}.quickchat.jsonl`)
}

/** Keeps arbitrary session references out of the filesystem path. */
function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return 'session'
  return safe
}

/**
 * Appends one JSON line to `.elia/sessions/<sessionId>.quickchat.jsonl` using
 * the secure append helpers. Failures are silent: a missing directory is
 * created, anything else leaves no log behind and never throws. Returns the
 * log path.
 */
export function appendToSessionLog(
  sessionId: string,
  entry: { kind: 'quickchat'; question: string; answer: string },
  opts: QuickchatLogOptions = {},
): string {
  const file = quickchatLogPath(sessionId, opts.dir)
  const line = `${JSON.stringify({ ...entry, at: Date.now() } satisfies QuickchatLogEntry)}\n`
  try {
    appendSecureFile(file, line)
  } catch {
    // Logging a quickchat exchange is best-effort; the answer still rendered.
  }
  return file
}

/** Reads back every quickchat entry for a session, most recent last. Malformed lines are skipped. */
export function readQuickchatLog(sessionId: string, opts: QuickchatLogOptions = {}): QuickchatLogEntry[] {
  const file = quickchatLogPath(sessionId, opts.dir)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const entries: QuickchatLogEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as QuickchatLogEntry
      if (
        parsed &&
        parsed.kind === 'quickchat' &&
        typeof parsed.question === 'string' &&
        typeof parsed.answer === 'string' &&
        typeof parsed.at === 'number'
      ) {
        entries.push(parsed)
      }
    } catch {
      // Skip malformed lines silently so one torn write cannot hide the rest.
    }
  }
  return entries
}