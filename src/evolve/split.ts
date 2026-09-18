/**
 * A part of the benchmark the proposer is never shown.
 *
 * `compareScorecards` already refuses any candidate that regresses a task, so
 * the crude form of overfitting — win here, break there — has never been the
 * risk. The risk is narrower and quieter: `hypothesisBrief()` hands the
 * proposer the id of every failing task, the error each one produced, and the
 * directory its failed run was kept in. A model given that much detail can
 * write a change that satisfies those specific failures and nothing more, and
 * the benchmark will honestly report a higher pass rate for it. The score goes
 * up; the agent does not get better. With 54 tasks and four of them failing,
 * that is a cheap way to look like progress.
 *
 * So one deterministic slice of the corpus is held back from the *evidence*:
 * its ids, its pass/fail status, its failure details and its step counts are
 * all withheld from the brief. It is still measured, still scored, and still
 * able to reject the candidate exactly as before — what changes is that a gain
 * on a held-out task cannot have been aimed at, so it is evidence the change
 * generalised rather than evidence the model read a stack trace carefully.
 *
 * What this does NOT claim: the brief tells the proposer to read
 * `src/evolve/suite.ts`, and that file defines every task, held-out ones
 * included. A determined model can still see that the tasks exist. Withholding
 * *which of them fail and why* removes the targeting channel that actually
 * matters, and pretending it removes more than that would make this one more
 * gate that measures nothing.
 *
 * The assignment is a hash of the task id, not a slice of a list, so it is
 * stable: harvesting new tasks never reshuffles which existing tasks are held
 * out, and two runs on different machines split the corpus identically. A
 * split that moved between generations would make the two halves' scores
 * incomparable across a run, which is the one thing this must not do.
 */

import { cardFromOutcomes, toMetrics, type TaskOutcome } from './fitness.ts'
import type { BenchTask } from './suite.ts'
import type { Metrics } from './ledger.ts'

/** Fraction of the corpus held back from the proposer's evidence. */
export const DEFAULT_HELD_OUT_FRACTION = 0.3

/** Below this many tasks there is no honest split — a one-task held-out half is noise, not a control. */
const MIN_TASKS_TO_SPLIT = 4

export interface TaskSplit {
  /** Tasks the proposer may see evidence from. */
  train: BenchTask[]
  /** Tasks withheld from the brief. Empty when the corpus is too small to split. */
  heldOut: BenchTask[]
  /** True when the corpus was large enough to actually hold tasks back. */
  split: boolean
}

export function heldOutFraction(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.ELIA_HELD_OUT_FRACTION)
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return DEFAULT_HELD_OUT_FRACTION
  return value
}

/** Whether the split is active at all. `ELIA_HELD_OUT=off` is the control arm for measuring its effect. */
export function splitEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ELIA_HELD_OUT !== 'off'
}

/**
 * FNV-1a over the task id, as a fraction in [0, 1).
 *
 * Any stable hash would do; what matters is that it depends on the id alone.
 * Assigning by position in the list would mean that harvesting one new task
 * could move an existing task from train to held-out, and a generation
 * measured before that move would no longer be comparable with one measured
 * after it.
 */
export function taskHash(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x100000000
}

/**
 * Split a task set into the half the proposer sees evidence from and the half
 * it does not.
 *
 * Small sets are deliberately not split: with three tasks, holding one back
 * leaves a "generalisation" signal that a single flaky run can invert, and
 * starves an already thin corpus. `elia evolve --focus` on a handful of tasks
 * therefore behaves exactly as it did before this file existed.
 */
export function splitTasks(tasks: BenchTask[], fraction = heldOutFraction()): TaskSplit {
  if (tasks.length < MIN_TASKS_TO_SPLIT || !splitEnabled()) return { train: tasks, heldOut: [], split: false }

  const heldOut = tasks.filter((task) => taskHash(task.id) < fraction)
  // A hash can land every task on one side. Rather than silently returning an
  // empty half — which would read downstream as "nothing generalised" — fall
  // back to the single task furthest into the held-out end of the hash space.
  if (heldOut.length === 0) {
    const furthest = [...tasks].sort((a, b) => taskHash(a.id) - taskHash(b.id))[0]!
    return { train: tasks.filter((task) => task.id !== furthest.id), heldOut: [furthest], split: true }
  }
  if (heldOut.length === tasks.length) {
    const furthest = [...tasks].sort((a, b) => taskHash(b.id) - taskHash(a.id))[0]!
    return { train: [furthest], heldOut: tasks.filter((task) => task.id !== furthest.id), split: true }
  }

  return { train: tasks.filter((task) => taskHash(task.id) >= fraction), heldOut, split: true }
}

/**
 * The same metrics `compareScorecards` consumes, computed over one half of the
 * corpus.
 *
 * Built by re-running the card arithmetic on a subset rather than by
 * recomputing a pass rate here, so the two halves and the whole are scored by
 * one implementation. A second copy of that weighting would drift.
 *
 * The efficiency fields (tokens, wall clock) of a half-card are not meaningful
 * — the two halves ran interleaved — and nothing here reads them. Only the
 * pass rate and the per-task rates are used.
 */
export function halfMetrics(outcomes: TaskOutcome[], tasks: BenchTask[]): Metrics {
  const ids = new Set(tasks.map((task) => task.id))
  return toMetrics(cardFromOutcomes('', tasks, outcomes.filter((outcome) => ids.has(outcome.taskId)), 0))
}

export type GeneralizationVerdict =
  /** Gained on at least one task whose failures were never shown. */
  | 'generalized'
  /** Gained only where the proposer was handed the failure. */
  | 'shown-only'
  /** No task moved by more than run-to-run noise in either half. */
  | 'flat'
  /** The corpus was too small to hold anything back, or the split is off. */
  | 'not-split'

export interface GeneralizationRecord {
  verdict: GeneralizationVerdict
  trainPassRate: number
  heldOutPassRate: number
  /** Held-out tasks the candidate actually re-ran, as opposed to inheriting from the baseline. */
  heldOutMeasured: number
  heldOutTotal: number
  /** Held-out task ids that improved. */
  gainedUnseen: string[]
  /** Train task ids that improved. */
  gainedShown: string[]
  detail: string
}

/** A task's pass fraction, from whichever field the metrics carry it in. */
function rates(metrics: Metrics): Record<string, number> {
  if (metrics.taskRates) return metrics.taskRates
  return Object.fromEntries([...metrics.failed.map((id) => [id, 0] as const), ...metrics.passed.map((id) => [id, 1] as const)])
}

export interface ClassifyOptions {
  /** The rows the current baseline was scored from. */
  baselineOutcomes: TaskOutcome[]
  /** The rows the candidate was scored from, carried-over rows included. */
  candidateOutcomes: TaskOutcome[]
  split: TaskSplit
  /** Task ids the candidate actually ran. The sieve carries the rest over from the baseline unchanged. */
  ranTaskIds: string[]
  /** Smallest per-task movement that counts as real — `REAL_CHANGE` from fitness.ts. */
  realChange: number
}

/**
 * Where a candidate's gain actually landed.
 *
 * This deliberately produces a label and not a veto. The loop has promoted
 * nothing since it was built, and a gate that rejected every change whose gain
 * sat on a shown task would keep it at zero while claiming to protect it. What
 * the ledger has never been able to say is whether a win generalised; now it
 * can, and `elia compounding` can read it. A rule that acts on this belongs
 * downstream, once there are enough promotions to know what it would have cost.
 *
 * `heldOutMeasured` is part of the record for the same reason: the sieve only
 * re-runs the tasks a diff can reach, so a candidate can be labelled
 * 'shown-only' simply because no held-out task was ever run against it. A
 * verdict of 'generalized' on zero measured held-out tasks would be a lie, and
 * the count is what makes that checkable rather than assumed.
 */
export function classifyGeneralization(options: ClassifyOptions): GeneralizationRecord {
  const { baselineOutcomes, candidateOutcomes, split, ranTaskIds, realChange } = options
  const heldOutIds = new Set(split.heldOut.map((task) => task.id))
  const heldOutMeasured = ranTaskIds.filter((id) => heldOutIds.has(id)).length

  if (!split.split) {
    return {
      verdict: 'not-split',
      trainPassRate: halfMetrics(candidateOutcomes, split.train).passRate,
      heldOutPassRate: 0,
      heldOutMeasured,
      heldOutTotal: split.heldOut.length,
      gainedUnseen: [],
      gainedShown: [],
      detail: `corpus of ${split.train.length} task(s) is too small to hold any back`,
    }
  }

  const trainBefore = halfMetrics(baselineOutcomes, split.train)
  const trainAfter = halfMetrics(candidateOutcomes, split.train)
  const unseenBefore = halfMetrics(baselineOutcomes, split.heldOut)
  const unseenAfter = halfMetrics(candidateOutcomes, split.heldOut)

  const gained = (before: Metrics, after: Metrics) => {
    const from = rates(before)
    const to = rates(after)
    return Object.keys(to).filter((id) => (to[id] ?? 0) - (from[id] ?? 0) >= realChange)
  }
  const gainedShown = gained(trainBefore, trainAfter)
  const gainedUnseen = gained(unseenBefore, unseenAfter)

  const verdict: GeneralizationVerdict = gainedUnseen.length > 0 ? 'generalized' : gainedShown.length > 0 ? 'shown-only' : 'flat'
  const detail = verdict === 'generalized'
    ? `gained ${gainedUnseen.join(', ')} without being shown ${gainedUnseen.length === 1 ? 'its failure' : 'their failures'}`
    : verdict === 'shown-only'
      ? `gained only on shown tasks (${gainedShown.join(', ')}); ${heldOutMeasured} of ${split.heldOut.length} held-out task(s) were re-run`
      : 'no task moved by more than run-to-run noise in either half'

  return {
    verdict,
    trainPassRate: trainAfter.passRate,
    heldOutPassRate: unseenAfter.passRate,
    heldOutMeasured,
    heldOutTotal: split.heldOut.length,
    gainedUnseen,
    gainedShown,
    detail,
  }
}

/**
 * The baseline as the proposer is allowed to see it: every trace of a held-out
 * task removed.
 *
 * The whole `Metrics` object still drives the comparison — only the copy that
 * reaches the brief is thinned. `passRate` is recomputed over the shown half so
 * the headline number the proposer reasons about is the one it can actually
 * account for, rather than a total that silently includes tasks it is not
 * being told about.
 */
export function blindMetrics(metrics: Metrics, split: TaskSplit, shownPassRate: number): Metrics {
  if (!split.split) return metrics
  const heldOutIds = new Set(split.heldOut.map((task) => task.id))
  const keep = (ids: string[] | undefined) => ids?.filter((id) => !heldOutIds.has(id))
  const keepRecord = <T,>(record: Record<string, T> | undefined) =>
    record && Object.fromEntries(Object.entries(record).filter(([id]) => !heldOutIds.has(id)))

  const blinded: Metrics = {
    ...metrics,
    passRate: shownPassRate,
    passed: keep(metrics.passed) ?? [],
    failed: keep(metrics.failed) ?? [],
  }
  const unmeasured = keep(metrics.unmeasured)
  if (unmeasured) blinded.unmeasured = unmeasured
  else delete blinded.unmeasured
  const steps = keepRecord(metrics.steps)
  if (steps) blinded.steps = steps
  const taskRates = keepRecord(metrics.taskRates)
  if (taskRates) blinded.taskRates = taskRates
  return blinded
}

/** Failure evidence with held-out tasks stripped. */
export function blindEvidence(evidence: TaskOutcome[], split: TaskSplit): TaskOutcome[] {
  if (!split.split) return evidence
  const heldOutIds = new Set(split.heldOut.map((task) => task.id))
  return evidence.filter((outcome) => !heldOutIds.has(outcome.taskId))
}

export function renderSplit(split: TaskSplit): string {
  if (!split.split) return `${split.train.length} task(s), too few to hold any back — the proposer sees every failure`
  return `${split.train.length} shown / ${split.heldOut.length} held back from the proposer's evidence`
}

export function renderGeneralization(record: GeneralizationRecord): string {
  if (record.verdict === 'not-split') return `generalisation: not measured — ${record.detail}`
  const rate = `shown ${Math.round(record.trainPassRate * 100)}%, held-out ${Math.round(record.heldOutPassRate * 100)}% (${record.heldOutMeasured}/${record.heldOutTotal} re-run)`
  return `generalisation: ${record.verdict} — ${record.detail} · ${rate}`
}
