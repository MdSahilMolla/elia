import type { Metrics } from '../evolve/ledger.ts'
import { bernsteinBar, minimumDetectableEffect } from './theory.ts'
import { eValue, spentLevel, summarize } from './stats.ts'

/**
 * The sealed evaluator of §8 and Algorithm 2: one bit, earned statistically.
 *
 * `compareScorecards` in evolve/fitness.ts decides by rules — no task may drop
 * by `REAL_CHANGE`, some task must rise by it. Rules like that have no stated
 * error rate, and a loop that keeps proposing will eventually promote noise
 * through any fixed rule (§8.1: the comparison budget). The paper's answer is a
 * paired test whose false-acceptance rate is bounded over the loop's whole
 * lifetime, and that stays valid when the loop peeks at it after every task
 * (§8.2: anytime-valid, as in PACE).
 *
 * This is that test:
 *
 * - The evidence is the per-task paired difference, candidate minus baseline,
 *   each in [−1, 1] — the pass rate over repeats where there were repeats.
 * - The statistic is an e-value (stats.ts): a betting wealth that stays small
 *   in expectation when nothing improved, however the tasks were ordered or when
 *   the counting stopped.
 * - The level is spent across the lifetime: the k-th comparison runs at
 *   δ·6/(π²k²), so however many generations the loop runs, the chance it ever
 *   promotes a change that did nothing stays below δ.
 *
 * It also reports what the paper's Bernstein bar would demand and the smallest
 * effect this many tasks can certify — the number that says, before anything
 * is spent, whether the benchmark is big enough to see the gains being hunted.
 */

export interface SealedVerdict {
  bit: 'accept' | 'reject'
  /** Tasks with a measurement on both sides. */
  n: number
  meanDiff: number
  sd: number
  eValue: number
  /** Lifetime comparison index this verdict spent level for. */
  index: number
  level: number
  /** The e-value that would have been needed: 1/level. */
  needed: number
  /** Proposition 5's Bernstein bar on the mean difference at this n and index. */
  bar: number
  /** The smallest mean gain this many tasks could certify at this index. */
  minimumDetectable: number
  reason: string
}

function rates(metrics: Metrics): Map<string, number> {
  if (metrics.taskRates) return new Map(Object.entries(metrics.taskRates))
  return new Map([...metrics.failed.map((id) => [id, 0] as const), ...metrics.passed.map((id) => [id, 1] as const)])
}

/** Candidate minus baseline for every task measured on both sides, in task-id order. */
export function pairedDifferences(baseline: Metrics, candidate: Metrics): number[] {
  const before = rates(baseline)
  const after = rates(candidate)
  const ids = [...before.keys()].filter((id) => after.has(id)).sort()
  return ids.map((id) => Math.min(1, Math.max(-1, after.get(id)! - before.get(id)!)))
}

export interface SealedOptions {
  /** 1-based count of comparisons this loop has made, this one included. */
  index: number
  /** Lifetime false-acceptance budget. */
  delta?: number
}

export function sealedCompare(baseline: Metrics, candidate: Metrics, options: SealedOptions): SealedVerdict {
  const delta = options.delta ?? 0.05
  const diffs = pairedDifferences(baseline, candidate)
  const summary = summarize(diffs)
  const level = spentLevel(options.index, delta)
  const needed = 1 / level
  const e = eValue(diffs)
  // The bar is expressed with the same per-comparison level, so the two tests
  // are comparable: K/δ in Proposition 5 is exactly 1/level here.
  const bar = bernsteinBar(summary.n, 1, summary.variance, level)
  const sdForMde = summary.sd > 0 ? summary.sd : 0.3
  const minimumDetectable = minimumDetectableEffect(summary.n, 1, sdForMde, level)
  const verdict: Omit<SealedVerdict, 'bit' | 'reason'> = {
    n: summary.n,
    meanDiff: summary.mean,
    sd: summary.sd,
    eValue: e,
    index: options.index,
    level,
    needed,
    bar,
    minimumDetectable,
  }
  if (summary.n === 0) return { ...verdict, bit: 'reject', reason: 'no task was measured on both sides' }
  if (e >= needed) {
    return { ...verdict, bit: 'accept', reason: `e-value ${fmt(e)} ≥ ${fmt(needed)} (comparison ${options.index}, lifetime δ ${delta}) — mean gain ${pct(summary.mean)} over ${summary.n} task(s)` }
  }
  return {
    ...verdict,
    bit: 'reject',
    reason: `e-value ${fmt(e)} < ${fmt(needed)} — mean change ${pct(summary.mean)} over ${summary.n} task(s); this benchmark can certify gains of about ${pct(minimumDetectable)} or more`,
  }
}

export type GateMode = 'legacy' | 'sealed' | 'both'

/**
 * Which gate decides a promotion. `legacy` (the default) keeps
 * `compareScorecards` in charge and records the sealed verdict beside it, so
 * the two can be compared on real generations before either is trusted alone.
 * `sealed` hands the decision to the paper's test; `both` demands both.
 */
export function gateMode(env: Record<string, string | undefined> = process.env): GateMode {
  const raw = (env.ELIA_EVOLVE_GATE ?? '').trim().toLowerCase()
  return raw === 'sealed' || raw === 'both' ? raw : 'legacy'
}

/** Whether a promotion goes ahead, given the legacy rule's answer and the sealed bit. */
export function gateDecision(mode: GateMode, legacyBetter: boolean, sealed: SealedVerdict): boolean {
  if (mode === 'sealed') return sealed.bit === 'accept'
  if (mode === 'both') return legacyBetter && sealed.bit === 'accept'
  return legacyBetter
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return '∞'
  if (value >= 100) return value.toFixed(0)
  return value.toFixed(2)
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pts`
}
