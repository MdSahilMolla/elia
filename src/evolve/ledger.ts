import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import { withFileLock } from '../fileLock.ts'
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
const GENERATION_COUNTER_PATH = join(EVOLUTION_DIR, 'generation-counter')

export interface Metrics {
  /** Weighted fraction of bench tasks passed, 0..1. */
  passRate: number
  /** Which task ids passed — needed to detect a regression that a tied pass rate would hide. */
  passed: string[]
  failed: string[]
  /** Tasks with no verdict (provider or environment failure); absent on older records. */
  unmeasured?: string[]
  /** Model round-trips per task, so efficiency hypotheses can cite actual activation evidence. */
  steps?: Record<string, number>
  /**
   * Fraction of attempts each measured task passed, when the benchmark ran each
   * task more than once (ELIA_BENCH_REPEATS). Absent on single-run records,
   * where `passed`/`failed` already are the rates.
   */
  taskRates?: Record<string, number>
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
  /**
   * A later correction to how this verdict should be read, added by hand and
   * shown beside it wherever the proposer reads the ledger. The verdict and
   * reason stay exactly as recorded.
   */
  note?: string
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
  /**
   * The route the proposer and builder ran on, when `ELIA_EVOLVE_PROVIDER`/
   * `ELIA_EVOLVE_MODEL` moved them off `model` (improverRoute.ts). Absent when
   * the improver ran on the model under test.
   */
  improverModel?: string
  /**
   * How often each tree cheated on the canaries before a promotion
   * (canaryGate.ts). Present only on generations that reached that check.
   */
  canaries?: import('./canaryGate.ts').CanaryRecord
  /** The furthest gate this generation got through (see strategy.ts FUNNEL); absent on older records. */
  funnel?: import('./strategy.ts').FunnelStage
  /** Set when an unattended run committed its promotion to a branch instead of the live tree. */
  branch?: string
  commit?: string
  /** The search strategy that steered the proposal; absent on records from before strategies were state. */
  strategyId?: string
  /**
   * What this verdict cost to reach, when `sieve.ts` raced for it.
   *
   * The ledger already says what was tried and what came of it; this says what
   * the answer was worth buying. It is the input to the only number that can
   * show a self-improvement loop compounding without weights: verdicts per
   * token. A loop whose gains make the *next* verdict cheaper searches further
   * on the same budget, and that is visible here and nowhere else.
   */
  evidenceCost?: EvidenceCost
  /**
   * Where the gain landed: on the tasks whose failures the proposer was handed,
   * or on the ones held back from it (see split.ts). Absent on records written
   * before the corpus was split, and on runs too small to split.
   *
   * A pass rate says a candidate scored better. This says whether it got
   * better — the difference between the two is the only thing that makes a
   * promotion worth standing on.
   */
  generalization?: import('./split.ts').GeneralizationRecord
  /**
   * The paper's sealed verdict on the same measurement (acceptance.ts):
   * an anytime-valid e-value against "nothing improved", with the level this
   * comparison spent from the loop's lifetime budget. Recorded on every
   * measured generation whichever gate decided, so the two can be compared.
   */
  sealed?: {
    bit: 'accept' | 'reject'
    eValue: number
    needed: number
    meanDiff: number
    n: number
    minimumDetectable: number
    /** Which gate made the promotion decision: `legacy`, `sealed` or `both`. */
    mode: string
  }
  /** Content hash of the changed files the verdict was about (isolation requirement I3). */
  diffDigest?: string
}

export interface EvidenceCost {
  /** Tasks actually measured against the candidate. */
  tasksRun: number
  /** Tasks whose baseline row carried over because the diff could not reach them. */
  tasksCarried: number
  /** Tasks never run because the verdict was already settled. */
  tasksSkipped: number
  /** Tasks in the set the verdict is about — what a full sweep would have run. */
  tasksTotal: number
  /** Tokens the raced measurement spent. */
  tokens: number
  /** Wall clock from the first task to the verdict. */
  msToVerdict: number
  /** The task whose result ended the race, when one did. */
  settledBy?: string
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
  /**
   * Generation numbers are claimed under a file lock so two concurrent
   * evolutions (an `elia evolve` plus a manual `elia run-distill`, or two
   * terminals) cannot both compute the same next number, then fight over the
   * same `gen-N` sandbox directory and write colliding ledger rows. The high
   * water mark is persisted in a sidecar counter file because the ledger row
   * itself is only appended after the whole generation runs (minutes later) —
   * reserving the number at claim time keeps it unique even if the run dies
   * before it appends.
   */
  return withFileLock(path + '.lock', () => {
    ensureSecureDirectory(EVOLUTION_DIR)
    const recordMax = readLedger(path).reduce((highest, record) => Math.max(highest, record.generation), 0)
    const counter = readGenerationCounter()
    const next = Math.max(recordMax, counter) + 1
    writeFileSync(GENERATION_COUNTER_PATH, `${next}\n`, 'utf8')
    return next
  })
}

function readGenerationCounter(): number {
  try {
    if (!existsSync(GENERATION_COUNTER_PATH)) return 0
    return Math.max(0, Number.parseInt(readFileSync(GENERATION_COUNTER_PATH, 'utf8').trim(), 10) || 0)
  } catch {
    return 0
  }
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
          .map((record) => `- gen ${record.generation}: ${record.hypothesis} → ${record.verdict}: ${record.reason}${record.note ? `\n  NOTE: ${record.note}` : ''}`)
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
  // A generation that errored — a dropped network, a truncated stream — never
  // reached a verdict, so it says nothing about whether the search is stalling.
  const ordered = [...records].filter((r) => r.verdict !== 'error').sort((a, b) => a.generation - b.generation)
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
