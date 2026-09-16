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
function timeoutFor(task: BenchTask): number {
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
}

/**
 * How many times each task runs. One run of a model-driven task is a coin with
 * an unknown bias: a flaky task that happened to fail on the candidate reads as
 * a regression, and one that happened to pass reads as a fix — which is how a
 * single-run benchmark sitting at 93% hands evolve its verdicts by luck. Repeats
 * turn each task into a pass rate.
 */
export function benchRepeats(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.ELIA_BENCH_REPEATS)
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 10) : 1
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
  delete aggregated.unmeasured
  if (failing?.error) aggregated.error = failing.error
  if (failing?.keptDir) aggregated.keptDir = failing.keptDir
  if (unmeasured) aggregated.unmeasured = true
  return aggregated
}

/** A task's score: its pass fraction when repeated, else 1 or 0. */
function taskScore(outcome: TaskOutcome): number {
  return outcome.attempts ? (outcome.passes ?? 0) / outcome.attempts : outcome.passed ? 1 : 0
}

export async function measureFitness(options: MeasureOptions): Promise<Scorecard> {
  const tasks = options.tasks ?? BENCH_TASKS
  const startedAt = Date.now()

  const repeats = options.repeats ?? benchRepeats()
  const outcomes = await runWithConcurrencyLimit(
    tasks,
    options.concurrency ?? benchConcurrency(),
    async (task) => {
      const attempts: TaskOutcome[] = []
      for (let attempt = 0; attempt < repeats; attempt++) attempts.push(await runTaskWithRetry(task, options.sourceRoot))
      const outcome = aggregateAttempts(attempts)
      options.onTaskDone?.(outcome)
      return outcome
    },
  )

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
    sourceRoot: options.sourceRoot,
    model,
    outcomes,
    passRate: available === 0 ? 0 : earned / available,
    unmeasured,
    totalTokens: outcomes.reduce((sum, outcome) => sum + outcome.totalTokens, 0),
    totalElapsedMs: outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0),
    wallClockMs: Date.now() - startedAt,
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
const INFRASTRUCTURE_ERROR = /server had an error|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|fetch failed|502|503|529/i

/**
 * Errors no retry will fix inside one benchmark run: the account is out of
 * credit, or the task's own checkout cannot start. Retrying these only burns
 * time, so they go straight to unmeasured.
 */
const PERMANENT_INFRASTRUCTURE_ERROR = /402|requires more credits|free tier limit|insufficient.?(credit|quota|funds)|quota exceeded|preload not found|stale task/i

export function isInfrastructureFailure(outcome: Pick<TaskOutcome, 'error' | 'steps'>): boolean {
  if (!outcome.error) return false
  // A hang is the candidate's own fault and must be allowed to score as a failure,
  // even though it also reports zero steps.
  if (/timed out/i.test(outcome.error)) return false
  // Zero steps means the very first model call never completed, which is not
  // something the agent's behaviour can cause.
  return outcome.steps === 0 || INFRASTRUCTURE_ERROR.test(outcome.error)
}

const RATE_LIMITED = /429|rate.?limit/i

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
  if (RATE_LIMITED.test(outcome.error ?? '')) return attempt <= 3 ? 30_000 * 2 ** (attempt - 1) : undefined
  return attempt <= 1 ? 2000 * attempt : undefined
}

async function runTaskWithRetry(task: BenchTask, sourceRoot: string): Promise<TaskOutcome> {
  let last = await runOneTask(task, sourceRoot)

  for (let attempt = 1; ; attempt++) {
    const delay = retryDelayMs(last, attempt)
    if (delay === undefined) break
    if (last.keptDir) rmSync(last.keptDir, { recursive: true, force: true })
    await new Promise((resolve) => setTimeout(resolve, delay))
    last = await runOneTask(task, sourceRoot)
  }

  return markUnmeasured(last)
}

/** An outcome that is still an infrastructure failure after retrying says nothing about the agent. */
export function markUnmeasured(outcome: TaskOutcome): TaskOutcome {
  if (outcome.passed || !isInfrastructureFailure(outcome)) return outcome
  return { ...outcome, unmeasured: true }
}

async function runOneTask(task: BenchTask, sourceRoot: string): Promise<TaskOutcome> {
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

    const entry = join(sourceRoot, 'src', 'evolve', 'benchTask.ts')
    const proc = Bun.spawn(['bun', 'run', entry, task.id], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })

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
      if (!completed) terminateProcessGroup(proc)
    }

    const run = parseRunOutput(stdout)
    if (timedOut) {
      return { ...base, error: `timed out after ${taskTimeoutMs}ms`, detail: 'agent did not finish', keptDir: dir }
    }
    if (!run) {
      return {
        ...base,
        error: `no result from agent process: ${(stderr || stdout).slice(-400).trim() || 'no output'}`,
        detail: 'agent process produced no parsable result',
        keptDir: dir,
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
    else outcome.keptDir = dir

    return outcome
  } catch (err) {
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
const REAL_CHANGE = 0.5

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

  if (candidate.passRate > baseline.passRate + 1e-9) {
    return { better: false, reason: `pass rate ${pct(baseline.passRate)} → ${pct(candidate.passRate)}, but no task improved by more than run-to-run noise` }
  }

  if (candidate.passRate < baseline.passRate) {
    return { better: false, reason: `pass rate fell ${pct(baseline.passRate)} → ${pct(candidate.passRate)}` }
  }

  // Tied on correctness — allow a clear efficiency win, and nothing less.
  const tokenDelta = relativeChange(baseline.totalTokens, candidate.totalTokens)
  // Wall clock is the user-visible metric for parallel autonomous work. Older
  // ledger records do not have it, so they safely fall back to summed task time.
  const baselineTime = baseline.wallClockMs ?? baseline.totalElapsedMs
  const candidateTime = candidate.wallClockMs ?? candidate.totalElapsedMs
  const timeDelta = relativeChange(baselineTime, candidateTime)

  if (tokenDelta <= -EFFICIENCY_MARGIN && timeDelta < EFFICIENCY_MARGIN) {
    return { better: true, reason: `same pass rate, ${pct(-tokenDelta)} fewer tokens` }
  }
  if (timeDelta <= -EFFICIENCY_MARGIN && tokenDelta < EFFICIENCY_MARGIN) {
    return { better: true, reason: `same pass rate, ${pct(-timeDelta)} faster` }
  }

  return {
    better: false,
    reason: `no measurable improvement (pass rate unchanged at ${pct(candidate.passRate)}, tokens ${signed(tokenDelta)}, time ${signed(timeDelta)})`,
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
