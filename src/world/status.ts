import { spentInLastDay } from '../evolve/budget.ts'
import type { GenerationRecord } from '../evolve/ledger.ts'
import { brokenAt, calibrate, scored, MIN_CALIBRATION, type Receipt } from './kernel.ts'
import { readPriors, renderRuntime, runtimeStatus, type Priors, type RuntimeStatus } from './runtime.ts'
import { readMeta, renderContext, renderMeta, worldContext, type MetaScore } from '../reason/plan.ts'

/**
 * What the world model has done and how far to trust it, read from its own
 * receipts and the evolve ledger. Every number is computed from a file elia
 * wrote anyway; a model with no scored predictions says so instead of
 * reporting a coefficient it has not earned.
 */

export interface WorldStatus {
  predictions: number
  scored: number
  chain: 'intact' | 'empty' | { brokenAt: number }
  calibration: ReturnType<typeof calibrate>
  /** Candidates the model stopped before any benchmark task ran, by why. */
  stopped: { total: number; unmeasurable: number; small: number; adds: number; other: number }
  /** What those stops did not spend: one sweep each, the most a raced candidate could have cost. */
  avoidedTokens: number
  spentToday: number
  candidates: number
  /** What the runtime model has learned in this project, and how well it predicts. */
  runtime: RuntimeStatus
  /** How well the reasoning layer's plans have predicted whether a search would verify. */
  meta: MetaScore
  /** The project as the reasoning layer's planner reads it. */
  context: ReturnType<typeof worldContext>
}

type Twinned = Pick<GenerationRecord, 'twin' | 'baseline' | 'at' | 'costTokens' | 'evidenceCost'>

export function worldStatus(receipts: readonly Receipt[], ledger: readonly Twinned[], now = Date.now(), priors: Priors = readPriors(), meta: MetaScore = readMeta()): WorldStatus {
  const skipped = ledger.filter((record) => record.twin?.decision === 'skip')
  const why = (record: Twinned) => record.twin?.reason ?? ''
  const unmeasurable = skipped.filter((record) => /could not be measured/i.test(why(record))).length
  const small = skipped.filter((record) => /predicted saving/i.test(why(record))).length
  const adds = skipped.filter((record) => /adds \d+ tokens/i.test(why(record))).length
  return {
    predictions: new Set(receipts.map((receipt) => receipt.generation)).size,
    scored: scored(receipts).length,
    chain: receipts.length === 0 ? 'empty' : (() => {
      const broken = brokenAt(receipts)
      return broken === undefined ? 'intact' : { brokenAt: broken }
    })(),
    calibration: calibrate(receipts),
    stopped: { total: skipped.length, unmeasurable, small, adds, other: skipped.length - unmeasurable - small - adds },
    avoidedTokens: skipped.reduce((sum, record) => sum + (record.baseline?.totalTokens ?? 0), 0),
    spentToday: spentInLastDay(ledger, now),
    candidates: ledger.filter((record) => record.twin).length,
    runtime: runtimeStatus(priors),
    meta,
    context: worldContext(priors),
  }
}

const millions = (tokens: number) => `${(tokens / 1e6).toFixed(1)}M`

export function renderWorld(status: WorldStatus): string {
  const lines = ['WORLD MODEL · elia predicts before it acts and is scored on what happened', '  in every run (this project):', renderRuntime(status.runtime), '  in how it chooses to reason:', renderContext(status.context), renderMeta(status.meta), '  in elia\'s own changes (the twin of the harness):']
  if (status.predictions === 0) {
    lines.push('  no candidate has been screened yet — the first `elia evolve` writes its first prediction')
  } else {
    const chain = status.chain === 'intact' ? 'chain intact' : status.chain === 'empty' ? 'no receipts' : `CHAIN BROKEN at receipt ${status.chain.brokenAt} — a prediction was rewritten`
    lines.push(`  ${status.predictions} prediction(s) committed, ${status.scored} scored against a measurement · ${chain}`)
  }
  const c = status.calibration
  lines.push(
    c.n < MIN_CALIBRATION
      ? `  calibration: not yet — needs ${MIN_CALIBRATION} scored predictions, has ${c.n} (until then the arithmetic runs uncorrected)`
      : `  calibration: coefficient ×${c.k.toFixed(2)}, uncertainty ×${c.sdScale.toFixed(2)}, ${Math.round((c.coverage ?? 0) * 100)}% of measurements inside its own 95% interval (over ${c.n})`,
  )
  if (status.stopped.total > 0) {
    lines.push(
      `  stopped before any benchmark task ran: ${status.stopped.total} of ${status.candidates} candidate(s) (${status.stopped.unmeasurable} that no task can see, ${status.stopped.small} saving too small, ${status.stopped.adds} adding text${status.stopped.other ? `, ${status.stopped.other} other` : ''}) — about ${millions(status.avoidedTokens)} tokens not spent`,
    )
  }
  lines.push(`  spent measuring in the last 24 hours: ${millions(status.spentToday)} tokens`)
  return lines.join('\n')
}
