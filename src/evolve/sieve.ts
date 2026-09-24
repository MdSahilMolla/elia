import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../statePaths.ts'
import {
  REAL_CHANGE,
  cardFromOutcomes,
  compareScorecards,
  measureFitness,
  mightMeasureLater,
  toMetrics,
  type Comparison,
  type MeasureOptions,
  type Scorecard,
  type TaskOutcome,
} from './fitness.ts'
import { overlap, readReach, relevantTasks, type ReachMap } from './reach.ts'
import type { BenchTask } from './suite.ts'
import type { Metrics } from './ledger.ts'

/**
 * Buying a verdict instead of buying a benchmark.
 *
 * Scoring one candidate used to mean running every task against a model: 54
 * agent runs to learn a single bit, and almost always the bit is "no". That
 * price is why `elia evolve` has turned twice since August while the machinery
 * around it kept growing — the loop is not missing parts, it is starved of
 * affordable evidence. A search that costs a day's credit per step does not
 * compound, however good its parts are.
 *
 * The saving comes from reading the decision rule rather than the scoreboard.
 * `compareScorecards` rejects a candidate the moment *any* task regresses,
 * whatever the other fifty-three say. So a run that has already seen a
 * regression has already produced the final verdict, and every task after it is
 * paid for and discarded. The same holds for a task that could not be measured:
 * the comparison fails closed on it before it looks at anything else.
 *
 * Two facts make that exploitable:
 *
 *   1. **Most tasks cannot be affected at all.** `reach.ts` records which
 *      modules each task loads, so a task that never loads a changed file is
 *      provably unmoved and its baseline outcome — result, tokens and time
 *      alike — carries straight over. Carrying the *cost* too is what keeps the
 *      efficiency tie-break honest; dropping those tasks from the total would
 *      make every candidate look cheaper than it is.
 *   2. **Order is free to choose.** Only a task that passes today can regress,
 *      and a task that loads more of the diff is likelier to be the one that
 *      breaks. Running those first is what turns "reject" from a 54-task
 *      question into a two-task one.
 *
 * The result is verdict-identical, not approximate. Racing changes what gets
 * run, never how the answer is decided: every stop rule here returns the same
 * `better` the full sweep would have returned, from the same `compareScorecards`
 * called on the same arithmetic. What shrinks is the bill.
 *
 * Set `ELIA_SIEVE=off` to fall back to measuring everything — the fallback is
 * the control arm for measuring this file's own effect.
 */

export interface RaceOptions {
  /** The candidate tree to measure. */
  sourceRoot: string
  /** The full task set the verdict is about. */
  tasks: BenchTask[]
  /** What the candidate is being compared against. */
  baseline: Metrics
  /** The baseline's per-task outcomes, needed to carry unreachable tasks over intact. */
  baselineOutcomes: TaskOutcome[]
  /** Files the builder actually changed, repo-relative. */
  changedFiles: string[]
  repeats?: number
  concurrency?: number
  signal?: AbortSignal
  onTaskDone?: (outcome: TaskOutcome) => void
  /** Injection seams for tests; both default to the real thing. */
  measure?: (options: MeasureOptions) => Promise<Scorecard>
  reach?: ReachMap
}

export interface RaceReport {
  card: Scorecard
  comparison: Comparison
  /** Tasks actually measured against the candidate. */
  ran: string[]
  /** Tasks whose baseline outcome carried over because the diff cannot reach them. */
  carried: string[]
  /** Tasks never run, because the verdict was already settled. */
  skipped: string[]
  /** The task that settled an early verdict, when one did. */
  settledBy?: string
  /** The baseline as compared, when a retest pooled rows into it (settleRegressions). */
  baseline?: Metrics
  tokens: number
  elapsedMs: number
}

export function sieveEnabled(): boolean {
  return (process.env.ELIA_SIEVE ?? '').toLowerCase() !== 'off'
}

/** Tasks that scored worse than the baseline by more than run-to-run noise — `compareScorecards`' rule, applied to a partial set. */
export function regressionsIn(baseline: Metrics, outcomes: TaskOutcome[]): string[] {
  const before = baselineRates(baseline)
  return outcomes
    .filter((outcome) => !outcome.unmeasured)
    .filter((outcome) => (before[outcome.taskId] ?? 0) - rateOf(outcome) >= REAL_CHANGE)
    .map((outcome) => outcome.taskId)
}

/**
 * Two measurements of one task, as one: attempts and passes summed, costs
 * summed, and unmeasured if either side was.
 */
export function poolRows(first: TaskOutcome, second: TaskOutcome): TaskOutcome {
  const attempts = (first.attempts ?? 1) + (second.attempts ?? 1)
  const passes = (first.attempts ? (first.passes ?? 0) : first.passed ? 1 : 0) + (second.attempts ? (second.passes ?? 0) : second.passed ? 1 : 0)
  const { keptDir: _keptDir, trace: _trace, error: _error, ...rest } = first
  const failing = [second, first].find((row) => !row.passed)
  const pooled: TaskOutcome = {
    ...rest,
    passed: passes * 2 >= attempts,
    attempts,
    passes,
    detail: `${passes}/${attempts} attempts passed (pooled over a retest)`,
    steps: Math.round((first.steps * (first.attempts ?? 1) + second.steps * (second.attempts ?? 1)) / attempts),
    elapsedMs: first.elapsedMs + second.elapsedMs,
    totalTokens: first.totalTokens + second.totalTokens,
  }
  delete pooled.unmeasured
  if (failing?.error) pooled.error = failing.error
  if (failing?.trace) pooled.trace = failing.trace
  if (failing?.keptDir) pooled.keptDir = failing.keptDir
  if (first.unmeasured || second.unmeasured) pooled.unmeasured = true
  return pooled
}

export interface SettledRegressions {
  /** Tasks that still regress with both sides pooled, or could not be re-measured. */
  confirmed: string[]
  candidateRows: TaskOutcome[]
  baselineRows: TaskOutcome[]
}

/**
 * A regression has to happen again before it rejects.
 *
 * Every task is a handful of attempts on each side, and the baseline side is
 * often a row cached from one earlier sweep, so a coin-flip task hands whichever
 * candidate draws low a "regression". The first run here showed it:
 * field-external-contribution scored 0/3, 2/3, 1/3 and 0/3 across sweeps of
 * unchanged code, and vetoed a candidate that shortened read_file's
 * description — a change that cannot reach a git task — because the baseline
 * row happened to hold 2/3.
 *
 * So each apparent regression is measured again on both trees, fresh, and the
 * two sides are judged on their pooled attempts. A task a candidate really
 * breaks fails again; one that cannot be re-measured stays a regression. The
 * pooled rows replace the originals on both sides, so whatever is compared next
 * compares like with like.
 */
export async function settleRegressions(options: {
  regressed: string[]
  tasks: BenchTask[]
  candidateRoot: string
  liveRoot?: string
  candidateRows: TaskOutcome[]
  baselineRows: TaskOutcome[]
  repeats?: number
  measure?: (options: MeasureOptions) => Promise<Scorecard>
}): Promise<SettledRegressions> {
  const measure = options.measure ?? measureFitness
  const liveRoot = options.liveRoot ?? ELIA_ROOT
  const candidate = new Map(options.candidateRows.map((row) => [row.taskId, row] as const))
  const baseline = new Map(options.baselineRows.map((row) => [row.taskId, row] as const))
  const confirmed: string[] = []
  for (const id of options.regressed) {
    const task = options.tasks.find((entry) => entry.id === id)
    const before = baseline.get(id)
    const after = candidate.get(id)
    if (!task || !before || !after) {
      confirmed.push(id)
      continue
    }
    const repeats = options.repeats === undefined ? {} : { repeats: options.repeats }
    const [again, baselineAgain] = await Promise.all([
      measure({ sourceRoot: options.candidateRoot, tasks: [task], concurrency: 1, ...repeats }),
      measure({ sourceRoot: liveRoot, tasks: [task], concurrency: 1, ...repeats }),
    ])
    const afterMore = again.outcomes[0]
    const beforeMore = baselineAgain.outcomes[0]
    if (!afterMore || !beforeMore || afterMore.unmeasured || beforeMore.unmeasured) {
      confirmed.push(id)
      continue
    }
    const pooledAfter = poolRows(after, afterMore)
    const pooledBefore = poolRows(before, beforeMore)
    candidate.set(id, pooledAfter)
    baseline.set(id, pooledBefore)
    if (rateOf(pooledBefore) - rateOf(pooledAfter) >= REAL_CHANGE) confirmed.push(id)
  }
  return {
    confirmed,
    candidateRows: options.candidateRows.map((row) => candidate.get(row.taskId) ?? row),
    baselineRows: options.baselineRows.map((row) => baseline.get(row.taskId) ?? row),
  }
}

function baselineRates(baseline: Metrics): Record<string, number> {
  return (
    baseline.taskRates ??
    Object.fromEntries([...baseline.failed.map((id) => [id, 0] as const), ...baseline.passed.map((id) => [id, 1] as const)])
  )
}

function rateOf(outcome: TaskOutcome): number {
  return outcome.attempts ? (outcome.passes ?? 0) / outcome.attempts : outcome.passed ? 1 : 0
}

/**
 * The order to spend the budget in: the tasks most likely to end the race first.
 *
 * A failing task cannot regress, so it is worth nothing to a rejection and goes
 * last — which is also where it is worth most to an *acceptance*, since a gain
 * has to come from somewhere. Between two passing tasks, the one carrying more
 * of the diff is the better bet, and a tie goes to whichever was cheaper to run
 * last time: a cheap kill is a cheaper kill.
 */
export function raceOrder(
  tasks: BenchTask[],
  baseline: Metrics,
  changedFiles: string[],
  map: ReachMap,
  baselineOutcomes: TaskOutcome[] = [],
): BenchTask[] {
  const before = baselineRates(baseline)
  const costOf = new Map(baselineOutcomes.map((outcome) => [outcome.taskId, outcome.elapsedMs] as const))
  return [...tasks].sort((a, b) => {
    const risk = (task: BenchTask) => (before[task.id] ?? 0) * (1 + overlap(task.id, changedFiles, map))
    const delta = risk(b) - risk(a)
    if (Math.abs(delta) > 1e-9) return delta
    return (costOf.get(a.id) ?? 0) - (costOf.get(b.id) ?? 0)
  })
}

/**
 * A carried outcome: the baseline's own result for a task the diff cannot reach.
 *
 * Everything that feeds the comparison comes across — the pass rate, the repeat
 * counts behind it, the tokens and the wall clock — because the claim being made
 * is that this task runs identical code and would therefore have produced an
 * identical row. What does not come across is `keptDir`, which points into the
 * baseline's evidence directory and would misattribute it to the candidate.
 */
export function carryOutcome(outcome: TaskOutcome): TaskOutcome {
  const { keptDir: _keptDir, ...rest } = outcome
  return { ...rest, detail: `${outcome.detail}${outcome.detail ? ' ' : ''}(carried: diff does not reach this task)` }
}

function notRun(task: BenchTask, why: string): TaskOutcome {
  return { taskId: task.id, weight: task.weight, passed: false, detail: why, steps: 0, elapsedMs: 0, totalTokens: 0, unmeasured: true }
}

/**
 * What the suite's wall clock would have been, had every task actually run.
 *
 * Tokens survive carrying — a carried row brings the baseline's own token count
 * with it, so the totals stay like for like. Wall clock does not: it is the
 * duration of a *parallel* sweep, and a race that ran two tasks finishes in
 * seconds. Handing that number to the efficiency tie-break would let every
 * candidate claim a 99% speed-up for the sole reason that the sieve stopped
 * early — the sieve marking its own homework.
 *
 * So scale instead of measure. The baseline's parallel duration is known, and so
 * is the ratio between the two sides' summed task durations; the concurrency and
 * the task set are identical, so that ratio is what the parallel duration moves
 * by. Carried tasks contribute the same time to both sums and cancel, which
 * leaves exactly the signal from the tasks that actually ran.
 *
 * It is an estimate, and it is never what promotes anything: a provisional win
 * still has to reproduce on two full sweeps in `engine.ts` before it is allowed
 * near live code.
 */
export function scaledWallClock(baseline: Metrics, candidateTotalElapsedMs: number): number {
  const baselineWall = baseline.wallClockMs ?? baseline.totalElapsedMs
  if (!baseline.totalElapsedMs || !baselineWall) return candidateTotalElapsedMs
  return Math.round(baselineWall * (candidateTotalElapsedMs / baseline.totalElapsedMs))
}

export async function raceCandidate(options: RaceOptions): Promise<RaceReport> {
  const startedAt = Date.now()
  const measure = options.measure ?? measureFitness
  const map = options.reach ?? readReach()
  const concurrency = Math.max(1, options.concurrency ?? 1)

  const byId = new Map(options.tasks.map((task) => [task.id, task] as const))
  const baselineById = new Map(options.baselineOutcomes.map((outcome) => [outcome.taskId, outcome] as const))

  const split = relevantTasks(options.changedFiles, [...byId.keys()], map)

  // A task can only be carried if there is a baseline row to carry. Without one
  // there is nothing to claim it would have produced, so it gets measured.
  const carriedIds = split.inert.filter((id) => baselineById.has(id))
  const unreachableWithoutBaseline = split.inert.filter((id) => !baselineById.has(id))

  // A file the live tree does not have is a file no recording could mention, and
  // a registry that discovers modules at runtime could load it without any
  // recorded importer changing. Rather than reason about that, refuse to call a
  // diff inert while it contains one.
  const addsFiles = options.changedFiles.some((file) => !existsSync(join(ELIA_ROOT, file)))

  let relevantIds = [...split.relevant, ...unreachableWithoutBaseline]
  let carried = carriedIds
  if (relevantIds.length === 0 && addsFiles) {
    relevantIds = [...byId.keys()]
    carried = []
  }

  if (relevantIds.length === 0) {
    // Nothing the benchmark measures runs this code. That is the same verdict a
    // full sweep would reach — two identical scorecards — for none of the price.
    const outcomes = carried.map((id) => carryOutcome(baselineById.get(id)!))
    const card = cardFromOutcomes(
      options.sourceRoot,
      options.tasks,
      outcomes,
      scaledWallClock(options.baseline, outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0)),
    )
    return {
      card,
      comparison: {
        better: false,
        reason: `no measurable improvement — the diff changes no module any of the ${options.tasks.length} benchmark task(s) loads, so every score is unchanged`,
      },
      ran: [],
      carried,
      skipped: [],
      tokens: 0,
      elapsedMs: Date.now() - startedAt,
    }
  }

  const ordered = raceOrder(
    relevantIds.map((id) => byId.get(id)!),
    options.baseline,
    options.changedFiles,
    map,
    options.baselineOutcomes,
  )

  let measured: TaskOutcome[] = []
  let settledBy: string | undefined
  let settledReason: string | undefined
  // Retests pool rows into both sides; from then on the race is judged against
  // the pooled baseline, so the two sides stay like for like.
  let baseline = options.baseline
  let baselineRows = options.baselineOutcomes
  let retested = false

  // A task the provider could not answer for goes to the back of the queue and
  // is measured once more after everything else, instead of settling the race
  // on the spot. `runTaskWithRetry` already retried it, but within seconds or a
  // few minutes, inside the same outage; minutes of other tasks later the
  // provider has usually come back. Generation 15 had run 24 of 26 tasks when
  // one history task hit "Connection error." and another a stalled provider,
  // and the whole generation was thrown away. The verdict does not change: a
  // task still unmeasured on its second turn refuses the comparison exactly as
  // before, and a regression anywhere still settles the race early.
  const queue = [...ordered]
  const retriedLater = new Set<string>()
  // Tokens spent on a first turn that a second one replaced — still spent.
  let replacedTokens = 0

  for (let index = 0; index < queue.length; index += concurrency) {
    if (options.signal?.aborted) break
    const wave = queue.slice(index, index + concurrency)
    const card = await measure({
      sourceRoot: options.sourceRoot,
      tasks: wave,
      concurrency,
      ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
      ...(options.onTaskDone ? { onTaskDone: options.onTaskDone } : {}),
    })
    const rerun = new Set(wave.map((task) => task.id))
    replacedTokens += measured.filter((outcome) => rerun.has(outcome.taskId)).reduce((sum, outcome) => sum + outcome.totalTokens, 0)
    measured = [...measured.filter((outcome) => !rerun.has(outcome.taskId)), ...card.outcomes]

    // `compareScorecards` refuses an incomplete measurement before it looks at
    // anything else, so a task that stays unmeasured is the whole answer.
    const unmeasured = card.outcomes.filter((outcome) => outcome.unmeasured)
    const final = unmeasured.filter((outcome) => retriedLater.has(outcome.taskId) || !mightMeasureLater(outcome)).map((outcome) => outcome.taskId)
    if (final.length > 0) {
      settledBy = final[0]
      settledReason = `could not measure ${final.join(', ')} — refusing to compare an incomplete benchmark`
      break
    }
    for (const outcome of unmeasured) {
      retriedLater.add(outcome.taskId)
      queue.push(byId.get(outcome.taskId)!)
    }

    const apparent = regressionsIn(baseline, card.outcomes)
    if (apparent.length > 0) {
      const settled = await settleRegressions({
        regressed: apparent,
        tasks: options.tasks,
        candidateRoot: options.sourceRoot,
        candidateRows: measured,
        baselineRows,
        measure,
        ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
      })
      measured = settled.candidateRows
      baselineRows = settled.baselineRows
      baseline = baselineFromRows(options.baseline, options.tasks, baselineRows)
      retested = true
      if (settled.confirmed.length > 0) {
        settledBy = settled.confirmed[0]
        settledReason = `regressed on ${settled.confirmed.join(', ')} — a task that passed before now fails${options.baseline.taskRates ? ' (by at least half its attempts, and again with both sides re-run)' : ''}`
        break
      }
    }
  }

  const ranIds = new Set(measured.map((outcome) => outcome.taskId))
  const skipped = ordered.filter((task) => !ranIds.has(task.id)).map((task) => task.id)

  // A race that stopped early leaves real holes. They are recorded as unmeasured
  // rather than quietly omitted, so the ledger row this card becomes says the
  // candidate was never fully scored — and any later comparison against it fails
  // closed instead of reading a partial sweep as a result.
  const outcomes: TaskOutcome[] = [
    ...measured,
    ...carried.map((id) => carryOutcome(baselineById.get(id)!)),
    ...skipped.map((id) => notRun(byId.get(id)!, 'not run — the verdict was already settled')),
  ]

  const totalElapsedMs = outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0)
  // A task measured a second time made the race longer than a sweep of this
  // candidate would have been, so its elapsed clock would charge the candidate
  // for the provider's outage. Its rows replaced the dropped ones, so the
  // scaled estimate below counts each task once.
  const partial = carried.length > 0 || skipped.length > 0 || retriedLater.size > 0
  const card = cardFromOutcomes(
    options.sourceRoot,
    options.tasks,
    outcomes,
    partial ? scaledWallClock(baseline, totalElapsedMs) : Date.now() - startedAt,
  )
  const comparison: Comparison = settledReason
    ? { better: false, reason: settledReason }
    : compareScorecards(baseline, toMetrics(card))

  return {
    card,
    comparison,
    ran: [...ranIds],
    carried,
    skipped,
    ...(settledBy ? { settledBy } : {}),
    ...(retested ? { baseline } : {}),
    tokens: replacedTokens + measured.reduce((sum, outcome) => sum + outcome.totalTokens, 0),
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * The baseline's metrics rebuilt from its rows after a retest pooled some of
 * them, by the same arithmetic every card uses. Its wall clock scales with the
 * summed task time, as a partial card's does.
 */
export function baselineFromRows(original: Metrics, tasks: BenchTask[], rows: TaskOutcome[]): Metrics {
  const total = rows.reduce((sum, row) => sum + row.elapsedMs, 0)
  return toMetrics(cardFromOutcomes(ELIA_ROOT, tasks, rows, scaledWallClock(original, total)))
}

/** One line for the operator: what the race cost against what the sweep would have. */
export function renderRace(report: RaceReport, total: number): string {
  const saved = total - report.ran.length
  const parts = [`${report.ran.length}/${total} task(s) run`]
  if (report.carried.length > 0) parts.push(`${report.carried.length} carried`)
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.length} skipped${report.settledBy ? ` after ${report.settledBy} settled it` : ''}`)
  }
  return `${parts.join(', ')} — ${saved} task run(s) not paid for`
}
