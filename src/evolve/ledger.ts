import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import { appendSecureFile, ensureSecureDirectory, hardenSecureFile } from '../securePersistence.ts'

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
    ensureSecureDirectory(EVOLUTION_DIR)
    appendSecureFile(path, `${JSON.stringify(record)}\n`)
  } catch {
    // Losing a ledger line costs future generations context, not this one's result.
  }
}

export function readLedger(path = LEDGER_PATH): GenerationRecord[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
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

  const learning = learningRate(records)
  if (learning.generations >= 2) {
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`
    const lines = [
      `### Learning trajectory`,
      `Over the last ${learning.window} generation(s): ${pct(learning.deltaPassRatePerGen)} realized pass rate per generation, ${learning.promotionsPerWindow} promoted, ${pct(learning.fitnessPerKTokens)} gain per 1k candidate-eval tokens.`,
      learning.trend === 'stalled'
        ? `Trend: STALLED — recent generations banked no gain. The benchmark is likely saturated for the levers tried so far; propose a structurally different change (a new tool, a different role split, a planning-loop rewrite), not another prompt tweak.`
        : `Trend: ${learning.trend}.`,
    ]
    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}

function formatRate(rate: number | undefined): string {
  return rate === undefined ? '?' : `${Math.round(rate * 100)}%`
}

/**
 * Is the self-improvement loop actually compounding, or just spinning?
 *
 * A fixed benchmark saturates: once candidates all score near the ceiling,
 * `compareScorecards` rejects every tie and the loop hill-climbs a flat plane
 * forever, burning a full benchmark run per generation for no gain. That failure
 * is invisible in the per-generation verdict ("rejected: no measurable
 * improvement") — it only shows up as a *trend* across generations. This is that
 * trend, derived from the ledger with no new stored fields: realized pass-rate
 * gain per generation, per 1k candidate-eval tokens, and per wall-clock hour,
 * plus a coarse accelerating/steady/decelerating/stalled call so the
 * hypothesiser knows when to stop tweaking and try a structurally different
 * lever.
 */
export interface LearningSignal {
  generations: number
  promotions: number
  /** Promotions within the last `window` generations. */
  promotionsPerWindow: number
  window: number
  /** Mean realized Δ passRate per generation over the window (0 for a rejected generation). */
  deltaPassRatePerGen: number
  /** Realized Δ passRate in the window per 1,000 tokens spent measuring candidates. */
  fitnessPerKTokens: number
  /** Realized Δ passRate in the window per hour of candidate-measurement wall-clock. */
  fitnessPerWallClockHour: number
  trend: 'accelerating' | 'steady' | 'decelerating' | 'stalled' | 'unknown'
}

const LEARNING_WINDOW = 5

/** Realized pass-rate gain a generation actually banked: the promotion delta, or 0. */
function realizedGain(record: GenerationRecord): number {
  if (record.verdict !== 'promoted') return 0
  const before = record.baseline?.passRate
  const after = record.candidate?.passRate
  if (before === undefined || after === undefined) return 0
  return Math.max(0, after - before)
}

export function learningRate(records: GenerationRecord[], window = LEARNING_WINDOW): LearningSignal {
  const ordered = [...records].sort((a, b) => a.generation - b.generation)
  const promotions = ordered.filter((r) => r.verdict === 'promoted').length
  const recent = ordered.slice(-window)
  const prior = ordered.slice(-window * 2, -window)

  const gainOf = (rows: GenerationRecord[]) => rows.reduce((sum, r) => sum + realizedGain(r), 0)
  const recentGain = gainOf(recent)
  const priorGain = gainOf(prior)

  const tokens = recent.reduce((sum, r) => sum + (r.candidate?.totalTokens ?? 0), 0)
  const wallMs = recent.reduce((sum, r) => sum + (r.candidate?.wallClockMs ?? r.candidate?.totalElapsedMs ?? 0), 0)

  const recentMean = recent.length > 0 ? recentGain / recent.length : 0
  const priorMean = prior.length > 0 ? priorGain / prior.length : 0
  const promotionsPerWindow = recent.filter((r) => r.verdict === 'promoted').length

  let trend: LearningSignal['trend']
  if (ordered.length < 2) {
    trend = 'unknown'
  } else if (recentMean < 1e-4 && promotionsPerWindow === 0) {
    trend = 'stalled'
  } else if (prior.length === 0) {
    trend = promotionsPerWindow > 0 ? 'accelerating' : 'steady'
  } else if (recentMean > priorMean * 1.1 + 1e-4) {
    trend = 'accelerating'
  } else if (recentMean < priorMean * 0.9 - 1e-4) {
    trend = 'decelerating'
  } else {
    trend = 'steady'
  }

  return {
    generations: ordered.length,
    promotions,
    promotionsPerWindow,
    window: recent.length,
    deltaPassRatePerGen: recentMean,
    fitnessPerKTokens: tokens > 0 ? recentGain / (tokens / 1000) : 0,
    fitnessPerWallClockHour: wallMs > 0 ? recentGain / (wallMs / 3_600_000) : 0,
    trend,
  }
}

/** One-line learning-trajectory readout for `elia evolve` / `elia bench`. */
export function renderLearningLine(path = LEDGER_PATH): string {
  const records = readLedger(path)
  if (records.length === 0) return 'Learning trajectory: no generations recorded yet.'
  const s = learningRate(records)
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  return `Learning trajectory: ${s.trend} — last ${s.window} generation(s) ${pct(s.deltaPassRatePerGen)} pass rate/gen, ${s.promotionsPerWindow} promoted (${s.promotions}/${s.generations} all-time)`
}
