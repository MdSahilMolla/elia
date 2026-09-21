/**
 * One list of the conversations in this project, newest first.
 *
 * `session.ts` persists a conversation and loads one back by id; it has no
 * notion of "which conversations exist here". `sessionRegistry.ts` knows which
 * *processes* are live but nothing about what they were talking about. Resuming
 * another session needs both at once — you pick by what the conversation was
 * about, and you need to be told when the one you picked is still open in
 * another window — so the join lives here, and the CLI picker, `elia sessions`,
 * `/resume` and the `/sessions` dashboard all read this same list.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR, loadSession } from './session.ts'
import { listKnownSessions, type SessionLiveStatus } from './sessionRegistry.ts'
import { isProcessAlive } from './fileLock.ts'
import { paths } from './statePaths.ts'

/** How many conversations to read when no limit is given. Parsing costs ~2ms per session file. */
export const DEFAULT_CATALOG_LIMIT = 25

export interface SessionSummary {
  id: string
  /** When the conversation was last written (its own timestamp, falling back to the file's). */
  updatedAt: number
  messages: number
  /** User messages — a truer "how long was this" than the raw message count. */
  turns: number
  providerName?: string
  model?: string
  /** The first thing the user asked, for picking a session out of a list. */
  title: string
  /**
   * `saved` is the common case: a conversation on disk with no process holding
   * it. The rest come from the live heartbeat — `running`/`idle` mean another
   * elia has it open right now.
   */
  status: SessionLiveStatus | 'saved'
  pid?: number
  /**
   * A process is provably alive and holding this session. Resuming it anyway
   * means two processes writing one file, so every entry point warns first.
   */
  heldByLiveProcess: boolean
  /** False for a session that registered a heartbeat but never saved a turn. */
  hasConversation: boolean
  /** What that other process said it was doing, when one is (or was) attached. */
  lastAction?: string
}

interface CatalogOptions {
  dir?: string
  statusDir?: string
  /** Conversations to read, newest first. `0` means every one of them. */
  limit?: number
}

/**
 * Every conversation id here, newest first, without reading a single one.
 *
 * Resolving `--resume <id>` only needs the names, and a project accumulates
 * hundreds of sessions — parsing them all to answer "does this id exist" would
 * cost half a second to learn something the directory listing already knows.
 */
export function listSessionIds(dir: string = SESSIONS_DIR): { id: string; mtime: number }[] {
  return conversationIds(dir)
}

/** `<id>.json` only — never `<id>.checkpoints.json`, a `.ledger.jsonl`, or a half-written temp file. */
function conversationIds(dir: string): { id: string; mtime: number }[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found: { id: string; mtime: number }[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)?$/i.test(id) || id.length > 100) continue
    try {
      found.push({ id, mtime: statSync(join(dir, name)).mtimeMs })
    } catch {
      // Rotated or removed by a concurrent elia between readdir and stat.
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

/**
 * The first line the user actually typed.
 *
 * A user message carries the typed text in its first text block and everything
 * elia folded in afterwards — the plan it showed, `!cmd` output, attachment
 * notes — in the blocks after it, so only the first block is read here.
 */
export function sessionTitle(messages: { role: string; content: unknown[] }[]): string {
  const first = messages.find((message) => message.role === 'user')
  const block = first?.content.find((item): item is { type: 'text'; text: string } => {
    const candidate = item as { type?: unknown; text?: unknown }
    return candidate?.type === 'text' && typeof candidate.text === 'string'
  })
  const text = (block?.text ?? '')
    .replace(/<elia-plan>[\s\S]*?<\/elia-plan>/g, ' ')
    .replace(/<local-command>[\s\S]*?<\/output>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || '(no prompt yet)'
}

export async function listSessionSummaries(options: CatalogOptions = {}): Promise<SessionSummary[]> {
  const dir = options.dir ?? SESSIONS_DIR
  const statusDir = options.statusDir ?? paths.sessionStatus
  const limit = options.limit ?? DEFAULT_CATALOG_LIMIT

  const heartbeats = new Map(listKnownSessions(statusDir).map((session) => [session.sessionId, session]))
  const ids = conversationIds(dir)
  const selected = limit > 0 ? ids.slice(0, limit) : ids

  const summaries: SessionSummary[] = []
  for (const { id, mtime } of selected) {
    const stored = await loadSession(id, dir)
    if (!stored) continue
    const beat = heartbeats.get(id)
    heartbeats.delete(id)
    summaries.push({
      id,
      updatedAt: stored.updatedAt || mtime,
      messages: stored.messages.length,
      turns: stored.messages.filter((message) => message.role === 'user').length,
      providerName: stored.providerName,
      model: stored.model,
      title: sessionTitle(stored.messages),
      status: beat?.liveStatus ?? 'saved',
      pid: beat?.pid,
      heldByLiveProcess: isHeld(beat),
      hasConversation: true,
      lastAction: beat?.lastAction,
    })
  }

  // A session that registered a heartbeat but has not saved a turn yet: only
  // worth listing while a process still holds it, since there is nothing to
  // resume once that process is gone.
  for (const beat of heartbeats.values()) {
    if (!isHeld(beat)) continue
    summaries.push({
      id: beat.sessionId,
      updatedAt: beat.updatedAt,
      messages: beat.messageCount,
      turns: 0,
      model: beat.model,
      title: beat.lastAction || '(nothing saved yet)',
      status: beat.liveStatus,
      pid: beat.pid,
      heldByLiveProcess: true,
      hasConversation: false,
      lastAction: beat.lastAction,
    })
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

function isHeld(beat: { liveStatus: SessionLiveStatus; pid: number; endedAt?: number } | undefined): boolean {
  if (!beat || beat.endedAt) return false
  if (beat.liveStatus !== 'running' && beat.liveStatus !== 'idle') return false
  return isProcessAlive(beat.pid)
}

/**
 * The live elia process holding this conversation, if there is one.
 *
 * Two processes on one session id both save the whole conversation on every
 * turn, so the second one to write wins and the other's turns are gone. Every
 * way into a session asks this first.
 */
export function sessionHolder(id: string, statusDir: string = paths.sessionStatus): { pid: number; lastAction: string } | undefined {
  const beat = listKnownSessions(statusDir).find((session) => session.sessionId === id)
  return beat && isHeld(beat) ? { pid: beat.pid, lastAction: beat.lastAction } : undefined
}

export type SessionLookup =
  | { kind: 'found'; id: string }
  | { kind: 'ambiguous'; ids: string[] }
  | { kind: 'missing' }

/**
 * Resolves what the user typed after `--resume` / `/resume`: an exact id, or a
 * prefix of one, since the ids are timestamp-random and nobody types those from
 * memory.
 */
export function resolveSessionId(query: string, summaries: { id: string }[]): SessionLookup {
  const needle = query.trim()
  if (!needle) return { kind: 'missing' }
  if (summaries.some((session) => session.id === needle)) return { kind: 'found', id: needle }
  const prefixed = summaries.filter((session) => session.id.startsWith(needle))
  if (prefixed.length === 1) return { kind: 'found', id: prefixed[0]!.id }
  if (prefixed.length > 1) return { kind: 'ambiguous', ids: prefixed.map((session) => session.id) }
  return { kind: 'missing' }
}

export function relativeTime(ms: number, now = Date.now()): string {
  const deltaS = Math.max(0, Math.round((now - ms) / 1000))
  if (deltaS < 5) return 'just now'
  if (deltaS < 60) return `${deltaS}s ago`
  const deltaM = Math.round(deltaS / 60)
  if (deltaM < 60) return `${deltaM}m ago`
  const deltaH = Math.round(deltaM / 60)
  if (deltaH < 24) return `${deltaH}h ago`
  return `${Math.round(deltaH / 24)}d ago`
}

/** The one-line "what was this conversation" used by every picker and listing. */
export function describeSession(session: SessionSummary, width = 60): string {
  const flat = session.title.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, Math.max(1, width - 1))}…` : flat
}

/** The right-hand detail column: when, how long, on what, and who has it open. */
export function sessionDetail(session: SessionSummary, now = Date.now()): string {
  const parts = [relativeTime(session.updatedAt, now), `${session.turns} turn${session.turns === 1 ? '' : 's'}`]
  if (session.model) parts.push(session.model)
  if (session.heldByLiveProcess) parts.push(`open in pid ${session.pid}`)
  return parts.join(' · ')
}
