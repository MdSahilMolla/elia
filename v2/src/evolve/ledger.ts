import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../config.ts'

/**
 * The record of every attempt elia has made to improve itself.
 *
 * This is what makes the self-improvement loop *recursive* rather than merely
 * repeated. Each generation reads the whole ledger before hypothesising, so it
 * inherits both the wins (already in the source) and the losses (which it must
 * not retry). Without it, generation 12 proposes the same rejected prompt tweak
 * generation 3 did, forever — a random walk instead of a search.
 *
 * It lives next to elia's own source, not in the user's project, because it is a
 * fact about elia rather than about whatever repo the user happens to be in.
 */

export const EVOLUTION_DIR = join(ELIA_ROOT, '.evolution')
export const LEDGER_PATH = join(EVOLUTION_DIR, 'ledger.jsonl')

export interface Metrics {
  /** Weighted fraction of bench tasks passed, 0..1. */
  passRate: number
  /** Which task ids passed — needed to detect a regression that a tied pass rate would hide. */
  passed: string[]
  failed: string[]
  /** Model round-trips per task, so efficiency hypotheses can cite actual activation evidence. */
  steps?: Record<string, number>
  totalTokens: number
  totalElapsedMs: number
  /** User-visible suite duration when benchmark tasks run in parallel. */
  wallClockMs?: number
  /** Speculative read effectiveness, when reported by the benchmark harness. */
  cacheHitRate?: number
  cacheHits?: number
  cacheMisses?: number
  costUsd?: number
}

export type Verdict = 'promoted' | 'rejected' | 'error'

export interface GenerationRecord {
  generation: number
  at: number
  /** The one change this generation tried, in its own words. */
  hypothesis: string
  rationale: string
  targetFiles: string[]
  /** Files that actually differed from the live source after the builder ran. */
  changedFiles: string[]
  baseline?: Metrics
  candidate?: Metrics
  verdict: Verdict
  reason: string
  /** Model used for the attempt, so records stay comparable across model upgrades. */
  model: string
}

export function appendGeneration(record: GenerationRecord, path = LEDGER_PATH): void {
  try {
    mkdirSync(EVOLUTION_DIR, { recursive: true })
    appendFileSync(path, `${JSON.stringify(record)}\n`)
  } catch {
    // Losing a ledger line costs future generations context, not this one's result.
  }
}

export function readLedger(path = LEDGER_PATH): GenerationRecord[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as GenerationRecord]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function nextGenerationNumber(path = LEDGER_PATH): number {
  const records = readLedger(path)
  return records.reduce((highest, record) => Math.max(highest, record.generation), 0) + 1
}

/**
 * The ledger as the hypothesiser needs to see it: what has been promoted (so it
 * builds on it) and what has been rejected and why (so it stops re-proposing it).
 */
export function renderLedgerForPrompt(path = LEDGER_PATH): string {
  const records = readLedger(path)
  if (records.length === 0) return 'No previous generations — this is the first attempt.'

  const promoted = records.filter((record) => record.verdict === 'promoted')
  const rejected = records.filter((record) => record.verdict !== 'promoted')

  const sections: string[] = []

  sections.push(
    promoted.length > 0
      ? `### Already promoted (these changes are IN the current source — build on them, do not redo them)\n${promoted
          .map(
            (record) =>
              `- gen ${record.generation}: ${record.hypothesis} → pass rate ${formatRate(record.baseline?.passRate)} to ${formatRate(record.candidate?.passRate)} (${record.changedFiles.join(', ') || 'no files recorded'})`,
          )
          .join('\n')}`
      : '### Already promoted\n(nothing yet)',
  )

  sections.push(
    rejected.length > 0
      ? `### Tried and rejected (do NOT propose these again unless you have a concretely different approach)\n${rejected
          .map((record) => `- gen ${record.generation}: ${record.hypothesis} → ${record.verdict}: ${record.reason}`)
          .join('\n')}`
      : '### Tried and rejected\n(nothing yet)',
  )

  return sections.join('\n\n')
}

function formatRate(rate: number | undefined): string {
  return rate === undefined ? '?' : `${Math.round(rate * 100)}%`
}
