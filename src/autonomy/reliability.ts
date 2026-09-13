/**
 * The reliability feedback loop.
 *
 * `calibration.ts` already records, for every finished autonomous run, whether
 * the completion verdict held up against the objective facts (did a "verified"
 * run ship with a failed verification, unresolved actions, incomplete steps?).
 * That data sat there as a report line and nothing consumed it.
 *
 * This turns it into a signal the *next* run acts on: when a project's recent
 * runs have a habit of over-claiming, the orient phase is told to tighten the
 * acceptance contract and the run gets extra scrutiny before it is allowed to
 * call itself done. When the record is clean, nothing changes.
 *
 * Read-only and deterministic — it only summarises what already happened.
 */

import { readCalibrationLog, type CalibrationEntry } from './calibration.ts'

/** How many of the most recent runs to weigh, and the floor below which there
 * is not enough history to say anything. */
const WINDOW = 15
const MIN_RUNS = 4

export interface ReliabilitySignal {
  /** Runs considered (capped at WINDOW). */
  sampled: number
  /** Fraction of sampled runs whose verdict contradicted the facts, 0–1. */
  contradictionRate: number
  /**
   * Fraction of sampled runs that actually reached `verified`, 0–1. This is
   * deliberately a separate axis from `contradictionRate`: a run that is
   * honestly reported `failed`/`aborted` adds nothing to the contradiction
   * rate, so a project whose runs mostly fail — but fail honestly — used to
   * read as `clean` ("track record is sound") with zero extra scrutiny. Both
   * axes now feed the tier below.
   */
  successRate: number
  /** `clean` · `watch` (some drift) · `unreliable` (frequent over-claiming). */
  tier: 'insufficient-history' | 'clean' | 'watch' | 'unreliable'
  /** Extra adversarial reviewers to add on top of the profile default. */
  extraReviewers: number
  /** The completion assessor must not report "verified" unless verification AND
   * review both actually passed on this run. */
  strictCompletion: boolean
  /** One line for the orient agent / run log. */
  note: string
}

const CLEAN: ReliabilitySignal = {
  sampled: 0,
  contradictionRate: 0,
  successRate: 0,
  tier: 'insufficient-history',
  extraReviewers: 0,
  strictCompletion: false,
  note: 'No completion-calibration history for this project yet.',
}

/** Below this fraction of recent runs actually reaching `verified`, completion
 * itself is rare enough here to warrant the same scrutiny as over-claiming —
 * even when every one of those runs was honestly reported as not-done. */
const LOW_SUCCESS_THRESHOLD = 0.34

export function reliabilitySignal(cwd = process.cwd()): ReliabilitySignal {
  return signalFromEntries(readCalibrationLog(cwd))
}

/** Split out for testing. */
export function signalFromEntries(all: CalibrationEntry[]): ReliabilitySignal {
  const recent = all.slice(-WINDOW)
  if (recent.length < MIN_RUNS) return { ...CLEAN, sampled: recent.length }

  const contradicting = recent.filter((e) => e.contradictions.length > 0).length
  const rate = contradicting / recent.length
  const verified = recent.filter((e) => e.reportedState === 'verified').length
  const successRate = verified / recent.length
  const lowSuccess = successRate < LOW_SUCCESS_THRESHOLD
  const successNote = `${verified}/${recent.length} recent run(s) actually reached "verified" (${pct(successRate)}).`

  if (rate >= 0.34) {
    return {
      sampled: recent.length,
      contradictionRate: rate,
      successRate,
      tier: 'unreliable',
      extraReviewers: 2,
      strictCompletion: true,
      note: `Reliability: ${contradicting}/${recent.length} recent runs claimed more than the facts supported (${pct(rate)}). Treat every "done" here as unproven — widen the acceptance contract, require concrete evidence, and expect extra review.`,
    }
  }
  if (rate >= 0.15 || lowSuccess) {
    return {
      sampled: recent.length,
      contradictionRate: rate,
      successRate,
      tier: 'watch',
      extraReviewers: 1,
      strictCompletion: true,
      note: rate >= 0.15
        ? `Reliability: ${contradicting}/${recent.length} recent runs over-claimed completion (${pct(rate)}). Be precise about what "done" means for this run and back it with evidence.`
        : `Reliability: verdicts have been honest (${pct(rate)} contradiction rate), but ${successNote} Do not assume this kind of task usually finishes — treat "should be straightforward" as a hypothesis, not a plan.`,
    }
  }
  return {
    sampled: recent.length,
    contradictionRate: rate,
    successRate,
    tier: 'clean',
    extraReviewers: 0,
    strictCompletion: false,
    note: `Reliability: ${recent.length} recent runs, ${contradicting} verdict/facts contradiction(s) (${pct(rate)}), ${successNote} Track record is sound.`,
  }
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}
