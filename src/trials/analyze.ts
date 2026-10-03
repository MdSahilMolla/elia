import { SIGNAL_CRITERIA, basketDigest } from './basket.ts'
import type { Measured, Outcome } from './outcomes.ts'
import { mean, median, minimumDetectableShift, requiredPerArmForMeans, requiredPerArmForRates, sd, stratifiedComparison } from './stats.ts'
import type { Comparison, Observation } from './stats.ts'

const WEEK = 7 * 86_400

export type MetricId = 'lineSurvival' | 'reverted' | 'fixedAfter'

/** Which commits are the agent's, by sha. Everything else is the comparison group. */
export type Arms = ReadonlyMap<string, boolean>

export interface ArmSummary {
  commits: number
  survivalMean: number
  survivalMedian: number
  revertedRate: number
  fixedAfterRate: number
}

export interface SignalCheck {
  name: string
  pass: boolean
  detail: string
}

export interface TrialPlan {
  metric: string
  /** The effect the plan is sized to detect, in the metric's own units. */
  effect: string
  perArm: number
  /** Weeks of the agent's current commit rate to fill both arms of a 50/50 trial. */
  weeks: number | undefined
}

export interface Report {
  digest: string
  horizonDays: number
  /** Of all lines that died inside the horizon, the share a fix removed. The rest is refactors, rewrites and removals. */
  fixShareOfDeaths: number
  coverage: { commits: number; measurable: number; survivalDefined: number; censored: number; noCountedFiles: number; unreadableFiles: number }
  arms: { agent: ArmSummary; other: ArmSummary }
  checks: SignalCheck[]
  verdict: 'usable' | 'not usable' | 'too few commits'
  comparisons: { metric: MetricId; adjusted: Comparison; overTime: Comparison }[]
  agentCommitsPerWeek: number
  smallestShiftToday: number | undefined
  plans: TrialPlan[]
}

const sizeBin = (outcome: Outcome): string => {
  const churn = outcome.added + outcome.deleted
  return churn < 10 ? 's' : churn < 50 ? 'm' : churn < 200 ? 'l' : 'xl'
}

const value = (outcome: Outcome, metric: MetricId): number | undefined =>
  metric === 'lineSurvival' ? outcome.lineSurvival : metric === 'reverted' ? Number(outcome.reverted) : Number(outcome.fixedAfter)

function observations(outcomes: readonly Outcome[], arms: Arms, metric: MetricId, weekly: boolean): Observation[] {
  const result: Observation[] = []
  for (const outcome of outcomes) {
    const y = value(outcome, metric)
    if (y === undefined) continue
    const stratum = `${sizeBin(outcome)}|${outcome.kind}${weekly ? `|w${Math.floor(outcome.landedAt / WEEK)}` : ''}`
    result.push({ stratum, treated: arms.get(outcome.sha) === true, y })
  }
  return result
}

function summarize(outcomes: readonly Outcome[]): ArmSummary {
  const survival = outcomes.flatMap((outcome) => (outcome.lineSurvival === undefined ? [] : [outcome.lineSurvival]))
  const rate = (pick: (outcome: Outcome) => boolean): number => (outcomes.length ? outcomes.filter(pick).length / outcomes.length : Number.NaN)
  return { commits: outcomes.length, survivalMean: mean(survival), survivalMedian: median(survival), revertedRate: rate((o) => o.reverted), fixedAfterRate: rate((o) => o.fixedAfter) }
}

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a')

export function analyze(measured: Measured, arms: Arms, horizonDays: number, totalCommits: number): Report {
  const { outcomes } = measured
  const survival = outcomes.flatMap((outcome) => (outcome.lineSurvival === undefined ? [] : [outcome.lineSurvival]))
  const agent = outcomes.filter((outcome) => arms.get(outcome.sha) === true)
  const other = outcomes.filter((outcome) => arms.get(outcome.sha) !== true)
  const criteria = SIGNAL_CRITERIA

  const spread = sd(survival)
  const saturated = survival.length ? survival.filter((s) => s >= 0.95).length / survival.length : Number.NaN
  const fixRate = outcomes.length ? outcomes.filter((outcome) => outcome.fixedAfter).length / outcomes.length : Number.NaN
  const [lowBand, highBand] = criteria.eventRateBand
  // Lines a fix removed are lines that died, so the two measurements must agree exactly.
  const touchedByFix = outcomes.filter((outcome) => outcome.fixKilled > 0)
  const consistent = touchedByFix.filter((outcome) => outcome.fixKilled <= outcome.died + criteria.invariantSlackLines).length
  const consistentShare = touchedByFix.length ? consistent / touchedByFix.length : Number.NaN
  const deaths = outcomes.reduce((sum, outcome) => sum + outcome.died, 0)
  const fixShareOfDeaths = deaths ? outcomes.reduce((sum, outcome) => sum + Math.min(outcome.fixKilled, outcome.died), 0) / deaths : Number.NaN
  const checks: SignalCheck[] = [
    { name: 'enough commits', pass: survival.length >= criteria.minMeasurable, detail: `${survival.length} with a line-survival value (need ${criteria.minMeasurable})` },
    { name: 'survival varies', pass: spread >= criteria.minSurvivalSpread, detail: `standard deviation ${Number.isFinite(spread) ? spread.toFixed(3) : 'n/a'} (need ≥ ${criteria.minSurvivalSpread})` },
    { name: 'survival not saturated', pass: saturated <= criteria.maxSaturatedShare, detail: `${pct(saturated)} of commits keep ≥95% of their lines (need ≤ ${pct(criteria.maxSaturatedShare)})` },
    { name: 'fix events comparable', pass: fixRate >= lowBand && fixRate <= highBand, detail: `${pct(fixRate)} of commits had lines rewritten by a later fix (need ${pct(lowBand)}–${pct(highBand)})` },
    {
      name: 'measurements agree',
      pass: consistentShare >= criteria.minInvariantShare,
      detail: `${consistent}/${touchedByFix.length} commits a fix touched had fix-removed lines ≤ dead lines (need ≥ ${pct(criteria.minInvariantShare)})`,
    },
  ]
  const verdict = !checks[0]!.pass ? 'too few commits' : checks.every((check) => check.pass) ? 'usable' : 'not usable'

  const metrics: MetricId[] = ['lineSurvival', 'reverted', 'fixedAfter']
  const comparisons = metrics.map((metric) => ({
    metric,
    adjusted: stratifiedComparison(observations(outcomes, arms, metric, false), { seed: 11 }),
    overTime: stratifiedComparison(observations(outcomes, arms, metric, true), { seed: 12 }),
  }))

  const landed = outcomes.map((outcome) => outcome.landedAt)
  const weeks = landed.length ? Math.max(1, (Math.max(...landed) - Math.min(...landed)) / WEEK) : 1
  const agentCommitsPerWeek = agent.length / weeks
  const weeksFor = (perArm: number): number | undefined => (agentCommitsPerWeek > 0 ? (2 * perArm) / agentCommitsPerWeek : undefined)
  const plans: TrialPlan[] = []
  if (Number.isFinite(spread)) {
    for (const delta of [0.1, 0.05]) {
      const perArm = requiredPerArmForMeans(spread, delta)
      plans.push({ metric: 'line survival', effect: `${delta * 100} points`, perArm, weeks: weeksFor(perArm) })
    }
  }
  if (Number.isFinite(fixRate) && fixRate > 0 && fixRate < 1) {
    const perArm = requiredPerArmForRates(fixRate, fixRate * 0.7)
    plans.push({ metric: 'fixed-after rate', effect: `${pct(fixRate)} → ${pct(fixRate * 0.7)}`, perArm, weeks: weeksFor(perArm) })
  }
  const smaller = Math.min(agent.length, other.length)
  return {
    fixShareOfDeaths,
    digest: basketDigest(),
    horizonDays,
    coverage: { commits: totalCommits, measurable: outcomes.length, survivalDefined: survival.length, censored: measured.censored, noCountedFiles: measured.noCountedFiles, unreadableFiles: measured.unreadableFiles },
    arms: { agent: summarize(agent), other: summarize(other) },
    checks,
    verdict,
    comparisons,
    agentCommitsPerWeek,
    smallestShiftToday: smaller > 1 && Number.isFinite(spread) ? minimumDetectableShift(spread, smaller) : undefined,
    plans,
  }
}

const signed = (x: number, digits = 1): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}` : 'n/a')

export function renderReport(report: Report, armLabel: string): string {
  const { coverage: c, arms } = report
  const events = { reverted: arms.agent.revertedRate > 0 || arms.other.revertedRate > 0, fixedAfter: arms.agent.fixedAfterRate > 0 || arms.other.fixedAfterRate > 0 }
  const lines: string[] = [
    `Outcome basket ${report.digest.slice(0, 19)}…   horizon ${report.horizonDays} days`,
    '',
    `Coverage: ${c.commits} commits → ${c.measurable} measurable (${c.censored} too recent for the horizon, ${c.noCountedFiles} touch only excluded files); ${c.survivalDefined} have a survival value${c.unreadableFiles ? `; ${c.unreadableFiles} files unreadable` : ''}`,
    '',
    'Is the signal usable?',
    ...report.checks.map((check) => `  ${check.pass ? '✓' : '✗'} ${check.name.padEnd(24)} ${check.detail}`),
    `  → ${report.verdict.toUpperCase()}`,
    `  What line survival means here: ${pct(report.fixShareOfDeaths)} of the lines that died were removed by a fix commit; the rest went in refactors, rewrites and removals.`,
    '',
    `Agent (${armLabel}) vs everything else. Observational: the arms differ in more than the agent, so this tests the instrument, not the agent.`,
    `                     ${'agent'.padStart(9)} ${'other'.padStart(9)}`,
    `  commits            ${String(arms.agent.commits).padStart(9)} ${String(arms.other.commits).padStart(9)}`,
    `  mean line survival ${pct(arms.agent.survivalMean).padStart(9)} ${pct(arms.other.survivalMean).padStart(9)}`,
    `  reverted           ${pct(arms.agent.revertedRate).padStart(9)} ${pct(arms.other.revertedRate).padStart(9)}`,
    `  fixed-after        ${pct(arms.agent.fixedAfterRate).padStart(9)} ${pct(arms.other.fixedAfterRate).padStart(9)}`,
    '',
    '  agent − other, same size and kind (points; 95% interval; permutation p) | also same week',
  ]
  for (const { metric, adjusted, overTime } of report.comparisons) {
    const show = (comparison: Comparison): string =>
      Number.isFinite(comparison.diff) ? `${signed(comparison.diff)} [${signed(comparison.ci[0])}, ${signed(comparison.ci[1])}] p=${comparison.p.toFixed(3)} (n=${comparison.treated + comparison.control})` : 'not enough of both arms'
    lines.push(metric !== 'lineSurvival' && !events[metric] ? `  ${metric.padEnd(13)} no events in this history, so nothing to compare` : `  ${metric.padEnd(13)} ${show(adjusted)}  |  ${show(overTime)}`)
  }
  lines.push('', `To tell a real change from noise (80% power, 5% level; the agent lands ${report.agentCommitsPerWeek.toFixed(1)} measurable commits a week)`)
  if (report.smallestShiftToday !== undefined) lines.push(`  today's data can resolve a survival shift of ${(report.smallestShiftToday * 100).toFixed(1)} points`)
  for (const plan of report.plans) {
    lines.push(`  ${plan.metric.padEnd(17)} ${plan.effect.padEnd(16)} ${String(plan.perArm).padStart(5)} per arm${plan.weeks === undefined ? '' : `  ≈ ${plan.weeks.toFixed(1)} weeks as a 50/50 trial`}`)
  }
  lines.push('', 'Commits stand in for tasks and cluster within sessions, so every n above is optimistic.')
  return lines.join('\n')
}
