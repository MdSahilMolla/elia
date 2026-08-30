import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { appendSecureFile, hardenSecureFile } from '../securePersistence.ts'
import { paths } from '../config.ts'
import type { Tool } from '../tools/types.ts'

/**
 * A model of *why* this codebase is the way it is — the decisions, the rejected
 * alternatives, the constraints — not just what the code does.
 *
 * Every agent indexes structure. None persist intent, so every session
 * re-derives (or re-guesses) why the retry logic has that exact backoff, why
 * that module must not be edited by hand, why the abstraction is shaped the way
 * it is. This is append-only, project-scoped, and consulted at the start of a
 * turn: the longer elia works a repo, the more it *understands* it.
 *
 * Sibling to lessons.ts — lessons are "what a future run should know before
 * starting"; rationale is "why this specific code is like this", anchored to a
 * path.
 */

export const RATIONALE_PATH = paths.rationale
const MAX_RENDERED = 8

export interface RationaleRecord {
  at: number
  /** Repo-relative path the decision concerns. */
  path: string
  /** Optional symbol / region for a finer anchor. */
  anchor?: string
  /** The choice that was made, one line. */
  decision: string
  /** Why — the constraint or goal that forced it. */
  reason: string
  /** What was considered and rejected, and why. */
  alternatives?: string
  source: 'agent' | 'user'
}

export function recordRationale(record: Omit<RationaleRecord, 'at'>, path = RATIONALE_PATH): void {
  const clean = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() ?? ''
  const entry: RationaleRecord = {
    at: Date.now(),
    path: clean(record.path),
    anchor: clean(record.anchor) || undefined,
    decision: clean(record.decision),
    reason: clean(record.reason),
    alternatives: clean(record.alternatives) || undefined,
    source: record.source,
  }
  if (!entry.path || !entry.decision || !entry.reason) return
  try {
    if (loadRationale(path).some((r) => r.path === entry.path && r.decision.toLowerCase() === entry.decision.toLowerCase())) return
    appendSecureFile(path, `${JSON.stringify(entry)}\n`)
  } catch {
    // A lost rationale note costs future understanding, not this run's correctness.
  }
}

export function loadRationale(path = RATIONALE_PATH): RationaleRecord[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as RationaleRecord
        } catch {
          return undefined
        }
      })
      .filter((r): r is RationaleRecord => Boolean(r?.path && r.decision && r.reason))
  } catch {
    return []
  }
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'is', 'it', 'and', 'or', 'for', 'on', 'this', 'that', 'with', 'why', 'how', 'what'])

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

/** Ranks stored rationale against a free-text query plus a set of paths in play, by term overlap + a path-match boost + recency. */
export function queryRationale(query: string, activePaths: string[] = [], limit = MAX_RENDERED, path = RATIONALE_PATH): RationaleRecord[] {
  const records = loadRationale(path)
  if (records.length === 0) return []
  const queryTerms = new Set([...terms(query), ...activePaths.flatMap((p) => terms(p))])
  const activeBases = new Set(activePaths.map((p) => basename(p).toLowerCase()))
  const now = Date.now()

  return records
    .map((record) => {
      const haystack = terms(`${record.path} ${record.anchor ?? ''} ${record.decision} ${record.reason} ${record.alternatives ?? ''}`)
      let score = haystack.reduce((sum, term) => sum + (queryTerms.has(term) ? 1 : 0), 0)
      if (activePaths.some((p) => p === record.path || basename(p).toLowerCase() === basename(record.path).toLowerCase())) score += 5
      if (activeBases.has(basename(record.path).toLowerCase())) score += 2
      const ageDays = (now - record.at) / 86_400_000
      score *= 1 / (1 + ageDays / 60)
      return { record, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.record)
}

/** A system-prompt section: the rationale most relevant to what the turn is about. */
export function renderRationale(query: string, activePaths: string[] = [], path = RATIONALE_PATH): string {
  const hits = queryRationale(query, activePaths, MAX_RENDERED, path)
  if (hits.length === 0) return ''
  const lines = hits.map((r) => {
    const alt = r.alternatives ? ` (rejected: ${r.alternatives})` : ''
    return `- ${r.path}${r.anchor ? ` · ${r.anchor}` : ''}: ${r.decision} — ${r.reason}${alt}`
  })
  return `\n\n## Why this code is the way it is (recorded rationale — trust it before re-deriving)\n${lines.join('\n')}`
}

/** `/why <path-or-topic>` — everything recorded about a file or subject. */
export function explainRationale(subject: string, path = RATIONALE_PATH): string {
  const hits = queryRationale(subject, [subject], 20, path)
  if (hits.length === 0) return `Nothing recorded about "${subject}" yet.`
  return hits
    .map((r) => `${r.path}${r.anchor ? ` · ${r.anchor}` : ''}\n  decision: ${r.decision}\n  reason:   ${r.reason}${r.alternatives ? `\n  rejected: ${r.alternatives}` : ''}`)
    .join('\n\n')
}

export function createRationaleTool(): Tool {
  return {
    name: 'record_rationale',
    description:
      `Record *why* you made a non-obvious design choice, anchored to a file, so a future session trusts it instead of re-deriving or second-guessing it.

Use it when you deliberately chose one approach over a reasonable alternative, worked around a constraint that is not visible in the code, or shaped an abstraction for a reason a reader would not guess. Do NOT use it to describe what the code does, to log routine edits, or for anything obvious from reading the file.

Good: path "src/agentLoop.ts", decision "serialize file writes behind a process-wide lock", reason "parallel fleet edits to the same file interleave and corrupt it", alternatives "per-file locks — rejected, the contention is rare and a global lock is simpler to reason about".`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file the decision concerns' },
        anchor: { type: 'string', description: 'Optional: the function/region/symbol' },
        decision: { type: 'string', description: 'The choice you made, one line' },
        reason: { type: 'string', description: 'The constraint or goal that forced it' },
        alternatives: { type: 'string', description: 'What you considered and rejected, and why' },
      },
      required: ['path', 'decision', 'reason'],
    },
    async execute(input) {
      recordRationale({
        path: String(input.path ?? ''),
        anchor: input.anchor === undefined ? undefined : String(input.anchor),
        decision: String(input.decision ?? ''),
        reason: String(input.reason ?? ''),
        alternatives: input.alternatives === undefined ? undefined : String(input.alternatives),
        source: 'agent',
      })
      return `Recorded rationale for ${input.path}.`
    },
  }
}

export function createWhyTool(): Tool {
  return {
    name: 'why',
    description:
      'Look up recorded rationale for a file or topic before changing it — the decisions, constraints, and rejected alternatives a past session captured. Returns "nothing recorded" if there is none.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'A repo-relative path, or a topic/symbol name' },
      },
      required: ['subject'],
    },
    async execute(input) {
      return explainRationale(String(input.subject ?? ''))
    },
  }
}
