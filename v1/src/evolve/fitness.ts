import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithConcurrencyLimit } from '../agentLoop.ts'
import { estimateCostUsd, formatCostUsd, formatElapsed, formatTokenCount } from '../usage.ts'
import { BENCH_TASKS, TOTAL_WEIGHT, type BenchTask } from './suite.ts'
import type { Metrics } from './ledger.ts'
import { bold, dim, green, red } from '../ui/theme.ts'
import { table } from '../ui/layout.ts'

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
/** Parallel tasks are faster, but provider rate limits turn a high number into retries and noise. */
const DEFAULT_CONCURRENCY = 2

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
}

export interface Scorecard {
  sourceRoot: string
  model: string
  outcomes: TaskOutcome[]
  /** Weighted fraction of tasks passed, 0..1. */
  passRate: number
  totalTokens: number
  /** Sum of the tasks' own durations. */
  totalElapsedMs: number
  /** Real time the whole suite took, which is lower when tasks ran in parallel. */
  wallClockMs: number
}

export interface MeasureOptions {
  sourceRoot: string
  tasks?: BenchTask[]
  concurrency?: number
  onTaskDone?: (outcome: TaskOutcome) => void
}

export async function measureFitness(options: MeasureOptions): Promise<Scorecard> {
  const tasks = options.tasks ?? BENCH_TASKS
  const startedAt = Date.now()

  const outcomes = await runWithConcurrencyLimit(
    tasks,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (task) => {
      const outcome = await runTaskWithRetry(task, options.sourceRoot)
      options.onTaskDone?.(outcome)
      return outcome
    },
  )

  // Every task reports the model it ran on; they agree, so the first one that got
  // far enough to report is the card's model.
  const model = outcomes.find((outcome) => outcome.model)?.model ?? ''

  const weightOf = (id: string) => tasks.find((task) => task.id === id)?.weight ?? 1
  const earned = outcomes.filter((outcome) => outcome.passed).reduce((sum, outcome) => sum + weightOf(outcome.taskId), 0)
  const available = tasks.reduce((sum, task) => sum + task.weight, 0) || TOTAL_WEIGHT

  return {
    sourceRoot: options.sourceRoot,
    model,
    outcomes,
    passRate: available === 0 ? 0 : earned / available,
    totalTokens: outcomes.reduce((sum, outcome) => sum + outcome.totalTokens, 0),
    totalElapsedMs: outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0),
    wallClockMs: Date.now() - startedAt,
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

export function isInfrastructureFailure(outcome: Pick<TaskOutcome, 'error' | 'steps'>): boolean {
  if (!outcome.error) return false
  // A hang is the candidate's own fault and must be allowed to score as a failure,
  // even though it also reports zero steps.
  if (/timed out/i.test(outcome.error)) return false
  // Zero steps means the very first model call never completed, which is not
  // something the agent's behaviour can cause.
  return outcome.steps === 0 || INFRASTRUCTURE_ERROR.test(outcome.error)
}

async function runTaskWithRetry(task: BenchTask, sourceRoot: string, attempts = 2): Promise<TaskOutcome> {
  let last = await runOneTask(task, sourceRoot)

  for (let attempt = 1; attempt < attempts && isInfrastructureFailure(last); attempt++) {
    if (last.keptDir) rmSync(last.keptDir, { recursive: true, force: true })
    // A short pause, since the usual causes (rate limit, overload) clear with time.
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    last = await runOneTask(task, sourceRoot)
  }

  return last
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
    const timeout = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, TASK_TIMEOUT_MS)

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timeout)

    const run = parseRunOutput(stdout)
    if (timedOut) {
      return { ...base, error: `timed out after ${TASK_TIMEOUT_MS}ms`, detail: 'agent did not finish', keptDir: dir }
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
    failed: card.outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.taskId),
    steps: Object.fromEntries(card.outcomes.map((outcome) => [outcome.taskId, outcome.steps])),
    totalTokens: card.totalTokens,
    totalElapsedMs: card.totalElapsedMs,
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

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
  const regressions = baseline.passed.filter((id) => !candidate.passed.includes(id))
  if (regressions.length > 0) {
    return { better: false, reason: `regressed on ${regressions.join(', ')} — a task that passed before now fails` }
  }

  if (candidate.passRate > baseline.passRate) {
    const gained = candidate.passed.filter((id) => !baseline.passed.includes(id))
    return {
      better: true,
      reason: `pass rate ${pct(baseline.passRate)} → ${pct(candidate.passRate)} (now passes ${gained.join(', ')})`,
    }
  }

  if (candidate.passRate < baseline.passRate) {
    return { better: false, reason: `pass rate fell ${pct(baseline.passRate)} → ${pct(candidate.passRate)}` }
  }

  // Tied on correctness — allow a clear efficiency win, and nothing less.
  const tokenDelta = relativeChange(baseline.totalTokens, candidate.totalTokens)
  const timeDelta = relativeChange(baseline.totalElapsedMs, candidate.totalElapsedMs)

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
  const lines: string[] = ['', `${bold(title)} ${dim(`— ${pct(card.passRate)} weighted pass rate`)}`, '']

  const rows = table(
    [
      { header: '' },
      { header: 'task' },
      { header: 'steps', align: 'right' },
      { header: 'time', align: 'right' },
      { header: 'tokens', align: 'right' },
    ],
    card.outcomes.map((outcome) => [
      outcome.passed ? green('✓') : red('✗'),
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
    if (outcome.error) lines.push(`      ${red(`error: ${outcome.error}`)}`)
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
  lines.push(
    `  ${dim(`total: ${formatTokenCount(card.totalTokens)} tokens · ${formatElapsed(card.totalElapsedMs)} of agent time · ${formatElapsed(card.wallClockMs)} wall clock · ~${cost}`)}`,
  )
  lines.push('')
  return lines.join('\n')
}
