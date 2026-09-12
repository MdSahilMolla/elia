import { existsSync, readFileSync, statSync } from 'node:fs'
import { appendSecureFile, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'
import { paths } from '../config.ts'

/**
 * Project-global relevance signal for the second brain.
 *
 * The episodic ledger already self-tunes *within* a session (recall.ts's
 * recallCount/confirmedUseCount). The brain needs the same idea but shared
 * across every session: a lesson or note that keeps proving useful should
 * outrank an equally-worded one that never pans out, no matter which session
 * did the proving. Append-only event lines, folded on load — the same
 * race-free pattern ledger.ts uses.
 */

interface RelevanceLine {
  key: string
  /** 'recalled' = matched a brain query; 'confirmed' = a tool call right after touched its file. */
  kind: 'recalled' | 'confirmed'
  at: number
  /** Folded hit count for this (key, kind) pair — omitted (= 1) for a raw per-hit line; set by `compactRelevance`. */
  count?: number
}

export interface RelevanceCount {
  recalled: number
  confirmed: number
}

export function loadRelevance(path = paths.brainRelevance): Map<string, RelevanceCount> {
  const counts = new Map<string, RelevanceCount>()
  if (!existsSync(path)) return counts
  hardenSecureFile(path)
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let parsed: RelevanceLine
      try {
        parsed = JSON.parse(line) as RelevanceLine
      } catch {
        continue
      }
      if (typeof parsed.key !== 'string') continue
      const hits = typeof parsed.count === 'number' && Number.isFinite(parsed.count) && parsed.count > 0 ? parsed.count : 1
      const current = counts.get(parsed.key) ?? { recalled: 0, confirmed: 0 }
      if (parsed.kind === 'recalled') current.recalled += hits
      else if (parsed.kind === 'confirmed') current.confirmed += hits
      counts.set(parsed.key, current)
    }
  } catch {
    return counts
  }
  return counts
}

// Above this file size, `append` folds the file down to one row per (key,
// kind) before writing the new line — see `compactRelevance` below. A cheap
// `statSync` check (metadata only, no read) so the common case of appending
// under the threshold costs nothing extra.
const COMPACT_AT_BYTES = 512 * 1024

function append(kind: RelevanceLine['kind'], keys: string[], path: string): void {
  const at = Date.now()
  try {
    maybeCompact(path)
    const body = keys.filter(Boolean).map((key) => `${JSON.stringify({ key, kind, at })}\n`).join('')
    if (body) appendSecureFile(path, body)
  } catch {
    // Losing a relevance signal costs ranking quality, never correctness.
  }
}

function maybeCompact(path: string): void {
  try {
    if (statSync(path).size > COMPACT_AT_BYTES) compactRelevance(path)
  } catch {
    // Missing file (nothing to compact yet) or a transient stat failure —
    // either way the append below still succeeds on its own.
  }
}

export interface RelevanceCompactResult {
  linesBefore: number
  rowsAfter: number
}

/**
 * Fold every (key, kind) pair's scattered per-hit lines into a single row
 * carrying the summed count and latest timestamp — the same "keep the signal,
 * shrink the file" shape as lessons.ts's `retireLessons` / notes.ts's
 * `rewriteNotes` for the brain's sibling stores. Unlike those, nothing here is
 * ever dropped: the whole point of this file is "did this prove useful across
 * every session ever", so a hit is only ever consolidated, never deleted —
 * folding preserves the exact count while bounding the file to one line per
 * (key, kind) pair instead of one line per hit. Safe to call unconditionally;
 * a missing or unreadable file is a no-op.
 */
export function compactRelevance(path = paths.brainRelevance): RelevanceCompactResult {
  if (!existsSync(path)) return { linesBefore: 0, rowsAfter: 0 }
  hardenSecureFile(path)

  const folded = new Map<string, { recalled: number; recalledAt: number; confirmed: number; confirmedAt: number }>()
  let linesBefore = 0
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      linesBefore += 1
      let parsed: RelevanceLine
      try {
        parsed = JSON.parse(line) as RelevanceLine
      } catch {
        continue
      }
      if (typeof parsed.key !== 'string') continue
      const hits = typeof parsed.count === 'number' && Number.isFinite(parsed.count) && parsed.count > 0 ? parsed.count : 1
      const entry = folded.get(parsed.key) ?? { recalled: 0, recalledAt: 0, confirmed: 0, confirmedAt: 0 }
      if (parsed.kind === 'recalled') {
        entry.recalled += hits
        entry.recalledAt = Math.max(entry.recalledAt, parsed.at || 0)
      } else if (parsed.kind === 'confirmed') {
        entry.confirmed += hits
        entry.confirmedAt = Math.max(entry.confirmedAt, parsed.at || 0)
      }
      folded.set(parsed.key, entry)
    }
  } catch {
    return { linesBefore, rowsAfter: linesBefore }
  }

  const rows: string[] = []
  for (const [key, entry] of folded) {
    if (entry.recalled > 0) rows.push(JSON.stringify({ key, kind: 'recalled', at: entry.recalledAt, count: entry.recalled }))
    if (entry.confirmed > 0) rows.push(JSON.stringify({ key, kind: 'confirmed', at: entry.confirmedAt, count: entry.confirmed }))
  }
  try {
    writeSecureFile(path, rows.length ? `${rows.join('\n')}\n` : '')
  } catch {
    // Compaction is best-effort; leaving the pre-fold file in place is safe.
    return { linesBefore, rowsAfter: linesBefore }
  }
  return { linesBefore, rowsAfter: rows.length }
}

export function bumpBrainRecalled(keys: string[], path = paths.brainRelevance): void {
  append('recalled', keys, path)
}

export function bumpBrainConfirmed(key: string, path = paths.brainRelevance): void {
  append('confirmed', [key], path)
}

/** The multiplier a proven-useful item earns — mirrors recall.ts's ledger boost. */
export function relevanceBoost(counts: Map<string, RelevanceCount>, key: string): number {
  const count = counts.get(key)
  if (!count) return 1
  return 1 + Math.log1p(count.recalled) + 2 * Math.log1p(count.confirmed)
}

// --- Confirmed-use tracking: the stronger half of the signal ---
//
// After a brain search returns a hit anchored to some files, the next few tool
// calls are watched: if one actually touches one of those files, that hit is
// marked "confirmed" — real evidence it mattered, not just a text match. Same
// fire-and-forget, never-throw pattern as ledger.ts. agent.ts drives this from
// its onTool hook.

const CONFIRMATION_WINDOW_STEPS = 6

interface Pending {
  key: string
  remainingSteps: number
}

let pendingByFile = new Map<string, Pending>()

export function markBrainRecalled(hits: { key: string; paths: string[] }[]): void {
  for (const hit of hits) {
    for (const file of hit.paths) {
      pendingByFile.set(file, { key: hit.key, remainingSteps: CONFIRMATION_WINDOW_STEPS })
    }
  }
}

/** Called once per tool call from the agent loop. Best-effort; failures are swallowed. */
export function noteBrainToolUse(input: Record<string, unknown>, path = paths.brainRelevance): void {
  if (pendingByFile.size === 0) return
  const touched = typeof input.path === 'string' ? input.path : undefined
  for (const [file, pending] of pendingByFile) {
    if (touched && file === touched) {
      pendingByFile.delete(file)
      try {
        bumpBrainConfirmed(pending.key, path)
      } catch {
        // ranking-quality only
      }
      continue
    }
    pending.remainingSteps -= 1
    if (pending.remainingSteps <= 0) pendingByFile.delete(file)
  }
}

/** Test-only: clears the confirmation window between runs. */
export function resetBrainPending(): void {
  pendingByFile = new Map()
}
