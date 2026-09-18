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
 * What it found on the suite as it stands (54 tasks, ~93% pass rate, 4 failures):
 * a candidate that genuinely fixed *every* remaining failure was promoted 13% of
 * the time, and a candidate identical to the baseline was promoted 2.5% of the
 * time. The gate is not too lax. It is close to blind.
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

/** One benchmark sweep, drawn rather than run. */
export function simulateSweep(tasks: PowerTask[], repeats: number, random: () => number): Metrics {
  const passed: string[] = []
  const failed: string[] = []
  const taskRates: Record<string, number> = {}
  for (const task of tasks) {
    let hits = 0
    for (let attempt = 0; attempt < repeats; attempt++) if (random() < task.pi) hits++
    const rate = hits / repeats
    taskRates[task.id] = rate
    if (rate > 0.5) passed.push(task.id)
    else failed.push(task.id)
  }
  const passRate = tasks.length === 0 ? 0 : Object.values(taskRates).reduce((sum, r) => sum + r, 0) / tasks.length
  return {
    passRate,
    passed,
    failed,
    // Matches toMetrics: single-run records carry no rates, because passed/failed already are them.
    ...(repeats > 1 ? { taskRates } : {}),
    totalTokens: 1_000_000,
    totalElapsedMs: 1_000_000,
    wallClockMs: 1_000_000,
  }
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
  const { tasks, repeats, delta, trials = 2000, seed = 1, rule = liveRule } = options
  const random = seededRandom(seed)
  const better = improvedBy(tasks, delta)

  const clearsBoth = (candidate: PowerTask[]): boolean =>
    rule(simulateSweep(tasks, repeats, random), simulateSweep(candidate, repeats, random)) &&
    rule(simulateSweep(tasks, repeats, random), simulateSweep(candidate, repeats, random))

  let promoted = 0
  let falsePromoted = 0
  for (let trial = 0; trial < trials; trial++) {
    if (clearsBoth(better)) promoted++
    if (clearsBoth(tasks)) falsePromoted++
  }
  return {
    promoted: promoted / trials,
    falsePromoted: falsePromoted / trials,
    // Race and confirmation each measure both trees.
    costPerGeneration: 4 * tasks.length * repeats,
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

export function renderGatePower(tasks: PowerTask[], repeats: number, seed = 1, assumed = true): string {
  if (tasks.length === 0) return 'gate sensitivity — no benchmark recorded yet'
  const floor = detectableEffect({ tasks, repeats, seed, trials: 600 })
  const noise = measurePower({ tasks, repeats, delta: 0, seed, trials: 600 })
  const basis = assumed
    ? `assuming a passing task passes ${Math.round(ASSUMED_RELIABILITY.passed * 100)}% of the time — run with ELIA_BENCH_REPEATS>1 to measure it`
    : 'from measured per-task rates'
  const head =
    `gate sensitivity — ${tasks.length} task(s), ELIA_BENCH_REPEATS=${repeats}, ${4 * tasks.length * repeats} task-runs per generation\n` +
    `  (${basis})`
  const floorLine = floor
    ? `  smallest gain promoted 80% of the time: +${Math.round(floor.delta * 100)} points`
    : `  no gain up to +${Math.round(LADDER[LADDER.length - 1]! * 100)} points is promoted 80% of the time — the suite cannot carry a win`
  const noiseLine = `  a candidate no better than the baseline is promoted ${(100 * noise.falsePromoted).toFixed(1)}% of the time`
  const repeatsNote =
    repeats > 3
      ? `  note: REAL_CHANGE is ${REAL_CHANGE} of attempts, so repeats above 3 shrink each task's movement below the threshold and cost sensitivity rather than buying it`
      : undefined
  return [head, floorLine, noiseLine, repeatsNote].filter(Boolean).join('\n')
}
