import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { SESSIONS_DIR } from './session.ts'
import { tierConfig } from './config.ts'
import type { ChatMessage, ContentBlock } from './providers/types.ts'

/**
 * The episodic ledger: what compaction.ts throws out of the *live* prompt is not
 * lost, it is archived here as structured, immutable facts. This is what makes
 * elia's context effectively unbounded rather than merely bounded-and-lossy — the
 * live window stays small (compaction.ts's job), but everything it ever compacted
 * away is still addressable on disk (this module's job) and searchable on demand
 * (recall.ts + tools/recall.ts).
 *
 * Append-only by design: an "episode" line is written once and never rewritten.
 * Usage signals (recalled/confirmed) are separate event lines folded on load —
 * this avoids read-modify-write races on a file a concurrent process could also
 * be touching, and keeps every write a single atomic append.
 */

export interface LedgerRecord {
  id: string
  /** The interactive-session checkpoint turn this episode was archived under — links back to checkpoint.ts's file snapshots. */
  turn: number
  at: number
  /** How many raw messages this episode replaced in the live window. */
  messageCount: number
  summary: string
  decisions: string[]
  filesTouched: string[]
  symbols: string[]
  openThreads: string[]
  /** Times a recall() query matched this episode — a frequency signal. */
  recallCount: number
  /** Times a tool call shortly after a recall actually touched one of this episode's files — a stronger, verified-use signal. */
  confirmedUseCount: number
}

type StoredEpisode = Omit<LedgerRecord, 'recallCount' | 'confirmedUseCount'>
type LedgerLine =
  | ({ type: 'episode' } & StoredEpisode)
  | { type: 'recalled'; id: string; at: number }
  | { type: 'confirmed'; id: string; at: number }

function ledgerPath(sessionId: string, dir: string): string {
  return join(dir, `${sessionId}.ledger.jsonl`)
}

function newEpisodeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function appendLine(sessionId: string, line: LedgerLine, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await appendFile(ledgerPath(sessionId, dir), `${JSON.stringify(line)}\n`)
}

/** Reads every archived episode for a session, folding usage events onto their episode by id. */
export async function loadLedger(sessionId: string, dir: string = SESSIONS_DIR): Promise<LedgerRecord[]> {
  const file = Bun.file(ledgerPath(sessionId, dir))
  if (!(await file.exists())) return []

  const episodes = new Map<string, LedgerRecord>()
  const text = await file.text()
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue
    let parsed: LedgerLine
    try {
      parsed = JSON.parse(rawLine) as LedgerLine
    } catch {
      continue // a torn/partial line must never break loading the rest of the ledger
    }

    if (parsed.type === 'episode') {
      episodes.set(parsed.id, { ...parsed, recallCount: 0, confirmedUseCount: 0 })
    } else if (parsed.type === 'recalled') {
      const episode = episodes.get(parsed.id)
      if (episode) episode.recallCount += 1
    } else if (parsed.type === 'confirmed') {
      const episode = episodes.get(parsed.id)
      if (episode) episode.confirmedUseCount += 1
    }
  }

  return [...episodes.values()].sort((a, b) => a.turn - b.turn || a.at - b.at)
}

export async function countEpisodes(sessionId: string, dir: string = SESSIONS_DIR): Promise<number> {
  return (await loadLedger(sessionId, dir)).length
}

/** Every session id that has an archived ledger on disk — the reach of cross-session recall and the brain. */
export function listLedgerSessionIds(dir: string = SESSIONS_DIR): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.ledger.jsonl'))
      .map((name) => name.slice(0, -'.ledger.jsonl'.length))
  } catch {
    return []
  }
}

async function appendEpisode(sessionId: string, episode: StoredEpisode, dir: string): Promise<void> {
  await appendLine(sessionId, { type: 'episode', ...episode }, dir)
}

export async function bumpRecall(sessionId: string, ids: string[], dir: string = SESSIONS_DIR): Promise<void> {
  const at = Date.now()
  for (const id of ids) await appendLine(sessionId, { type: 'recalled', id, at }, dir)
}

export async function bumpConfirmed(sessionId: string, id: string, dir: string = SESSIONS_DIR): Promise<void> {
  await appendLine(sessionId, { type: 'confirmed', id, at: Date.now() }, dir)
}

/**
 * The session the REPL turn currently in flight belongs to — set by index.ts
 * around each turn, the same module-level-pointer pattern checkpoint.ts uses for
 * its file tracker (compaction fires several call frames down inside the agent
 * loop, and sub-agents spawned via `task` reach this in-process too).
 */
export interface ActiveLedgerSession {
  id: string
  turn: number
  /** Overrides where events are persisted — only ever set by tests; production always uses SESSIONS_DIR. */
  dir?: string
}

let activeSession: ActiveLedgerSession | undefined

export function setActiveLedgerSession(session: ActiveLedgerSession | undefined): void {
  activeSession = session
}

export function getActiveLedgerSession(): ActiveLedgerSession | undefined {
  return activeSession
}

// --- Self-tuning relevance: the "confirmed use" half of the signal ---
//
// recall() marks the files of whatever it returns as "pending" for a short
// window of subsequent tool calls. If one of those calls actually touches a
// pending file, that's real evidence the recalled episode was useful — not just
// that its text happened to match a query — so it earns a stronger boost than a
// plain recall match. Nothing here blocks or throws: a missed confirmation just
// means the episode ranks on recallCount alone next time.

const CONFIRMATION_WINDOW_STEPS = 6

interface PendingRecall {
  id: string
  remainingSteps: number
}

let pendingByFile = new Map<string, PendingRecall>()
// noteToolUse is called synchronously from the agent loop's onTool hook (which
// isn't async), so the confirmation write below is deliberately fire-and-forget —
// it's best-effort telemetry, never something a tool call should wait on. Tracked
// here purely so tests can await it instead of racing a background write.
let pendingWrites: Promise<void>[] = []

export function markRecalled(records: LedgerRecord[]): void {
  for (const record of records) {
    for (const file of record.filesTouched) {
      pendingByFile.set(file, { id: record.id, remainingSteps: CONFIRMATION_WINDOW_STEPS })
    }
  }
}

/** Called once per tool call from the agent loop's onTool hook. */
export function noteToolUse(input: Record<string, unknown>): void {
  if (pendingByFile.size === 0) return
  const path = typeof input.path === 'string' ? input.path : undefined
  const session = activeSession

  for (const [file, pending] of pendingByFile) {
    if (path && file === path) {
      pendingByFile.delete(file)
      if (session) pendingWrites.push(bumpConfirmed(session.id, pending.id, session.dir))
      continue
    }
    pending.remainingSteps -= 1
    if (pending.remainingSteps <= 0) pendingByFile.delete(file)
  }
}

/** Test-only: clears the confirmation window state between runs. */
export function resetPendingRecalls(): void {
  pendingByFile = new Map()
  pendingWrites = []
}

/** Test-only: waits for any fire-and-forget confirmation writes noteToolUse kicked off. */
export async function flushPendingConfirmations(): Promise<void> {
  await Promise.all(pendingWrites)
}

const ARCHIVE_SYSTEM_PROMPT = `You compress an agent's conversation history into a structured episodic record for its long-term memory.
Respond with ONLY a JSON object, no markdown fences, no commentary, shaped exactly like:
{"summary": "...", "decisions": ["..."], "filesTouched": ["..."], "symbols": ["..."], "openThreads": ["..."]}
"summary": 200-400 words of prose covering what the user asked for, what was actually done (files touched, commands run, real results), decisions and their reasons, and anything unresolved or explicitly deferred. This is prepended to the live conversation for the same agent to act on, not a report for a human.
"decisions": short phrases for concrete decisions made and why.
"filesTouched": file paths referenced or edited.
"symbols": function/class/config names worth remembering.
"openThreads": anything explicitly deferred or left unresolved.
Every array may be empty if nothing qualifies.`

function renderForArchive(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') lines.push(`${message.role}: ${block.text}`)
      else if (block.type === 'tool_use') lines.push(`${message.role} called ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`)
      else if (block.type === 'tool_result') lines.push(`  → ${block.content.slice(0, 400)}`)
      // thinking/redacted_thinking: private reasoning, not needed for a factual digest.
    }
  }
  return lines.join('\n')
}

interface ParsedArchive {
  summary: string
  decisions: string[]
  filesTouched: string[]
  symbols: string[]
  openThreads: string[]
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Tolerant of a model that doesn't follow the JSON instruction (older/smaller
 * models, or a stub in tests) — falls back to treating the whole response as the
 * prose summary with empty structured fields, so a bad extraction degrades to
 * exactly today's plain-summary behaviour instead of losing the episode entirely.
 */
function parseArchiveResponse(raw: string): ParsedArchive {
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
      if (typeof parsed.summary === 'string') {
        return {
          summary: parsed.summary,
          decisions: toStringArray(parsed.decisions),
          filesTouched: toStringArray(parsed.filesTouched),
          symbols: toStringArray(parsed.symbols),
          openThreads: toStringArray(parsed.openThreads),
        }
      }
    } catch {
      // fall through — treat the whole response as prose
    }
  }
  return { summary: trimmed, decisions: [], filesTouched: [], symbols: [], openThreads: [] }
}

/**
 * Archives one compacted episode: a single fast-tier call produces both the prose
 * fold-in compaction.ts prepends to the live prompt (the return value) and, when a
 * session is active, the structured record persisted to the ledger. Never throws —
 * an archival failure must not break the compaction it was supporting.
 */
export async function archiveEpisode(messages: ChatMessage[], dir: string = SESSIONS_DIR): Promise<string | undefined> {
  const rendered = renderForArchive(messages)
  if (!rendered.trim()) return undefined

  try {
    const fast = tierConfig('fast')
    let text = ''
    await fast.provider.streamTurn({
      system: ARCHIVE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: rendered.slice(0, 60_000) } as ContentBlock] }],
      tools: [],
      onText: (delta) => {
        text += delta
      },
    })

    const parsed = parseArchiveResponse(text)
    if (!parsed.summary.trim()) return undefined

    const session = getActiveLedgerSession()
    if (session) {
      const episode: StoredEpisode = {
        id: newEpisodeId(),
        turn: session.turn,
        at: Date.now(),
        messageCount: messages.length,
        summary: parsed.summary,
        decisions: parsed.decisions,
        filesTouched: parsed.filesTouched,
        symbols: parsed.symbols,
        openThreads: parsed.openThreads,
      }
      await appendEpisode(session.id, episode, dir)
    }

    return parsed.summary.trim()
  } catch {
    return undefined
  }
}
