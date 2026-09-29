import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithConcurrencyLimit } from '../agentLoop.ts'
import { estimateCostUsd, formatCostUsd, formatElapsed, formatTokenCount } from '../usage.ts'
import { BENCH_TASKS, TOTAL_WEIGHT, type BenchTask } from './suite.ts'
import type { Metrics } from './ledger.ts'
import { bold, dim, green, red } from '../ui/theme.ts'
import { table } from '../ui/layout.ts'
import { MAX_SHELL_OUTPUT_LENGTH, readBoundedOutput, terminateProcessGroup } from '../shell.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { writeSubStep } from '../ui/report.ts'
import { ELIA_ROOT } from '../statePaths.ts'
import { REACH_OUT_ENV, absorbReachFile } from './reach.ts'
import { MODEL_SILENCE_MS, TRACE_OUT_ENV, readTrace, renderTrace, waitingOnModel } from './trace.ts'

/**
 * Runs the benchmark suite against a given copy of elia's source and scores it.
 *
 * `sourceRoot` is the whole point: pass elia's real root to measure the baseline,
 * or a sandbox containing a mutation to measure a candidate. The tasks, the
 * checks, and the scoring are identical either way, which is what makes the two
 * numbers comparable.
 */

/** A single task gets a generous ceiling; a candidate that hangs should score badly, not stall the run forever. */
const TASK_TIMEOUT_MS = 300_000

/**
 * A task's own ceiling, scaled to the budget it asked for.
 *
 * A wall-clock limit tuned for 30 steps in a fixture repo would score an
 * 80-step task in a real repository as a hang, which measures the timeout
 * instead of the agent. Tasks that say nothing keep the original ceiling.
 */
function timeoutFor(task: Pick<BenchTask, 'maxSteps'>): number {
  if (!task.maxSteps) return TASK_TIMEOUT_MS
  return Math.max(TASK_TIMEOUT_MS, Math.round((TASK_TIMEOUT_MS / 30) * task.maxSteps))
}
/**
 * Parallel tasks are faster, but provider rate limits turn a high number into
 * retries and noise. `ELIA_BENCH_CONCURRENCY` overrides it — a provider with a
 * per-minute input-token cap (mercury's free tier) needs 1 for the history
 * tasks, which send hundreds of thousands of tokens each.
 */
export function benchConcurrency(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.ELIA_BENCH_CONCURRENCY)
  return Number.isInteger(value) && value >= 1 ? value : 2
}

export interface TaskOutcome {
  taskId: string
  weight: number
  passed: boolean
  detail: string
  steps: number
  elapsedMs: number
  totalTokens: number
  /** Set when the agent process itself failed, as opposed to producing a wrong answer. */
  error?: string
  /** Model the child process actually used, reported back for cost accounting. */
  model?: string
  /** Kept on failure so the run can be inspected afterwards. */
  keptDir?: string
  /**
   * What the agent did on a failing attempt, one line per step (trace.ts).
   * Unlike `keptDir` it survives the baseline cache, so the proposer still has
   * it when the failure it is studying was not re-run.
   */
  trace?: string
  /** Execution stop classification returned by the child loop. */
  stopReason?: string
  /**
   * The task could not be measured at all — the provider refused (out of credit,
   * overloaded) or the task's environment could not start — and retrying did not
   * help. Neither a pass nor a fail: it says nothing about the agent.
   */
  unmeasured?: boolean
  /** Speculative read effectiveness for this task. */
  cacheHits?: number
  cacheMisses?: number
  /** Attempts this outcome aggregates, and how many passed — present when repeats > 1. */
  attempts?: number
  passes?: number
}

export interface Scorecard {
  sourceRoot: string
  model: string
  outcomes: TaskOutcome[]
  /** Weighted fraction of the *measured* tasks passed, 0..1. */
  passRate: number
  /** Tasks that produced no verdict (see `TaskOutcome.unmeasured`). */
  unmeasured: string[]
  totalTokens: number
  /** Sum of the tasks' own durations. */
  totalElapsedMs: number
  /** Real time the whole suite took, which is lower when tasks ran in parallel. */
  wallClockMs: number
  cacheHits: number
  cacheMisses: number
  cacheHitRate: number
}

export interface MeasureOptions {
  sourceRoot: string
  tasks?: BenchTask[]
  concurrency?: number
  /** Runs per task; the task's score is the fraction that passed. Default ELIA_BENCH_REPEATS, else 1. */
  repeats?: number
  onTaskDone?: (outcome: TaskOutcome) => void
  /** Runs one attempt of one task, retries included. Tests stand in for the real agent here. */
  runTask?: (task: BenchTask, sourceRoot: string) => Promise<TaskOutcome>
  /**
   * Who attempts the tasks: elia (the default), or the same model with no
   * harness at all — the control arm of `elia bench --lift` (bareLoop.ts).
   */
  arm?: BenchArm
}

export type BenchArm = 'elia' | 'bare'

/**
 * How many times each task runs. One run of a model-driven task is a coin with
 * an unknown bias: a flaky task that happened to fail on the candidate reads as
 * a regression, and one that happened to pass reads as a fix — which is how a
 * single-run benchmark sitting at 93% hands evolve its verdicts by luck. Repeats
 * turn each task into a pass rate.
 *
 * The default is 3, not 1, because `power.ts` can price the difference without
 * spending anything. On the suite as it stands, with the sieve on (the shipped
 * configuration, re-running ~4 tasks):
 *
 *   repeats  true gain .8   .4     .2     promotes a no-op   cost
 *   1        99.0%          46.5%  25.4%  8.6%               16
 *   3        100%           73.2%  28.9%  3.0%               48
 *   5        100%           72.7%  21.0%  0.4%               80
 *
 * Three dominates one on every axis that matters and costs 48 task-runs a
 * generation. The number that decides it is the last column but one: at one
 * run per task, about one candidate in twelve that is *identical to the
 * baseline* clears both the race and the confirmation pair. A loop built on the
 * premise that promoted changes compound cannot promote noise at that rate —
 * it is not improving slowly, it is drifting, and the drift compounds too.
 *
 * Five is not better than three: `REAL_CHANGE` is a fixed 0.5 of a task's pass
 * rate, and more attempts pull a genuine-but-partial gain below that threshold,
 * so small wins get *harder* to see. Raising repeats past three needs
 * REAL_CHANGE to scale with it, which is a separate change with its own test.
 *
 * `ELIA_BENCH_REPEATS=1` restores the cheap single run for a throwaway sweep.
 */
export const DEFAULT_BENCH_REPEATS = 3

export function benchRepeats(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.ELIA_BENCH_REPEATS)
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 10) : DEFAULT_BENCH_REPEATS
}

/** Fold several attempts at one task into one outcome whose `passes/attempts` is its score. */
export function aggregateAttempts(attempts: TaskOutcome[]): TaskOutcome {
  const first = attempts[0]!
  if (attempts.length === 1) return first
  const measured = attempts.filter((attempt) => !attempt.unmeasured)
  const passes = measured.filter((attempt) => attempt.passed).length
  // Any attempt the harness could not measure makes the task unmeasured: a
  // rate over fewer attempts than the other side ran is not comparable.
  const unmeasured = measured.length < attempts.length
  const failing = [...attempts].reverse().find((attempt) => !attempt.passed)
  const sum = (pick: (attempt: TaskOutcome) => number) => attempts.reduce((total, attempt) => total + pick(attempt), 0)
  const aggregated: TaskOutcome = {
    ...first,
    passed: !unmeasured && passes * 2 >= attempts.length,
    detail: `${passes}/${attempts.length} attempts passed${failing ? ` — last failure: ${failing.error ?? failing.detail}` : ''}`,
    steps: Math.round(sum((attempt) => attempt.steps) / attempts.length),
    elapsedMs: sum((attempt) => attempt.elapsedMs),
    totalTokens: sum((attempt) => attempt.totalTokens),
    attempts: attempts.length,
    passes,
  }
  delete aggregated.error
  delete aggregated.keptDir
  delete aggregated.trace
  delete aggregated.unmeasured
  if (failing?.error) aggregated.error = failing.error
  if (failing?.keptDir) aggregated.keptDir = failing.keptDir
  if (failing?.trace) aggregated.trace = failing.trace
  if (unmeasured) aggregated.unmeasured = true
  return aggregated
}

/** A task's score: its pass fraction when repeated, else 1 or 0. */
function taskScore(outcome: TaskOutcome): number {
  return outcome.attempts ? (outcome.passes ?? 0) / outcome.attempts : outcome.passed ? 1 : 0
}

/**
 * Ends a task's agent process if this one is stopped first.
 *
 * A signal stops `elia bench` or `elia evolve` through `process.exit`, which
 * runs no pending `finally` — so the task processes they had spawned carried
 * on running their agent loops, spending the provider's quota, with nobody
 * left to read the result. Stopping a sweep left two of them going, still
 * competing with whatever measured next. Returns the unregister, for when the
 * task ends on its own.
 */
export function killOnShutdown(proc: Bun.Subprocess): () => void {
  return registerShutdownCleanup(() => terminateProcessGroup(proc))
}

export async function measureFitness(options: MeasureOptions): Promise<Scorecard> {
  const tasks = options.tasks ?? BENCH_TASKS
  const startedAt = Date.now()

  const repeats = options.repeats ?? benchRepeats()
  const arm = options.arm ?? 'elia'
  const runTask = options.runTask ?? ((task: BenchTask, root: string) => runTaskWithRetry(task, root, arm))
  // Once the provider says the account is out of credit, every task after it
  // would set up its repository, fail the same way, and do it `repeats` times.
  // Those tasks are left unmeasured without running; the baseline cache keeps
  // what did run, so the next sweep starts from here.
  let exhausted: string | undefined
  const outcomes = await runWithConcurrencyLimit(
    tasks,
    options.concurrency ?? benchConcurrency(),
    async (task) => {
      const attempts: TaskOutcome[] = []
      for (let attempt = 0; attempt < repeats; attempt++) {
        if (exhausted !== undefined) {
          attempts.push(notRun(task, exhausted))
          break
        }
        const result = await runTask(task, options.sourceRoot)
        attempts.push(result)
        if (outOfCredit(result)) exhausted ??= result.error
      }
      const outcome = aggregateAttempts(attempts)
      options.onTaskDone?.(outcome)
      return outcome
    },
  )

  return cardFromOutcomes(options.sourceRoot, tasks, outcomes, Date.now() - startedAt)
}

/**
 * Score a set of outcomes against the task set they belong to.
 *
 * Split out of `measureFitness` so that a card can also be assembled from
 * outcomes that were not all produced by one pass — `sieve.ts` measures only the
 * tasks a candidate's diff can reach and carries the rest over from the
 * baseline, and the result has to be scored by exactly the same arithmetic or
 * the two cards would not be comparable.
 */
export function cardFromOutcomes(sourceRoot: string, tasks: BenchTask[], outcomes: TaskOutcome[], wallClockMs: number): Scorecard {
  // Every task reports the model it ran on; they agree, so the first one that got
  // far enough to report is the card's model.
  const model = outcomes.find((outcome) => outcome.model)?.model ?? ''

  const weightOf = (id: string) => tasks.find((task) => task.id === id)?.weight ?? 1
  const earned = outcomes.filter((outcome) => !outcome.unmeasured).reduce((sum, outcome) => sum + weightOf(outcome.taskId) * taskScore(outcome), 0)
  // An unmeasured task leaves the denominator. Counting it as a failure is how a
  // provider running out of credit reads as "elia got worse" — and a comparison
  // between two cards with different unmeasured sets is refused outright in
  // compareScorecards, so this never lets a gap flatter a candidate.
  const unmeasured = outcomes.filter((outcome) => outcome.unmeasured).map((outcome) => outcome.taskId)
  const available = tasks.length === 0
    ? TOTAL_WEIGHT
    : tasks.filter((task) => !unmeasured.includes(task.id)).reduce((sum, task) => sum + task.weight, 0)

  const cacheHits = outcomes.reduce((sum, outcome) => sum + (outcome.cacheHits ?? 0), 0)
  const cacheMisses = outcomes.reduce((sum, outcome) => sum + (outcome.cacheMisses ?? 0), 0)
  const cacheAttempts = cacheHits + cacheMisses

  return {
    sourceRoot,
    model,
    outcomes,
    passRate: available === 0 ? 0 : earned / available,
    unmeasured,
    totalTokens: outcomes.reduce((sum, outcome) => sum + outcome.totalTokens, 0),
    totalElapsedMs: outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0),
    wallClockMs,
    cacheHits,
    cacheMisses,
    cacheHitRate: cacheAttempts === 0 ? 0 : cacheHits / cacheAttempts,
  }
}

/**
 * Errors that mean the provider fell over, not that the agent got the task wrong.
 *
 * This distinction is load-bearing. A transient 500 scored as a task failure would
 * make the benchmark reject a genuinely better candidate — or promote a worse one —
 * on the strength of a network blip, and the ledger would then carry that false
 * result into every future generation. So an infrastructure failure is retried; a
 * wrong answer never is.
 */
const INFRASTRUCTURE_ERROR = /server had an error|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|fetch failed|502|503|529|missing finish_reason|connection error/i

/**
 * Errors no retry will fix inside one benchmark run: the account is out of
 * credit, or the task's own checkout cannot start. Retrying these only burns
 * time, so they go straight to unmeasured.
 */
const PERMANENT_INFRASTRUCTURE_ERROR = /\b402\b|requires more credits|free tier limit|insufficient.?(credit|quota|funds)|quota exceeded|preload not found|stale task/i

/** The account itself is out of credit — unlike a rate limit, waiting inside this run will not bring it back. */
const OUT_OF_CREDIT = /\b402\b|requires more credits|free.?tier.?(?:limit|quota)|insufficient.?(?:credit|quota|funds)/i

export function outOfCredit(outcome: Pick<TaskOutcome, 'error' | 'unmeasured'>): boolean {
  return Boolean(outcome.unmeasured && outcome.error && OUT_OF_CREDIT.test(outcome.error))
}

/**
 * An unmeasured task that a later try, minutes from now, might still measure:
 * the provider dropped the connection or went quiet. Not one whose account is
 * out of credit or whose task cannot start — no wait inside this run fixes those.
 */
export function mightMeasureLater(outcome: Pick<TaskOutcome, 'error' | 'unmeasured'>): boolean {
  if (!outcome.unmeasured) return false
  const error = outcome.error ?? ''
  return !outOfCredit(outcome) && !PERMANENT_INFRASTRUCTURE_ERROR.test(error) && !/out of credit/i.test(error)
}

function notRun(task: BenchTask, why: string): TaskOutcome {
  return {
    taskId: task.id,
    weight: task.weight,
    passed: false,
    detail: 'not run',
    steps: 0,
    elapsedMs: 0,
    totalTokens: 0,
    error: `not run: the provider is out of credit (${why.slice(0, 200)})`,
    unmeasured: true,
  }
}

/**
 * The model stopped sending — reported by the loop's own idle check, or found by
 * the harness in the trace of a run it had to stop (trace.ts `waitingOnModel`).
 * Both messages say "timed out" too, which is why this is asked first.
 */
const PROVIDER_STALLED = /response stalled|provider stalled/i

export function isInfrastructureFailure(outcome: Pick<TaskOutcome, 'error' | 'steps'>): boolean {
  if (!outcome.error) return false
  if (PROVIDER_STALLED.test(outcome.error)) return true
  // A hang is the candidate's own fault and must be allowed to score as a failure,
  // even though it also reports zero steps.
  if (/timed out/i.test(outcome.error)) return false
  // Zero steps means the very first model call never completed, which is not
  // something the agent's behaviour can cause.
  return outcome.steps === 0 || INFRASTRUCTURE_ERROR.test(outcome.error)
}

const RATE_LIMITED = /\b429\b|rate.?limit/i

/**
 * How long to wait before retry `attempt` (1-based), or undefined to stop.
 *
 * A rate limit is a quota window, not a blip: a 2-second pause just spends the
 * retry inside the same window, which is how a full benchmark came back with
 * real tasks unmeasured. So a rate limit gets more attempts spread across
 * minutes; anything else keeps the short pause.
 */
export function retryDelayMs(outcome: Pick<TaskOutcome, 'error' | 'steps'>, attempt: number): number | undefined {
  if (!isInfrastructureFailure(outcome) || PERMANENT_INFRASTRUCTURE_ERROR.test(outcome.error ?? '')) return undefined
  // Five waits, 30s doubling to a 4-minute cap (about 11 minutes in all): three
  // (3.5 minutes) still left mercury's quota window closed while a second task
  // shared it, and one unmeasured task voids a whole evolve comparison.
  if (RATE_LIMITED.test(outcome.error ?? '')) return attempt <= 5 ? Math.min(30_000 * 2 ** (attempt - 1), 240_000) : undefined
  // A stalling provider stalls for minutes (the one seen went quiet for about
  // thirteen), and each stalled attempt has already spent its whole timeout
  // finding out — so three spaced waits, not five, then unmeasured.
  if (PROVIDER_STALLED.test(outcome.error ?? '')) return attempt <= 3 ? 30_000 * 2 ** (attempt - 1) : undefined
  return attempt <= 1 ? 2000 * attempt : undefined
}

/**
 * The environment a benchmark task runs in, pinned to the selected provider.
 *
 * With `ELIA_ROUTING_MODE=auto` a task whose model was out of quota quietly
 * finished on whichever fallback answered, so one scorecard mixed models under
 * a single model's name — and a candidate could win or lose on which fallback
 * it happened to get. A provider that cannot answer is an unmeasured task,
 * never a different one.
 */
export function benchTaskEnv(env: Record<string, string | undefined>, reachOut: string, traceOut?: string): Record<string, string | undefined> {
  // A task's temporary repository is not a project: the world model runs there as
  // shipped, but must not leave files behind that a task's own checks might see.
  return { ...env, [REACH_OUT_ENV]: reachOut, ...(traceOut ? { [TRACE_OUT_ENV]: traceOut } : {}), ELIA_ROUTING_MODE: 'selected', ELIA_WORLD_PERSIST: 'off' }
}

/** A task given more than the default step budget: the history tasks, each sending hundreds of thousands of tokens. */
export function isHeavy(task: Pick<BenchTask, 'maxSteps'>): boolean {
  return timeoutFor(task) > TASK_TIMEOUT_MS
}

/** The provider refused or went quiet: retried, never scored, and a sign that it is being asked too much at once. */
export function providerPushedBack(outcome: Pick<TaskOutcome, 'error'>): boolean {
  return RATE_LIMITED.test(outcome.error ?? '') || PROVIDER_STALLED.test(outcome.error ?? '')
}

/**
 * How many heavy tasks may run at once, narrowed on evidence.
 *
 * The evolve comparison refuses a scorecard with any task unmeasured, and the
 * tasks that go unmeasured are the heavy ones: generations 15 and 16 each lost
 * the same two history tasks, which are also two of the four tasks with any
 * headroom, so the one change the benchmark could have judged was voided
 * twice. Two history tasks at once share one rate-capped provider (mercury's
 * free tier caps input tokens per minute), and both slow down until one
 * stalls. Running them one at a time always would halve a sweep's speed on a
 * provider that never objects, so the lane starts as wide as the benchmark
 * and narrows to one the first time the provider pushes back on a heavy task.
 * The retry of that task then runs alone. It stays narrow for the rest of the
 * process: a provider that throttled once will again.
 */
export class HeavyLane {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private width: number) {}

  get capacity(): number {
    return this.width
  }

  narrow(): boolean {
    if (this.width <= 1) return false
    this.width = 1
    return true
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    while (this.active >= this.width) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    try {
      return await work()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

/** One lane per process, shared by the sweep, the race, and the regression retest. */
export const heavyLane = new HeavyLane(benchConcurrency())

/** Heavy attempts go through the lane; a push-back on one narrows it before the retry. */
export async function attemptInLane<T extends Pick<TaskOutcome, 'error'>>(
  task: Pick<BenchTask, 'id' | 'maxSteps'>,
  attempt: () => Promise<T>,
  lane: HeavyLane = heavyLane,
  onNarrow: (task: Pick<BenchTask, 'id'>) => void = (narrowed) =>
    writeSubStep(`the provider pushed back on ${narrowed.id} — heavy tasks run one at a time from here`),
): Promise<T> {
  if (!isHeavy(task)) return attempt()
  const outcome = await lane.run(attempt)
  if (providerPushedBack(outcome) && lane.narrow()) onNarrow(task)
  return outcome
}

async function runTaskWithRetry(task: BenchTask, sourceRoot: string, arm: BenchArm = 'elia'): Promise<TaskOutcome> {
  let last = await attemptInLane(task, () => runOneTask(task, sourceRoot, arm))

  for (let attempt = 1; ; attempt++) {
    const delay = retryDelayMs(last, attempt)
    if (delay === undefined) break
    if (last.keptDir) rmSync(last.keptDir, { recursive: true, force: true })
    await new Promise((resolve) => setTimeout(resolve, delay))
    last = await attemptInLane(task, () => runOneTask(task, sourceRoot, arm))
  }

  return markUnmeasured(last)
}

/** An outcome that is still an infrastructure failure after retrying says nothing about the agent. */
export function markUnmeasured(outcome: TaskOutcome): TaskOutcome {
  if (outcome.passed || !isInfrastructureFailure(outcome)) return outcome
  return { ...outcome, unmeasured: true }
}

async function runOneTask(task: BenchTask, sourceRoot: string, arm: BenchArm): Promise<TaskOutcome> {
  const dir = mkdtempSync(join(tmpdir(), `elia-bench-${task.id}-`))
  const base: TaskOutcome = {
    taskId: task.id,
    weight: task.weight,
    passed: false,
    detail: '',
    steps: 0,
    elapsedMs: 0,
    totalTokens: 0,
  }

  try {
    await task.setup(dir)

    const entry = join(sourceRoot, 'src', 'evolve', arm === 'bare' ? 'bareTask.ts' : 'benchTask.ts')

    // Ride along on a run that is happening anyway and record which of the
    // tree's modules this task loads, so the next candidate can skip the tasks
    // its diff provably cannot reach (see reach.ts). The recorder comes from the
    // live root rather than `sourceRoot`: a candidate may rewrite elia, but not
    // the thing that watches which of its files ran. The output goes beside the
    // task's repository, never inside it, so no check ever sees it.
    const reachOut = `${dir}.reach`
    // The agent's steps, for the proposer if this attempt fails (trace.ts).
    // Beside the repository for the same reason.
    const traceOut = `${dir}.trace`
    const spawnedAt = Date.now()
    // The bare arm loads none of the agent, so what it loads says nothing about
    // which of elia's files a task can reach — and recording it would shrink the
    // task's footprint, the one direction reach.ts cannot afford.
    const recordReach = arm === 'elia'
    const proc = Bun.spawn(['bun', 'run', ...(recordReach ? ['--preload', join(ELIA_ROOT, 'src', 'evolve', 'reachRecorder.ts')] : []), entry, task.id], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: benchTaskEnv(process.env, reachOut, traceOut),
    })
    const releaseOnShutdown = killOnShutdown(proc)

    let timedOut = false
    const taskTimeoutMs = timeoutFor(task)
    const timeout = setTimeout(() => {
      timedOut = true
      terminateProcessGroup(proc)
    }, taskTimeoutMs)

    let stdout = ''
    let stderr = ''
    let completed = false
    try {
      ;[stdout, stderr] = await Promise.all([
        readBoundedOutput(proc.stdout, MAX_SHELL_OUTPUT_LENGTH),
        readBoundedOutput(proc.stderr, MAX_SHELL_OUTPUT_LENGTH),
      ])
      await proc.exited
      completed = true
    } finally {
      clearTimeout(timeout)
      releaseOnShutdown()
      if (!completed) terminateProcessGroup(proc)
    }

    const run = parseRunOutput(stdout)

    // Only a run that actually reached the agent loop is evidence about what the
    // task loads. A child that died on a missing key, or was killed at the
    // timeout, or reported an error back, loaded a fraction of the tree — and
    // folding that in would shrink the task's recorded footprint. A shrunken
    // footprint is what makes a task look unreachable when it is not, and
    // under-recording is the one direction
    // `reach.ts` cannot be safe in, so it is refused at the source.
    if (recordReach && run && !run.error && !timedOut) absorbReachFile(task.id, reachOut, sourceRoot)
    rmSync(reachOut, { force: true })
    const events = readTrace(traceOut)
    rmSync(traceOut, { force: true })
    const rendered = renderTrace(events)
    const trace = rendered ? { trace: rendered } : {}

    if (timedOut) {
      // Stopped while the model had been silent for a minute or more: the
      // provider's stall, retried and never scored (trace.ts).
      const error = waitingOnModel(events, spawnedAt, Date.now())
        ? `provider stalled: the model sent nothing for ${Math.round(MODEL_SILENCE_MS / 1000)}s or more before the task was stopped at ${taskTimeoutMs}ms`
        : `timed out after ${taskTimeoutMs}ms`
      return { ...base, error, detail: 'agent did not finish', keptDir: dir, ...trace }
    }
    if (!run) {
      return {
        ...base,
        error: `no result from agent process: ${(stderr || stdout).slice(-400).trim() || 'no output'}`,
        detail: 'agent process produced no parsable result',
        keptDir: dir,
        ...trace,
      }
    }

    // The agent finished; now the check decides, independently of what the agent
    // claims it did.
    const check = await task.check(dir)
    const outcome: TaskOutcome = {
      ...base,
      passed: check.passed,
      detail: check.detail,
      steps: run.steps,
      elapsedMs: run.elapsedMs,
      totalTokens: run.totalTokens,
      model: run.model,
      ...(run.error ? { error: run.error } : {}),
      ...(run.stopReason ? { stopReason: run.stopReason } : {}),
      ...(run.cacheStats ? { cacheHits: run.cacheStats.hits, cacheMisses: run.cacheStats.misses } : {}),
    }

    // A passing task's temp dir is disposable; a failing one is evidence.
    if (check.passed) rmSync(dir, { recursive: true, force: true })
    else Object.assign(outcome, { keptDir: dir }, trace)

    return outcome
  } catch (err) {
    rmSync(`${dir}.trace`, { force: true })
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      detail: 'harness error',
      keptDir: dir,
    }
  }
}

interface RunOutput {
  steps: number
  elapsedMs: number
  totalTokens: number
  model: string
  stopReason?: string
  cacheStats?: { speculated: number; hits: number; misses: number }
  error?: string
}

/** Reads the JSON result line, tolerating any stray output before it. */
function parseRunOutput(stdout: string): RunOutput | undefined {
  const lines = stdout.trim().split('\n')
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as Partial<RunOutput> & { taskId?: string }
      if (typeof parsed.steps === 'number' && typeof parsed.elapsedMs === 'number') {
        return {
          steps: parsed.steps,
          elapsedMs: parsed.elapsedMs,
          totalTokens: parsed.totalTokens ?? 0,
          model: parsed.model ?? '',
          ...(parsed.stopReason ? { stopReason: parsed.stopReason } : {}),
          ...(parsed.cacheStats ? { cacheStats: parsed.cacheStats } : {}),
          ...(parsed.error ? { error: parsed.error } : {}),
        }
      }
    } catch {
      // Not the result line; keep scanning backwards.
    }
  }
  return undefined
}

export function toMetrics(card: Scorecard): Metrics {
  const costUsd = card.model ? estimateCostUsd(card.model, {
    inputTokens: card.totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }) : undefined

  return {
    passRate: card.passRate,
    passed: card.outcomes.filter((outcome) => outcome.passed).map((outcome) => outcome.taskId),
    failed: card.outcomes.filter((outcome) => !outcome.passed && !outcome.unmeasured).map((outcome) => outcome.taskId),
    ...(card.unmeasured.length > 0 ? { unmeasured: card.unmeasured } : {}),
    steps: Object.fromEntries(card.outcomes.map((outcome) => [outcome.taskId, outcome.steps])),
    ...(card.outcomes.some((outcome) => outcome.attempts)
      ? { taskRates: Object.fromEntries(card.outcomes.filter((outcome) => !outcome.unmeasured).map((outcome) => [outcome.taskId, taskScore(outcome)])) }
      : {}),
    totalTokens: card.totalTokens,
    totalElapsedMs: card.totalElapsedMs,
    wallClockMs: card.wallClockMs,
    cacheHits: card.cacheHits,
    cacheMisses: card.cacheMisses,
    cacheHitRate: card.cacheHitRate,
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

/** The smallest per-task pass-rate movement that counts as real (half the attempts, or a full flip on a single run). */
export const REAL_CHANGE = 0.5

/** A candidate must be at least this much cheaper or faster to win on a tied pass rate. */
const EFFICIENCY_MARGIN = 0.05

export interface Comparison {
  better: boolean
  reason: string
}

/**
 * Decides whether a candidate replaces the current elia.
 *
 * Three properties matter more than the arithmetic. First, correctness dominates:
 * no amount of speed buys a lower pass rate. Second, a task that used to pass and
 * now fails is disqualifying even when the total ties — otherwise the search
 * happily trades one capability for another and calls it progress. Third, ties
 * need a margin: benchmark noise will otherwise promote a change that did nothing,
 * and the ledger fills with false wins that future generations then "build on".
 */
export function compareScorecards(baseline: Metrics, candidate: Metrics): Comparison {
  // Fail closed on an incomplete measurement. A task one side could not run is a
  // task the two numbers do not agree on, so neither the pass rate nor the
  // regression list below would mean anything.
  const unmeasured = [...new Set([...(baseline.unmeasured ?? []), ...(candidate.unmeasured ?? [])])]
  if (unmeasured.length > 0) {
    return { better: false, reason: `could not measure ${unmeasured.join(', ')} — refusing to compare an incomplete benchmark` }
  }

  // With repeated runs, compare each task's pass rate and ignore movements
  // smaller than REAL_CHANGE — one attempt in three flipping is the noise the
  // repeats exist to absorb. Single-run records compare as 1/0 rates, where
  // every flip is a full point and so still counts, exactly as before.
  const rates = (metrics: Metrics): Record<string, number> =>
    metrics.taskRates ?? Object.fromEntries([...metrics.failed.map((id) => [id, 0] as const), ...metrics.passed.map((id) => [id, 1] as const)])
  const before = rates(baseline)
  const after = rates(candidate)
  const regressions = Object.keys(before).filter((id) => (before[id] ?? 0) - (after[id] ?? 0) >= REAL_CHANGE)
  if (regressions.length > 0) {
    return { better: false, reason: `regressed on ${regressions.join(', ')} — a task that passed before now fails${candidate.taskRates ? ' (by at least half its attempts)' : ''}` }
  }

  const gained = Object.keys(after).filter((id) => (after[id] ?? 0) - (before[id] ?? 0) >= REAL_CHANGE)
  if (candidate.passRate > baseline.passRate && gained.length > 0) {
    return {
      better: true,
      reason: `pass rate ${pct(baseline.passRate)} → ${pct(candidate.passRate)} (now passes ${gained.join(', ')})`,
    }
  }

  if (candidate.passRate < baseline.passRate) {
    return { better: false, reason: `pass rate fell ${pct(baseline.passRate)} → ${pct(candidate.passRate)}` }
  }

  // Tied on correctness — allow a clear efficiency win, and nothing less.
  //
  // A pass rate that rose without any task moving past noise is a tie too.
  // This used to be a rejection of its own, before efficiency was looked at,
  // so a candidate that happened to score a hair *better* was held to a
  // stricter bar than one that scored the same: generation 1 of the first run
  // on this machine ran 8% fewer tokens and 15% less agent time, and was
  // turned away because one flaky task went 2/3 → 3/3 while another went
  // 2/3 → 1/3. Whether such a saving is real is the confirmation pair's to
  // decide, not luck in the pass rate's last digit.
  const noiseRise = candidate.passRate > baseline.passRate + 1e-9 ? ', no task improved by more than run-to-run noise' : ''
  const tokenDelta = relativeChange(baseline.totalTokens, candidate.totalTokens)
  // Wall clock is the user-visible metric for parallel autonomous work. Older
  // ledger records do not have it, so they safely fall back to summed task time.
  const baselineTime = baseline.wallClockMs ?? baseline.totalElapsedMs
  const candidateTime = candidate.wallClockMs ?? candidate.totalElapsedMs
  const timeDelta = relativeChange(baselineTime, candidateTime)

  const sameRate = noiseRise ? `pass rate ${pct(baseline.passRate)} → ${pct(candidate.passRate)}${noiseRise}` : 'same pass rate'
  if (tokenDelta <= -EFFICIENCY_MARGIN && timeDelta < EFFICIENCY_MARGIN) {
    return { better: true, reason: `${sameRate}, ${pct(-tokenDelta)} fewer tokens` }
  }
  if (timeDelta <= -EFFICIENCY_MARGIN && tokenDelta < EFFICIENCY_MARGIN) {
    return { better: true, reason: `${sameRate}, ${pct(-timeDelta)} faster` }
  }

  return {
    better: false,
    reason: noiseRise
      ? `no measurable improvement (${sameRate}; tokens ${signed(tokenDelta)}, time ${signed(timeDelta)})`
      : `no measurable improvement (pass rate unchanged at ${pct(candidate.passRate)}, tokens ${signed(tokenDelta)}, time ${signed(timeDelta)})`,
  }
}

function relativeChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : 1
  return (to - from) / from
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`
}

export function renderScorecard(card: Scorecard, title = 'Scorecard'): string {
  const unmeasuredNote = card.unmeasured.length > 0 ? ` of the measured tasks, ${card.unmeasured.length} unmeasured` : ''
  const lines: string[] = ['', `${bold(title)} ${dim(`— ${pct(card.passRate)} weighted pass rate${unmeasuredNote}`)}`, '']

  const rows = table(
    [
      { header: '' },
      { header: 'task' },
      { header: 'steps', align: 'right' },
      { header: 'time', align: 'right' },
      { header: 'tokens', align: 'right' },
    ],
    card.outcomes.map((outcome) => [
      outcome.passed ? green('✓') : outcome.unmeasured ? dim('?') : red('✗'),
      outcome.taskId,
      String(outcome.steps),
      formatElapsed(outcome.elapsedMs),
      formatTokenCount(outcome.totalTokens),
    ]),
  )
  const [header, separator, ...dataRows] = rows
  lines.push(`  ${header}`, `  ${separator}`)
  card.outcomes.forEach((outcome, i) => {
    lines.push(`  ${dataRows[i]}`)
    if (outcome.unmeasured) lines.push(`      ${dim(`unmeasured: ${outcome.error ?? 'no verdict'}`)}`)
    else if (outcome.error) lines.push(`      ${red(`error: ${outcome.error}`)}`)
    else if (outcome.detail) lines.push(`      ${dim(outcome.detail)}`)
    if (outcome.keptDir) lines.push(`      ${dim(`kept for inspection: ${outcome.keptDir}`)}`)
  })

  const cost = card.model
    ? formatCostUsd(
        estimateCostUsd(card.model, {
          inputTokens: card.totalTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      )
    : 'cost unknown'

  lines.push('')
  const cacheNote = card.cacheHits + card.cacheMisses > 0 ? ` · reads prefetched ${Math.round(card.cacheHitRate * 100)}% (${card.cacheHits}/${card.cacheHits + card.cacheMisses})` : ''
  lines.push(
    `  ${dim(`total: ${formatTokenCount(card.totalTokens)} tokens · ${formatElapsed(card.totalElapsedMs)} of agent time · ${formatElapsed(card.wallClockMs)} wall clock${cacheNote} · ~${cost}`)}`,
  )
  lines.push('')
  return lines.join('\n')
}
