import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eValue } from '../compounding/stats.ts'
import { appendSecureFile } from '../securePersistence.ts'
import { stateDir } from '../statePaths.ts'
import { bold, dim, green, red } from '../ui/theme.ts'
import { table } from '../ui/layout.ts'
import { formatElapsed, formatTokenCount } from '../usage.ts'
import type { Scorecard, TaskOutcome } from './fitness.ts'

/**
 * Harness lift: does elia beat the model it runs on?
 *
 * `elia bench --lift` scores the same tasks twice on the same model — once as
 * elia, once as the bare model with a shell (bareLoop.ts) — and this is the
 * arithmetic that turns the two cards into a claim. It is the one number that
 * says whether the harness is worth anything, and so it gets the same care as
 * the promotion gate: tasks are paired, a task either arm could not measure
 * leaves both sides, two cards on different models are refused rather than
 * compared, and the verdict is an anytime-valid test (compounding/stats.ts
 * `eValue`) rather than a difference in two percentages. A lift of +8 points on
 * nineteen tasks is usually noise, and saying "the harness helps" on noise is
 * the failure this file exists to prevent — in both directions: when the bare
 * model wins, that is reported as plainly as a win.
 *
 * Immutable to evolve candidates (sandbox.ts), with the control arm.
 */

/** e ≥ 1/δ rejects at level δ; δ = 0.05. */
export const LIFT_EVIDENCE = 20

export interface TaskLift {
  taskId: string
  weight: number
  /** Pass fraction on each arm (1/0 for a single run). */
  elia: number
  bare: number
  eliaShown: string
  bareShown: string
  eliaTokens: number
  bareTokens: number
  eliaMs: number
  bareMs: number
}

export type LiftVerdict = 'helps' | 'hurts' | 'inconclusive' | 'not comparable'

export interface LiftReport {
  model: string
  /** Tasks measured on both arms — the only ones the comparison uses. */
  tasks: TaskLift[]
  /** Tasks one arm or the other could not measure, left out of both sides. */
  unmeasured: string[]
  eliaRate: number
  bareRate: number
  /** eliaRate − bareRate, in [−1, 1]. */
  lift: number
  wins: number
  losses: number
  ties: number
  /** Evidence against "elia is no better than the bare model". */
  eHelps: number
  /** Evidence against "elia is no worse than the bare model". */
  eHurts: number
  verdict: LiftVerdict
  /** Set when the verdict is `not comparable`. */
  why?: string
  eliaTokens: number
  bareTokens: number
  eliaMs: number
  bareMs: number
}

function score(outcome: TaskOutcome): number {
  return outcome.attempts ? (outcome.passes ?? 0) / outcome.attempts : outcome.passed ? 1 : 0
}

function shown(outcome: TaskOutcome): string {
  return outcome.attempts ? `${outcome.passes ?? 0}/${outcome.attempts}` : outcome.passed ? 'pass' : 'fail'
}

export function compareLift(elia: Scorecard, bare: Scorecard): LiftReport {
  const bareById = new Map(bare.outcomes.map((outcome) => [outcome.taskId, outcome]))
  const tasks: TaskLift[] = []
  const unmeasured: string[] = []
  for (const mine of elia.outcomes) {
    const theirs = bareById.get(mine.taskId)
    if (!theirs || mine.unmeasured || theirs.unmeasured) {
      unmeasured.push(mine.taskId)
      continue
    }
    tasks.push({
      taskId: mine.taskId,
      weight: mine.weight,
      elia: score(mine),
      bare: score(theirs),
      eliaShown: shown(mine),
      bareShown: shown(theirs),
      eliaTokens: mine.totalTokens,
      bareTokens: theirs.totalTokens,
      eliaMs: mine.elapsedMs,
      bareMs: theirs.elapsedMs,
    })
  }
  for (const theirs of bare.outcomes) {
    if (!elia.outcomes.some((mine) => mine.taskId === theirs.taskId)) unmeasured.push(theirs.taskId)
  }

  const weight = tasks.reduce((sum, task) => sum + task.weight, 0)
  const rate = (pick: (task: TaskLift) => number) => (weight === 0 ? 0 : tasks.reduce((sum, task) => sum + task.weight * pick(task), 0) / weight)
  const differences = tasks.map((task) => task.elia - task.bare)
  const sum = (pick: (task: TaskLift) => number) => tasks.reduce((total, task) => total + pick(task), 0)

  const report: LiftReport = {
    model: elia.model || bare.model,
    tasks,
    unmeasured,
    eliaRate: rate((task) => task.elia),
    bareRate: rate((task) => task.bare),
    lift: rate((task) => task.elia) - rate((task) => task.bare),
    wins: differences.filter((difference) => difference > 0).length,
    losses: differences.filter((difference) => difference < 0).length,
    ties: differences.filter((difference) => difference === 0).length,
    eHelps: eValue(differences),
    eHurts: eValue(differences.map((difference) => -difference)),
    verdict: 'inconclusive',
    eliaTokens: sum((task) => task.eliaTokens),
    bareTokens: sum((task) => task.bareTokens),
    eliaMs: sum((task) => task.eliaMs),
    bareMs: sum((task) => task.bareMs),
  }

  // Two arms on different models measure the models, not the harness.
  if (elia.model && bare.model && elia.model !== bare.model) {
    return { ...report, verdict: 'not comparable', why: `the arms ran on different models (elia on ${elia.model}, bare on ${bare.model})` }
  }
  if (tasks.length === 0) return { ...report, verdict: 'not comparable', why: 'no task was measured on both arms' }
  if (report.eHelps >= LIFT_EVIDENCE) return { ...report, verdict: 'helps' }
  if (report.eHurts >= LIFT_EVIDENCE) return { ...report, verdict: 'hurts' }
  return report
}

const signed = (points: number) => `${points >= 0 ? '+' : '−'}${Math.abs(Math.round(points * 100))}`
const percent = (rate: number) => `${Math.round(rate * 100)}%`
const evidence = (e: number) => (e >= 100 ? e.toExponential(1) : e.toFixed(1))

export function verdictLine(report: LiftReport): string {
  switch (report.verdict) {
    case 'helps':
      return `the harness helps: ${signed(report.lift)} points over the bare model (e=${evidence(report.eHelps)} ≥ ${LIFT_EVIDENCE})`
    case 'hurts':
      return `the harness hurts: the bare model scores ${signed(-report.lift)} points higher (e=${evidence(report.eHurts)} ≥ ${LIFT_EVIDENCE})`
    case 'not comparable':
      return `not comparable — ${report.why}`
    default:
      return `no measurable difference yet: ${signed(report.lift)} points on ${report.tasks.length} task(s) (e=${evidence(report.eHelps)} for helps, ${evidence(report.eHurts)} for hurts; ${LIFT_EVIDENCE} needed)`
  }
}

export function renderLift(report: LiftReport): string {
  const lines = ['', `${bold('Harness lift')} ${dim(`— elia against ${report.model || 'the same model'} with no harness`)}`, '']
  const rows = table(
    [{ header: 'task' }, { header: 'elia', align: 'right' }, { header: 'bare', align: 'right' }, { header: 'lift', align: 'right' }],
    report.tasks.map((task) => {
      const difference = task.elia - task.bare
      const mark = difference > 0 ? green(signed(difference)) : difference < 0 ? red(signed(difference)) : dim('0')
      return [task.taskId, task.eliaShown, task.bareShown, mark]
    }),
  )
  for (const row of rows) lines.push(`  ${row}`)
  lines.push('')
  lines.push(`  elia  ${percent(report.eliaRate)}  ${dim(`${formatTokenCount(report.eliaTokens)} tokens · ${formatElapsed(report.eliaMs)}`)}`)
  lines.push(`  bare  ${percent(report.bareRate)}  ${dim(`${formatTokenCount(report.bareTokens)} tokens · ${formatElapsed(report.bareMs)}`)}`)
  lines.push(`  elia better on ${report.wins}, bare better on ${report.losses}, tied on ${report.ties}`)
  lines.push(`  ${bold(verdictLine(report))}`)
  if (report.unmeasured.length > 0) lines.push(`  ${dim(`left out, unmeasured on an arm: ${report.unmeasured.join(', ')}`)}`)
  lines.push('')
  return lines.join('\n')
}

export interface LiftRecord {
  at: number
  set: string
  model: string
  tasks: number
  eliaRate: number
  bareRate: number
  lift: number
  wins: number
  losses: number
  ties: number
  eHelps: number
  eHurts: number
  verdict: LiftVerdict
}

export const LIFT_HISTORY_PATH = join(stateDir, 'bench', 'lift.ndjson')

/** Remember a lift measurement for `elia compounding`. Never throws. */
export function recordLiftRun(report: LiftReport, set: string, path = LIFT_HISTORY_PATH): void {
  try {
    const record: LiftRecord = {
      at: Date.now(),
      set,
      model: report.model,
      tasks: report.tasks.length,
      eliaRate: report.eliaRate,
      bareRate: report.bareRate,
      lift: report.lift,
      wins: report.wins,
      losses: report.losses,
      ties: report.ties,
      eHelps: report.eHelps,
      eHurts: report.eHurts,
      verdict: report.verdict,
    }
    appendSecureFile(path, `${JSON.stringify(record)}\n`)
  } catch {
    // A lost record costs a data point, not the run.
  }
}

export function readLiftRuns(path = LIFT_HISTORY_PATH): LiftRecord[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LiftRecord]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/** One clause for `elia compounding`: the latest lift, or that it has never been measured. */
export function liftEvidence(runs: LiftRecord[]): string {
  const last = runs.at(-1)
  if (!last) return 'harness lift over the bare model never measured (`elia bench --lift`)'
  const when = new Date(last.at).toISOString().slice(0, 10)
  const scores = `${percent(last.eliaRate)} vs ${percent(last.bareRate)} bare on ${last.tasks} ${last.set} task(s), ${last.model || 'unknown model'}, ${when}`
  if (last.verdict === 'helps') return `harness lift ${signed(last.lift)} points, proven (${scores})`
  if (last.verdict === 'hurts') return `the bare model beats elia by ${signed(-last.lift)} points (${scores})`
  if (last.verdict === 'not comparable') return `last harness-lift run was not comparable (${scores})`
  return `harness lift ${signed(last.lift)} points, not yet distinguishable from noise (${scores})`
}
