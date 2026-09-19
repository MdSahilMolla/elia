import { compareScorecards } from './fitness.ts'
import type { Metrics } from './ledger.ts'

/**
 * Mirrors the private `REAL_CHANGE` in fitness.ts: how far a task's pass rate must
 * move before the gate calls it a change rather than noise. Kept as a copy so this
 * module can report on the threshold without widening fitness.ts's exported surface.
 */
const REAL_CHANGE = 0.5

/**
 * How large a real improvement must be before the gate can actually promote it.
 *
 * `elia evolve` has run two generations and promoted neither, and the ledger
 * cannot say whether that is because the proposals were bad or because the gate
 * cannot see a good one. Those are opposite problems with opposite fixes, and
 * guessing between them is how a loop stays stalled for a month.
 *
 * So this measures the gate instead of arguing about it. Task outcomes are drawn
 * from Bernoulli models rather than run, which costs no API spend, and the real
 * `compareScorecards` decides each trial — including the confirmation pair, since
 * a candidate must clear the same bar twice before it ships. The output is the
 * one number that matters: the smallest improvement the current benchmark can
 * carry to a promotion.
 *
 * What it found when written, before the sieve and repeated-run scoring landed:
 * a candidate that genuinely fixed *every* remaining failure was promoted 13% of
 * the time. That number is now historical, and leaving it here as current would
 * point the next reader at a problem that has since been fixed.
 *
 * Re-measured on the suite as it stands (54 tasks, ~93% pass rate, 4 failures),
 * with the sieve on as it ships:
 *
 *   repeats  true gain .8   .4     .2     promotes a no-op
 *   1        99.0%          46.5%  25.4%  8.6%
 *   3        100%           73.2%  28.9%  3.0%
 *   5        100%           72.7%  21.0%  0.4%
 *
 * The gate is no longer blind to a large win; the sieve fixed that by keeping
 * carried tasks from flipping. What remains is the other direction. At one run
 * per task, about one candidate in twelve that is identical to the baseline
 * clears both the race and the confirmation pair, and a self-improvement loop
 * that promotes noise at that rate compounds the noise. `benchRepeats` now
 * defaults to 3 for that reason, and the table above is its justification.
 *
 * The genuine remaining limit is small wins: a true gain of 0.2 is promoted less
 * than a third of the time at any repeat count. That is a benchmark-headroom
 * problem — 46 of 54 tasks sit at ~99% and cannot show improvement — not a gate
 * problem, and it is what `hardSuite.ts` exists to address.
 */

export interface PowerTask {
  id: string
  /** True probability this task passes on any one attempt. */
  pi: number
}

export interface PowerResult {
  /** Fraction of trials where a genuinely better candidate cleared race + confirmation. */
  promoted: number
  /** Fraction where an identical candidate cleared both — the false-promotion rate. */
  falsePromoted: number
  /** Benchmark task-runs one generation costs at this suite size and repeat count. */
  costPerGeneration: number
}

/** Deterministic RNG so a power number is reproducible and a test can assert on it. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Per-task pass rates for one sweep, drawn rather than run. */
function drawRates(tasks: PowerTask[], repeats: number, random: () => number): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const task of tasks) {
    let hits = 0
    for (let attempt = 0; attempt < repeats; attempt++) if (random() < task.pi) hits++
    rates[task.id] = hits / repeats
  }
  return rates
}

function toMetricsFromRates(rates: Record<string, number>, repeats: number): Metrics {
  const ids = Object.keys(rates)
  return {
    passRate: ids.length === 0 ? 0 : ids.reduce((sum, id) => sum + rates[id]!, 0) / ids.length,
    passed: ids.filter((id) => rates[id]! > 0.5),
    failed: ids.filter((id) => rates[id]! <= 0.5),
    // Matches toMetrics: single-run records carry no rates, because passed/failed already are them.
    ...(repeats > 1 ? { taskRates: rates } : {}),
    totalTokens: 1_000_000,
    totalElapsedMs: 1_000_000,
    wallClockMs: 1_000_000,
  }
}

/** One benchmark sweep, drawn rather than run. */
export function simulateSweep(tasks: PowerTask[], repeats: number, random: () => number): Metrics {
  return toMetricsFromRates(drawRates(tasks, repeats, random), repeats)
}

/**
 * One baseline/candidate pair under the sieve.
 *
 * `raceCandidate` copies the baseline's own row for any task the diff provably
 * cannot reach (`carryOutcome`, sieve.ts), so a carried task is byte-identical on
 * both sides and cannot flip. That makes the multiple-comparison exposure the
 * re-run set rather than the whole corpus, and it matters enormously: on the
 * current suite a genuine win goes from 5% promoted at 54 re-run tasks to 96% at
 * 4. Modelling all tasks as independently re-drawn — as this module first did —
 * understates the gate badly on any diff the reach map can narrow.
 */
function drawPair(
  tasks: PowerTask[],
  candidate: PowerTask[],
  repeats: number,
  random: () => number,
  rerun?: Set<string>,
): [Metrics, Metrics] {
  const baseRates = drawRates(tasks, repeats, random)
  const candRates = drawRates(candidate, repeats, random)
  const merged: Record<string, number> = {}
  for (const task of candidate) merged[task.id] = !rerun || rerun.has(task.id) ? candRates[task.id]! : baseRates[task.id]!
  return [toMetricsFromRates(baseRates, repeats), toMetricsFromRates(merged, repeats)]
}

/**
 * The tasks a diff aimed at the current failures would re-run: every failing task,
 * plus `neighbours` passing ones the reach map also implicates.
 */
export function rerunSet(tasks: PowerTask[], size: number): Set<string> {
  const failing = tasks.filter((task) => task.pi < 0.5).map((task) => task.id)
  const ids = new Set(failing)
  for (const task of tasks) {
    if (ids.size >= size) break
    ids.add(task.id)
  }
  return ids
}

/** A candidate improved by `delta` absolute pass probability on every task. */
export function improvedBy(tasks: PowerTask[], delta: number): PowerTask[] {
  return tasks.map((task) => ({ ...task, pi: Math.max(0, Math.min(0.995, task.pi + delta)) }))
}

export interface PowerOptions {
  tasks: PowerTask[]
  repeats: number
  /** Absolute pass-probability gain the candidate really has. */
  delta: number
  trials?: number
  seed?: number
  /** Defaults to the live gate. Supplied by tests, and by anyone comparing a replacement rule. */
  rule?: (baseline: Metrics, candidate: Metrics) => boolean
  /**
   * Tasks the sieve actually re-runs. Everything else carries the baseline's own
   * row and cannot flip. Omit to model ELIA_SIEVE=off, where every task is re-run.
   */
  rerun?: Set<string>
}

const liveRule = (baseline: Metrics, candidate: Metrics) => compareScorecards(baseline, candidate).better

/**
 * Promotion probability under the real gate, including the confirmation pair.
 *
 * `engine.ts` runs the race, and only on a provisional win runs an independent
 * baseline/candidate pair that must agree. A rule that clears the race 40% of the
 * time promotes 16% of the time, and reporting the race alone would overstate the
 * gate's reach by the square root.
 */
export function measurePower(options: PowerOptions): PowerResult {
  const { tasks, repeats, delta, trials = 2000, seed = 1, rule = liveRule, rerun } = options
  const random = seededRandom(seed)
  const better = improvedBy(tasks, delta)

  const clears = (candidate: PowerTask[]): boolean => rule(...drawPair(tasks, candidate, repeats, random, rerun))
  // The race, then the independent confirmation pair engine.ts requires.
  const clearsBoth = (candidate: PowerTask[]): boolean => clears(candidate) && clears(candidate)

  let promoted = 0
  let falsePromoted = 0
  for (let trial = 0; trial < trials; trial++) {
    if (clearsBoth(better)) promoted++
    if (clearsBoth(tasks)) falsePromoted++
  }
  const measured = rerun ? rerun.size : tasks.length
  return {
    promoted: promoted / trials,
    falsePromoted: falsePromoted / trials,
    // Race and confirmation each measure both trees; carried tasks cost nothing.
    costPerGeneration: 4 * measured * repeats,
  }
}

/** Candidate gains to search when looking for the gate's floor. */
const LADDER = [0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4]

/**
 * The smallest suite-wide gain the gate promotes at least `target` of the time,
 * or undefined when nothing on the ladder reaches it.
 */
export function detectableEffect(
  options: Omit<PowerOptions, 'delta'> & { target?: number },
): { delta: number; promoted: number } | undefined {
  const { target = 0.8, ...rest } = options
  for (const delta of LADDER) {
    const result = measurePower({ ...rest, delta })
    if (result.promoted >= target) return { delta, promoted: result.promoted }
  }
  return undefined
}

/**
 * How flaky a task is assumed to be when the benchmark has only seen it once.
 *
 * One observation cannot measure flakiness: a task that passed might pass every
 * time or four times in five, and those two suites give very different answers
 * about what the gate can see. Laplace smoothing would read a single pass as 0.67,
 * which simulates a suite far noisier than elia's actually is and makes the gate
 * look blind for the wrong reason. So the assumption is named here instead of
 * buried in an estimator, and stated in the report that uses it.
 *
 * Run the benchmark with ELIA_BENCH_REPEATS>1 and `taskRates` replaces this with
 * measurement.
 */
export const ASSUMED_RELIABILITY = { passed: 0.97, failed: 0.1 }

/** The parts of a benchmark record this module reads — satisfied by both `BenchRecord` and `Metrics`. */
export interface BenchLike {
  passed?: string[]
  failed?: string[]
  taskRates?: Record<string, number>
  attempts?: number
}

/** Per-task pass probabilities from a recorded benchmark: measured where possible, assumed otherwise. */
export function inferTasks(record: BenchLike, assumed = ASSUMED_RELIABILITY): PowerTask[] {
  const attempts = Math.max(1, record.attempts ?? 1)
  if (record.taskRates && attempts > 1) {
    // Measured rates, lightly smoothed so a 3-for-3 task is not called certain.
    return Object.entries(record.taskRates).map(([id, rate]) => ({ id, pi: (rate * attempts + 0.5) / (attempts + 1) }))
  }
  return [
    ...(record.passed ?? []).map((id) => ({ id, pi: assumed.passed })),
    ...(record.failed ?? []).map((id) => ({ id, pi: assumed.failed })),
  ]
}

/** True when every task's reliability is an assumption rather than a measurement. */
export function isAssumed(record: BenchLike): boolean {
  return !(record.taskRates && (record.attempts ?? 1) > 1)
}

/**
 * How the gate's reach depends on how far the sieve narrows the re-run set.
 *
 * Reported as a curve rather than one number because the answer is dominated by
 * the reach map, not by the benchmark: a diff the sieve narrows to its four
 * failing tasks is promoted on a real win almost always, and the same diff
 * measured across all 54 almost never. Nothing in the ledger records the re-run
 * count yet, so there is no single honest figure to print — only the curve, and
 * a note about which end of it a given run lands on.
 */
export function renderGatePower(tasks: PowerTask[], repeats: number, seed = 1, assumed = true): string {
  if (tasks.length === 0) return 'gate sensitivity — no benchmark recorded yet'
  const basis = assumed
    ? `assuming a passing task passes ${Math.round(ASSUMED_RELIABILITY.passed * 100)}% of the time — run with ELIA_BENCH_REPEATS>1 to measure it`
    : 'from measured per-task rates'
  const lines = [
    `gate sensitivity — ${tasks.length} task(s), ELIA_BENCH_REPEATS=${repeats}`,
    `  (${basis}; "real win" = every task's pass probability up 85 points, capped — the failures fixed, the rest a little steadier)`,
  ]

  const failing = tasks.filter((task) => task.pi < 0.5).length
  const sizes = [...new Set([Math.max(1, failing), Math.max(1, failing) * 2, Math.ceil(tasks.length / 2), tasks.length])]
    .filter((size) => size <= tasks.length)
    .sort((a, b) => a - b)

  for (const size of sizes) {
    const rerun = size >= tasks.length ? undefined : rerunSet(tasks, size)
    const win = measurePower({ tasks, repeats, delta: 0.85, seed, trials: 400, rerun })
    const label = rerun ? `${size} task(s) re-run` : `all ${tasks.length} re-run (ELIA_SIEVE=off)`
    lines.push(
      `  ${label.padEnd(32)} real win promoted ${(100 * win.promoted).toFixed(0).padStart(3)}%   ` +
        `noise promoted ${(100 * win.falsePromoted).toFixed(0).padStart(2)}%   ` +
        `${win.costPerGeneration} task-runs/gen`,
    )
  }

  lines.push('  the sieve, not the benchmark, decides which end of this you get — nothing records the re-run count yet')
  if (repeats > 3) {
    lines.push(
      `  note: REAL_CHANGE is ${REAL_CHANGE} of attempts, so repeats above 3 shrink each task's movement below the threshold and cost sensitivity rather than buying it`,
    )
  }
  return lines.join('\n')
}
