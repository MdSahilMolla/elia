import type { EvidenceCost, GenerationRecord } from '../evolve/ledger.ts'

/**
 * How much a verdict costs, and whether that price is falling.
 *
 * Every other number in `elia compounding` asks whether elia is getting better.
 * This one asks whether *getting better* is getting cheaper — and it is the only
 * one of them that can show a loop compounding without a single weight changing.
 *
 * The argument is short. A self-improvement loop turns when it can afford to.
 * Elia's could not: scoring one candidate meant running the whole benchmark
 * against a paid model, so the search advanced twice in a month and stage 6 has
 * never had anything to report. Cut the price of a verdict and the same budget
 * buys more generations; more generations mean more promotions; and a promotion
 * that lands in the search itself — the loop, the roles, the tools, the sieve —
 * cuts the price again. That is the recursion, and *verdicts per token* is where
 * it shows up first, long before any pass rate moves.
 *
 * It is read from the ledger, which `engine.ts` writes anyway. A generation with
 * no `evidenceCost` predates the accounting and is left out of the totals rather
 * than guessed at.
 */

export interface VelocityWindow {
  /** Generations that recorded what their verdict cost. */
  verdicts: number
  tokens: number
  tasksRun: number
  /** Tasks a full sweep would have run for these verdicts. */
  tasksAvailable: number
  /** Tokens per verdict — the price of one decision. */
  tokensPerVerdict: number
  /** Tasks per verdict; the number a full sweep would give is `tasksAvailable / verdicts`. */
  tasksPerVerdict: number
}

export interface VelocityReport {
  all: VelocityWindow
  /** The older and newer halves of the recorded generations, when there are enough to split. */
  earlier?: VelocityWindow
  later?: VelocityWindow
  /** Fraction of the tasks a full sweep would have run that were not run, 0..1. */
  avoided: number
  /**
   * Verdicts got cheaper: the later half pays fewer tasks per decision than the
   * earlier half. Undefined until there are generations on both sides.
   */
  cheapening?: boolean
  /** Generations in the ledger with no cost recorded — written before this existed. */
  unaccounted: number
}

/** Two generations a side is the least that can show a direction rather than a single step. */
export const MIN_SPLIT = 4

function window(costs: EvidenceCost[]): VelocityWindow {
  const sum = (pick: (cost: EvidenceCost) => number) => costs.reduce((total, cost) => total + pick(cost), 0)
  const verdicts = costs.length
  const tokens = sum((cost) => cost.tokens)
  const tasksRun = sum((cost) => cost.tasksRun)
  const tasksAvailable = sum((cost) => cost.tasksTotal)
  return {
    verdicts,
    tokens,
    tasksRun,
    tasksAvailable,
    tokensPerVerdict: verdicts === 0 ? 0 : tokens / verdicts,
    tasksPerVerdict: verdicts === 0 ? 0 : tasksRun / verdicts,
  }
}

export function evidenceVelocity(ledger: GenerationRecord[]): VelocityReport {
  const costs = ledger.flatMap((record) => (record.evidenceCost ? [record.evidenceCost] : []))
  const all = window(costs)

  const report: VelocityReport = {
    all,
    avoided: all.tasksAvailable === 0 ? 0 : (all.tasksAvailable - all.tasksRun) / all.tasksAvailable,
    unaccounted: ledger.length - costs.length,
  }

  if (costs.length >= MIN_SPLIT) {
    const half = Math.floor(costs.length / 2)
    const earlier = window(costs.slice(0, half))
    const later = window(costs.slice(half))
    report.earlier = earlier
    report.later = later
    report.cheapening = later.tasksPerVerdict < earlier.tasksPerVerdict
  }

  return report
}

export function renderVelocity(report: VelocityReport): string {
  if (report.all.verdicts === 0) {
    return report.unaccounted > 0
      ? `evidence velocity — not yet recorded (${report.unaccounted} generation(s) predate the accounting); the next \`elia evolve\` will start it`
      : 'evidence velocity — no generations yet'
  }

  const lines: string[] = []
  const { all } = report
  const sweep = all.tasksAvailable / all.verdicts
  lines.push(
    `evidence velocity — ${all.verdicts} verdict(s) at ${all.tasksPerVerdict.toFixed(1)} task run(s) each, against ${sweep.toFixed(0)} for a full sweep (${Math.round(report.avoided * 100)}% not paid for)`,
  )
  if (all.tokens > 0) lines.push(`  ${Math.round(all.tokensPerVerdict).toLocaleString()} token(s) per verdict`)

  if (report.earlier && report.later) {
    const direction = report.cheapening ? 'cheaper' : 'no cheaper'
    lines.push(
      `  last ${report.later.verdicts} verdict(s) cost ${report.later.tasksPerVerdict.toFixed(1)} task run(s) each against ${report.earlier.tasksPerVerdict.toFixed(1)} for the ${report.earlier.verdicts} before — verdicts are getting ${direction}`,
    )
  } else {
    lines.push(`  ${MIN_SPLIT - all.verdicts} more verdict(s) before the trend can be split`)
  }

  return lines.join('\n')
}
