import { statSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config.ts'
import { listLedgerSessionIds, loadLedger, type LedgerRecord } from '../ledger.ts'
import { loadLessons } from '../autonomy/lessons.ts'
import { loadRationale, RATIONALE_PATH } from '../autonomy/rationale.ts'
import { loadRecordingIndex, minePatterns, recordingsFingerprint, type FrictionPattern, type RecordedMoment } from '../autonomy/recordingIndex.ts'
import type { EliaBook } from '../eliaBook.ts'
import { loadNotes } from './notes.ts'
import { registerCache } from '../cacheRegistry.ts'

/**
 * The read layer of elia's second brain: one merged, typed view over every
 * durable knowledge source in a project — episodes from *all* past sessions
 * (not just this one), lessons, rationale, and notes, and now what the live
 * recorder kept: the Elia Books (playbooks) made from past sessions, the moments
 * worth returning to inside their recordings, and the failures that keep
 * recurring across them. `search.ts` ranks these, `cards.ts` folds the original
 * four into per-file knowledge cards, and the `brain` tool exposes both — and
 * opens any hit back to the raw recording behind it.
 *
 * Everything here is derived on read from the existing append-only stores.
 * There is no separate write path and nothing to keep in sync — a brain query
 * always reflects exactly what the underlying files hold right now.
 */

export type BrainItemKind = 'episode' | 'lesson' | 'rationale' | 'note' | 'book' | 'moment' | 'pattern'

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
  /** A multiplier on the search score; a verified playbook or a fix that worked outranks a bare mention. Absent means 1. */
  weight?: number
  /** What `brain open` turns back into the raw record: `recording:<session>#<from>-<to>` or `book:<id>`. */
  pointer?: string
}

export interface LoadBrainOptions {
  sessionsDir?: string
  lessonsPath?: string
  rationalePath?: string
  notesPath?: string
  /** The project whose Books and recordings are read; the working directory when omitted. */
  cwd?: string
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
// agent.ts calls this on every dev turn that mentions a file, so a repeated
// load over an unchanged store should be near-free. The cache is only used for
// the default paths (tests pass explicit ones and bypass it) and is busted by a
// cheap fingerprint of every source's mtime — a new episode, an appended
// lesson, or a saved note all move it.
let cache: { fingerprint: string; items: BrainItem[] } | undefined

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function defaultFingerprint(sessionsDir: string, currentSessionId: string | undefined): string {
  const ledgerMtimes = listLedgerSessionIds(sessionsDir).map((id) => mtime(join(sessionsDir, `${id}.ledger.jsonl`)))
  return [
    currentSessionId ?? '',
    ledgerMtimes.length,
    ...ledgerMtimes,
    mtime(paths.lessons),
    mtime(RATIONALE_PATH),
    mtime(paths.brainNotes),
    // A Book rewrites its file atomically, which moves the directory's mtime; a recording is appended to, which does not, so each one is listed.
    mtime(join(paths.state, 'books')),
    recordingsFingerprint(process.cwd(), currentSessionId),
  ].join(':')
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function bookItem(book: EliaBook): BrainItem {
  const current = book.versions.find((version) => version.version === book.activeVersion) ?? book.versions.at(-1)!
  const { procedure, evidence } = current
  const files = [...new Set(procedure.steps.flatMap((step) => step.files))]
  return {
    kind: 'book',
    key: `book:${book.id}`,
    text: clip(
      [book.title, procedure.goal, procedure.understanding, ...procedure.steps.map((step) => `${step.title} ${clip(step.instructions, 300)}`), ...procedure.verification, ...evidence.failures, ...evidence.lessons, ...files].join(' '),
      4_000,
    ),
    render: `playbook ${book.id} (${book.status}, v${book.activeVersion}, ${evidence.actionCount} actions, ${evidence.failedActions} failed): ${clip(book.title, 160)}  [open: book:${book.id}]`,
    at: Date.parse(book.updatedAt) || 0,
    paths: files,
    symbols: [],
    weight: book.status === 'verified' ? 1.5 : book.status === 'recorded' ? 1.1 : 1,
    pointer: `book:${book.id}`,
  }
}

function momentItem(moment: RecordedMoment): BrainItem {
  return {
    kind: 'moment',
    key: `moment:${moment.kind}:${moment.sessionId}:${moment.from}`,
    text: moment.text,
    render: `${moment.render}  [open: ${moment.pointer}]`,
    at: moment.at,
    paths: moment.paths,
    symbols: [],
    sessionId: moment.sessionId,
    weight: moment.weight,
    pointer: moment.pointer,
  }
}

function patternItem(pattern: FrictionPattern): BrainItem {
  const open = pattern.fix?.pointer ?? pattern.example.pointer
  return {
    kind: 'pattern',
    key: `pattern:${keyHash(pattern.signature)}`,
    text: `${pattern.example.failed} ${pattern.example.error} ${pattern.fix?.label ?? ''} recurring failure`,
    render: `pattern ×${pattern.occurrences} across ${pattern.sessions.length} session(s): ${pattern.example.failed} fails with "${clip(pattern.example.error, 120)}"${pattern.fix ? ` → fixed by ${pattern.fix.label} (${pattern.fix.count} of ${pattern.occurrences})` : ' → no fix found yet'}  [open: ${open}]`,
    at: pattern.at,
    paths: [],
    symbols: [],
    // A failure seen again and again, with a fix that keeps working, is the strongest thing a recording can say.
    weight: 1 + 0.5 * Math.log2(pattern.occurrences) + (pattern.fix ? 0.25 : 0),
    pointer: open,
  }
}

export async function loadBrainItems(options: LoadBrainOptions = {}): Promise<BrainItem[]> {
  const sessionsDir = options.sessionsDir ?? paths.sessions
  const usesDefaults = !options.sessionsDir && !options.lessonsPath && !options.rationalePath && !options.notesPath && !options.cwd
  const cwd = options.cwd ?? process.cwd()

  let fingerprint: string | undefined
  if (usesDefaults) {
    fingerprint = defaultFingerprint(sessionsDir, options.currentSessionId)
    if (cache && cache.fingerprint === fingerprint) return cache.items
  }

  const items: BrainItem[] = []

  // Load sessions in parallel for better performance
  const sessionIds = listLedgerSessionIds(sessionsDir)
  const sessionPromises = sessionIds.map(async (sessionId) => {
    try {
      const records = await loadLedger(sessionId, sessionsDir)
      return records.map((record) => episodeItem(record, sessionId, options.currentSessionId))
    } catch {
      // A torn ledger for one session must not sink the whole brain.
      return []
    }
  })
  
  const sessionResults = await Promise.all(sessionPromises)
  for (const sessionItems of sessionResults) {
    items.push(...sessionItems)
  }

  // What the live recorder kept. Read before the lessons, because a lesson that
  // a recorded turn taught carries a pointer back to the events that taught it.
  // The session in progress is left out: it is in the model's own window already.
  const recordings = loadRecordingIndex(cwd, { currentSessionId: options.currentSessionId })
  const taught = new Map<string, string>()
  for (const recording of recordings) {
    for (const lesson of recording.lessons) {
      const key = keyHash(lesson.text.toLowerCase())
      if (!taught.has(key)) taught.set(key, lesson.pointer)
    }
  }

  for (const lesson of loadLessons(options.lessonsPath)) {
    const key = keyHash(lesson.text.toLowerCase())
    const pointer = taught.get(key)
    items.push({
      kind: 'lesson',
      key: `lesson:${key}`,
      text: lesson.text,
      render: `lesson: ${lesson.text}${pointer ? `  [recorded · open: ${pointer}]` : ''}`,
      at: lesson.at,
      paths: pathsIn(lesson.text),
      symbols: [],
      ...(pointer ? { pointer } : {}),
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

  // Loaded on first use: the Book code is not needed by a turn that never searches the brain.
  try {
    const { listEliaBooks } = await import('../eliaBook.ts')
    for (const book of listEliaBooks(cwd)) items.push(bookItem(book))
  } catch {
    // An unreadable Book must not sink the brain.
  }
  for (const recording of recordings) for (const moment of recording.moments) items.push(momentItem(moment))
  for (const pattern of minePatterns(recordings)) items.push(patternItem(pattern))

  if (fingerprint !== undefined) cache = { fingerprint, items }
  return items
}

/** Drops the in-process brain cache. Used by tests and by a checkpoint restore. */
export function resetBrainCache(): void {
  cache = undefined
}

registerCache('brain', resetBrainCache, () => (cache ? cache.items.length : 0))

/** Bare file paths mentioned in free text, e.g. "the retry logic in src/agentLoop.ts". */
export function pathsIn(text: string): string[] {
  return [...text.matchAll(/[\w./-]+\.[a-z]{1,5}\b/gi)].map((match) => match[0]).slice(0, 8)
}
