import { existsSync, readFileSync } from 'node:fs'
import { appendSecureFile, hardenSecureFile } from '../securePersistence.ts'
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
      const current = counts.get(parsed.key) ?? { recalled: 0, confirmed: 0 }
      if (parsed.kind === 'recalled') current.recalled += 1
      else if (parsed.kind === 'confirmed') current.confirmed += 1
      counts.set(parsed.key, current)
    }
  } catch {
    return counts
  }
  return counts
}

function append(kind: RelevanceLine['kind'], keys: string[], path: string): void {
  const at = Date.now()
  try {
    const body = keys.filter(Boolean).map((key) => `${JSON.stringify({ key, kind, at })}\n`).join('')
    if (body) appendSecureFile(path, body)
  } catch {
    // Losing a relevance signal costs ranking quality, never correctness.
  }
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
