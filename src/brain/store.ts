import { basename } from 'node:path'
import { paths } from '../config.ts'
import { listLedgerSessionIds, loadLedger, type LedgerRecord } from '../ledger.ts'
import { loadLessons } from '../autonomy/lessons.ts'
import { loadRationale, RATIONALE_PATH } from '../autonomy/rationale.ts'
import { loadNotes } from './notes.ts'

/**
 * The read layer of elia's second brain: one merged, typed view over every
 * durable knowledge source in a project — episodes from *all* past sessions
 * (not just this one), lessons, rationale, and notes. `search.ts` ranks these,
 * `cards.ts` folds them into per-file knowledge cards, and the `brain` tool
 * exposes both.
 *
 * Everything here is derived on read from the existing append-only stores.
 * There is no separate write path and nothing to keep in sync — a brain query
 * always reflects exactly what the underlying files hold right now.
 */

export type BrainItemKind = 'episode' | 'lesson' | 'rationale' | 'note'

export interface BrainItem {
  kind: BrainItemKind
  /** Stable identity — used for relevance tracking and dedupe. */
  key: string
  /** The text a query is ranked against. */
  text: string
  /** A compact one-or-two-line rendering for tool output. */
  render: string
  /** Epoch millis; 0 when the source has no timestamp. */
  at: number
  /** Repo-relative paths this item concerns, when known. */
  paths: string[]
  /** Symbols this item concerns, when known. */
  symbols: string[]
  /** For episodes: which session produced it, and whether that is the current one. */
  sessionId?: string
  fromCurrentSession?: boolean
}

export interface LoadBrainOptions {
  sessionsDir?: string
  lessonsPath?: string
  rationalePath?: string
  notesPath?: string
  /** The live session — its episodes are marked so output can distinguish "now" from "an earlier session". */
  currentSessionId?: string
}

/** A short, stable hash for content-addressed keys (lessons, rationale have no id of their own). */
export function keyHash(text: string): string {
  return Bun.hash(text).toString(36)
}

function episodeItem(record: LedgerRecord, sessionId: string, currentSessionId?: string): BrainItem {
  const render = [
    `episode (turn ${record.turn}${sessionId === currentSessionId ? ', this session' : ', earlier session'}): ${record.summary}`,
    record.decisions.length > 0 ? `  decisions: ${record.decisions.join('; ')}` : '',
    record.filesTouched.length > 0 ? `  files: ${record.filesTouched.join(', ')}` : '',
    record.openThreads.length > 0 ? `  open: ${record.openThreads.join('; ')}` : '',
  ].filter(Boolean).join('\n')

  return {
    kind: 'episode',
    key: `episode:${record.id}`,
    text: [record.summary, ...record.decisions, ...record.filesTouched, ...record.symbols, ...record.openThreads].join(' '),
    render,
    at: record.at,
    paths: record.filesTouched,
    symbols: record.symbols,
    sessionId,
    fromCurrentSession: sessionId === currentSessionId,
  }
}

/** Loads and merges every knowledge source into one typed list. Never throws. */
export async function loadBrainItems(options: LoadBrainOptions = {}): Promise<BrainItem[]> {
  const sessionsDir = options.sessionsDir ?? paths.sessions
  const items: BrainItem[] = []

  for (const sessionId of listLedgerSessionIds(sessionsDir)) {
    try {
      for (const record of await loadLedger(sessionId, sessionsDir)) {
        items.push(episodeItem(record, sessionId, options.currentSessionId))
      }
    } catch {
      // A torn ledger for one session must not sink the whole brain.
    }
  }

  for (const lesson of loadLessons(options.lessonsPath)) {
    items.push({
      kind: 'lesson',
      key: `lesson:${keyHash(lesson.text.toLowerCase())}`,
      text: lesson.text,
      render: `lesson: ${lesson.text}`,
      at: lesson.at,
      paths: pathsIn(lesson.text),
      symbols: [],
    })
  }

  for (const record of loadRationale(options.rationalePath ?? RATIONALE_PATH)) {
    const alt = record.alternatives ? ` (rejected: ${record.alternatives})` : ''
    items.push({
      kind: 'rationale',
      key: `rationale:${record.path}:${keyHash(record.decision.toLowerCase())}`,
      text: `${record.path} ${record.anchor ?? ''} ${record.decision} ${record.reason} ${record.alternatives ?? ''}`,
      render: `why ${record.path}${record.anchor ? ` · ${record.anchor}` : ''}: ${record.decision} — ${record.reason}${alt}`,
      at: record.at,
      paths: [record.path],
      symbols: record.anchor ? [record.anchor] : [],
    })
  }

  for (const note of loadNotes(options.notesPath)) {
    items.push({
      kind: 'note',
      key: `note:${note.id}`,
      text: [note.text, ...note.paths, ...note.tags].join(' '),
      render: `note: ${note.text}${note.paths.length > 0 ? ` [${note.paths.join(', ')}]` : ''}`,
      at: note.at,
      paths: note.paths,
      symbols: [],
    })
  }

  return items
}

/** Bare file paths mentioned in free text, e.g. "the retry logic in src/agentLoop.ts". */
export function pathsIn(text: string): string[] {
  return [...text.matchAll(/[\w./-]+\.[a-z]{1,5}\b/gi)].map((match) => match[0]).slice(0, 8)
}
