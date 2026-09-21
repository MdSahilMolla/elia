import type { CalibrationEntry } from '../autonomy/calibration.ts'
import type { Domain, TurnOutcome } from '../autonomy/outcomes.ts'
import type { GapVector } from '../gap/types.ts'
import { frontierMargin, resamplingPrecision, saturationSamples } from './theory.ts'
import { wilson, type RateEstimate } from './stats.ts'

/**
 * Phase 0 of the paper's build order: where is elia's verification frontier?
 *
 * "Nothing can be steered unmeasured." Corollary 1 says a task family can be
 * amplified by sampling only when the generator's success rate `p` beats the
 * verifier's false-accept rate `α` (scaled by the precision target). So every
 * decision the resource governor makes starts here: for each family of work
 * elia does, what are `p`, `α` and `β`, how sure are we, and which side of the
 * frontier does that put the family on?
 *
 * All three come from records elia already writes:
 *
 * - `p` from `outcomes.jsonl`. A turn that ran verification and needed `r`
 *   repairs drew `1 + r` samples and at most one of them passed, so the
 *   per-sample success rate is passes over samples.
 * - `α` and `β` from the planted-defect ladder (`elia gap`): a defect that got
 *   through is a false accept, a clean control that tripped a rung is a false
 *   reject. These are *not* on the generator's own distribution — the paper's §2
 *   insists they should be — so they are labelled as planted.
 * - An on-distribution `α` for the completion assessor from
 *   `completion-calibration.ndjson`: a run the assessor called verified/high
 *   whose recorded facts contradict it is exactly a false accept on real work.
 *
 * Where a number has no data behind it, it is `undefined` and the family is
 * reported as unmeasured. A frontier drawn from invented rates would be the
 * confident-but-vacuous gate this codebase keeps having to remove.
 */

export type Regime = 'mechanical' | 'empirical' | 'judgment'

/** Which verification a family's work usually gets. Frontend work is checked by rendering; prose by opinion. */
export const FAMILY_REGIME: Record<Domain, Regime> = {
  code: 'mechanical',
  backend: 'mechanical',
  tests: 'mechanical',
  config: 'mechanical',
  frontend: 'empirical',
  docs: 'judgment',
}

export interface RateSource {
  estimate: RateEstimate
  /** Where the number came from, in words a reader can check. */
  source: string
  /** True when measured on elia's own output rather than on planted examples. */
  onDistribution: boolean
}

export type FrontierStatus = 'inside' | 'outside' | 'uncertain' | 'unmeasured'

export interface FamilyEstimate {
  family: Domain
  regime: Regime
  /** Turns that changed files in this family. The family's weight in Φ. */
  turns: number
  /** Of those, how many ran no verification at all — work with no verifier is outside every frontier. */
  unverified: number
  /** Per-sample success rate among verified turns. */
  p: RateEstimate
  alpha?: RateSource
  beta?: RateSource
  /** Proposition 1 at the point estimates. */
  precision?: number
  /** Proposition 1 at the pessimistic and optimistic ends of the intervals. */
  precisionRange?: [number, number]
  /** Log-odds distance from the frontier at the point estimates; positive is inside. */
  margin?: number
  /**
   * `inside` when even the pessimistic ends of the intervals (low `p`, high `α`)
   * are inside, `outside` when even the optimistic ends are outside, otherwise
   * `uncertain`.
   */
  status: FrontierStatus
  /** Corollary 2: samples past which compute on this family buys nothing. */
  saturation?: number
}

export interface VerifierRates {
  /** Planted defects the mechanical rungs let through. */
  mechanical?: RateSource
  empirical?: RateSource
  /** Planted judgment-regime defects the critic waved through. */
  judgment?: RateSource
  /** Clean controls a rung wrongly failed. */
  falseReject?: RateSource
  /** Runs the completion assessor called verified/high that the facts contradict. */
  assessor?: RateSource
}

export interface FrontierReport {
  /** The precision the frontier is drawn for (π*). */
  target: number
  families: FamilyEstimate[]
  verifiers: VerifierRates
  /**
   * Frontier mass Φ: the turn-weighted share of measured families that are
   * inside. `undefined` when no family could be placed.
   */
  mass?: number
  /** Share of file-changing turns that ran no verification at all. */
  unverifiedShare: RateEstimate
}

export interface FrontierInputs {
  outcomes: readonly TurnOutcome[]
  gap?: GapVector
  calibration: readonly CalibrationEntry[]
}

const FAMILIES: Domain[] = ['code', 'backend', 'tests', 'config', 'frontend', 'docs']

export function verifierRates(gap: GapVector | undefined, calibration: readonly CalibrationEntry[]): VerifierRates {
  const rates: VerifierRates = {}
  if (gap) {
    const mechanical = gap.byRegime.mechanical
    if (mechanical && mechanical.total > 0) {
      rates.mechanical = {
        estimate: wilson(mechanical.total - mechanical.caught, mechanical.total),
        source: `planted mechanical defects the ladder let through (elia gap, ${gap.at.slice(0, 10)})`,
        onDistribution: false,
      }
    }
    const empirical = gap.byRegime.empirical
    if (empirical && empirical.total > 0) {
      rates.empirical = {
        estimate: wilson(empirical.total - empirical.caught, empirical.total),
        source: `planted empirical defects the ladder let through (elia gap, ${gap.at.slice(0, 10)})`,
        onDistribution: false,
      }
    }
    const verdicts = gap.criticVerdicts ?? []
    if (verdicts.length > 0) {
      rates.judgment = {
        estimate: wilson(verdicts.filter((verdict) => !verdict.caughtDefective).length, verdicts.length),
        source: `planted judgment defects the critic waved through (elia gap, ${gap.at.slice(0, 10)})`,
        onDistribution: false,
      }
      rates.falseReject = {
        estimate: wilson(verdicts.filter((verdict) => verdict.flaggedClean).length, verdicts.length),
        source: `clean controls the critic blocked (elia gap, ${gap.at.slice(0, 10)})`,
        onDistribution: false,
      }
    } else if (gap.defectsScored > 0) {
      const flagged = Math.round(gap.falsePositiveRate * gap.defectsScored)
      rates.falseReject = {
        estimate: wilson(flagged, gap.defectsScored),
        source: `clean controls a rung wrongly failed (elia gap, ${gap.at.slice(0, 10)})`,
        onDistribution: false,
      }
    }
  }
  const claimed = calibration.filter((entry) => entry.reportedState === 'verified' && entry.confidence === 'high')
  if (claimed.length > 0) {
    rates.assessor = {
      estimate: wilson(claimed.filter((entry) => entry.contradictions.length > 0).length, claimed.length),
      source: `runs the completion assessor called verified/high that their recorded facts contradict (${claimed.length} claimed)`,
      onDistribution: true,
    }
  }
  return rates
}

/** The false-accept rate that applies to a regime: on-distribution evidence first, planted evidence after. */
function alphaFor(regime: Regime, rates: VerifierRates): RateSource | undefined {
  if (regime === 'mechanical') return rates.mechanical ?? rates.assessor
  if (regime === 'empirical') return rates.empirical ?? rates.assessor
  return rates.judgment ?? rates.assessor
}

function classify(p: RateEstimate, alpha: RateSource | undefined, beta: RateSource | undefined, target: number): FrontierStatus {
  if (p.mean === undefined || !alpha || alpha.estimate.mean === undefined) return 'unmeasured'
  const betaHi = beta?.estimate.hi ?? 0
  const betaLo = beta?.estimate.lo ?? 0
  // A zero upper bound on α would put everything inside by fiat; a rate never
  // observed is still bounded by its interval, never by zero.
  const pessimistic = frontierMargin(p.lo, Math.max(alpha.estimate.hi, 1e-6), betaHi, target)
  const optimistic = frontierMargin(p.hi, Math.max(alpha.estimate.lo, 1e-6), betaLo, target)
  if (pessimistic >= 0) return 'inside'
  if (optimistic < 0) return 'outside'
  return 'uncertain'
}

export function estimateFrontier(inputs: FrontierInputs, target = 0.5): FrontierReport {
  const verifiers = verifierRates(inputs.gap, inputs.calibration)
  const changing = inputs.outcomes.filter((outcome) => outcome.filesChanged > 0 && !outcome.aborted)
  const unverifiedTotal = changing.filter((outcome) => outcome.verify === 'none' || outcome.verify === 'skipped').length

  const families: FamilyEstimate[] = FAMILIES.map((family) => {
    const regime = FAMILY_REGIME[family]
    const mine = changing.filter((outcome) => outcome.domains.includes(family))
    const verified = mine.filter((outcome) => outcome.verify === 'pass' || outcome.verify === 'fail')
    const samples = verified.reduce((sum, outcome) => sum + 1 + Math.max(0, outcome.repairAttempts), 0)
    const passes = verified.filter((outcome) => outcome.verify === 'pass').length
    const p = wilson(passes, samples)
    const alpha = alphaFor(regime, verifiers)
    const beta = verifiers.falseReject
    const estimate: FamilyEstimate = {
      family,
      regime,
      turns: mine.length,
      unverified: mine.length - verified.length,
      p,
      ...(alpha ? { alpha } : {}),
      ...(beta ? { beta } : {}),
      status: classify(p, alpha, beta, target),
    }
    if (p.mean !== undefined && alpha?.estimate.mean !== undefined) {
      const betaMean = beta?.estimate.mean ?? 0
      estimate.precision = resamplingPrecision(p.mean, alpha.estimate.mean, betaMean)
      estimate.precisionRange = [
        resamplingPrecision(p.lo, alpha.estimate.hi, beta?.estimate.hi ?? 0),
        resamplingPrecision(p.hi, alpha.estimate.lo, beta?.estimate.lo ?? 0),
      ]
      estimate.margin = frontierMargin(p.mean, Math.max(alpha.estimate.mean, 1e-6), betaMean, target)
      estimate.saturation = saturationSamples(p.mean, alpha.estimate.mean, betaMean)
    }
    return estimate
  })

  const placed = families.filter((family) => family.status === 'inside' || family.status === 'outside')
  const placedWeight = placed.reduce((sum, family) => sum + family.turns, 0)
  const insideWeight = placed.filter((family) => family.status === 'inside').reduce((sum, family) => sum + family.turns, 0)

  return {
    target,
    families,
    verifiers,
    ...(placedWeight > 0 ? { mass: insideWeight / placedWeight } : {}),
    unverifiedShare: wilson(unverifiedTotal, changing.length),
  }
}

function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`
}

function interval(rate: RateEstimate): string {
  if (rate.mean === undefined) return 'no data'
  return `${pct(rate.mean)} [${pct(rate.lo)}–${pct(rate.hi)}] of ${rate.trials}`
}

export function renderFrontier(report: FrontierReport): string {
  const lines = [`VERIFICATION FRONTIER · precision target ${pct(report.target)}`, '']
  const v = report.verifiers
  const rateLine = (label: string, source: RateSource | undefined) =>
    `  ${label.padEnd(22)} ${source ? `${interval(source.estimate)}${source.onDistribution ? '' : ' (planted)'}` : 'not measured'}`
  lines.push(
    '  false-accept rate α',
    rateLine('  mechanical ladder', v.mechanical),
    rateLine('  empirical ladder', v.empirical),
    rateLine('  critic (judgment)', v.judgment),
    rateLine('  completion assessor', v.assessor),
    rateLine('false-reject rate β', v.falseReject),
    '',
  )
  for (const family of report.families) {
    if (family.turns === 0) continue
    const status = family.status === 'inside' ? '✓ inside' : family.status === 'outside' ? '✗ outside' : family.status === 'uncertain' ? '? uncertain' : '· unmeasured'
    const precision = family.precisionRange ? ` · Π ${pct(family.precisionRange[0])}–${pct(family.precisionRange[1])}` : ''
    lines.push(
      `  ${family.family.padEnd(9)} ${status.padEnd(13)} p ${interval(family.p)}${precision} · ${family.unverified}/${family.turns} unverified`,
    )
  }
  lines.push('')
  lines.push(`  frontier mass Φ ${report.mass === undefined ? 'unknown (no family could be placed)' : pct(report.mass)}`)
  lines.push(`  file-changing turns with no verification at all: ${interval(report.unverifiedShare)} — outside every frontier`)
  return lines.join('\n')
}
