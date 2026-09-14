import { runShell } from '../shell.ts'
import { readCalibrationLog, summarizeCalibration } from '../autonomy/calibration.ts'
import type { VerificationRegime } from '../autonomy/detectChecks.ts'
import { annotateWithHistory, CORPUS } from './corpus.ts'
import { runLadder } from './ladder.ts'
import { applyCriticVerdicts, runCriticRung, type CriticRungResult } from './critic.ts'
import type { CriticVerdict, GapVector, LadderResult, LadderRung, PlantedDefect } from './types.ts'

/**
 * Runs the deterministic ladder over the whole planted-defect corpus and folds
 * the results, plus the existing completion-calibration history, into one
 * `GapVector`.
 *
 * The catch rate deliberately scores only the defects the cheap ladder is meant
 * to catch (mechanical + empirical regimes). The `judgment`-regime controls are
 * still run and reported — their escape rate is the honest measure of how much
 * of the verification surface no cheap check can reach.
 */

export interface ScoreboardOptions {
  corpus?: PlantedDefect[]
  cwd?: string
  onDefect?: (result: LadderResult) => void
  /**
   * Also run the adversarial-critic rung, which costs model calls.
   *
   * Off by default so `elia gap` stays free and reproducible, but the
   * distillation gate turns it on: without it the whole vector is deterministic,
   * no prompt change can move a single number, and the Verifier-Leads check
   * compares a value to itself. See `src/gap/critic.ts`.
   */
  critic?: boolean
  onCriticVerdict?: (verdict: CriticVerdict) => void
  signal?: AbortSignal
}

/**
 * True when nothing was actually learned about this defect: it was not caught,
 * and the rung that was supposed to catch it could not run.
 *
 * Exported so the rule is testable on its own — it decides what goes into the
 * catch-rate denominator, which is the number the whole guard turns on.
 */
export function isUnmeasured(result: LadderResult): boolean {
  return !result.caught && result.skipped.includes(result.expectedCatch)
}

export async function computeGapVector(options: ScoreboardOptions = {}): Promise<GapVector> {
  const cwd = options.cwd ?? process.cwd()
  const corpus = options.corpus ?? annotateWithHistory(CORPUS, cwd)

  const results: LadderResult[] = []
  for (const defect of corpus) {
    const result = await runLadder(defect)
    results.push(result)
    options.onDefect?.(result)
  }

  // The critic rung, when asked for. Its verdicts are folded into the matching
  // ladder results below so a defect the critic caught stops counting as an
  // escapee — the ladder as a whole did catch it, just not cheaply.
  let critic: CriticRungResult | undefined
  if (options.critic) {
    critic = await runCriticRung({ corpus, signal: options.signal, onVerdict: options.onCriticVerdict })
    applyCriticVerdicts(results, critic.verdicts)
  }

  const regimes: VerificationRegime[] = ['mechanical', 'empirical', 'judgment']
  const byRegime = Object.fromEntries(
    regimes.map((regime) => {
      const inRegime = results.filter((r) => r.regime === regime)
      return [regime, { total: inRegime.length, caught: inRegime.filter((r) => r.caught).length }]
    }),
  ) as GapVector['byRegime']

  // Scored = the defects a cheap ladder is supposed to catch, minus the ones it
  // could not even attempt. A defect whose expected rung did not run was never
  // tested, so it is neither a catch nor an escape — it is a hole in the
  // measurement. `LadderResult.skipped` always claimed these were "excluded from
  // scoring"; they were not, and counting them as escapees overstated the gap
  // exactly when the scoreboard was least able to see. It also made the guard
  // unusable from an evolution sandbox, where a missing checker turned into
  // "defect(s) now getting through the ladder" and rejected every candidate.
  const scored = results.filter((r) => r.regime !== 'judgment' && !isUnmeasured(r))
  const caught = scored.filter((r) => r.caught).length
  const notMeasured = results.filter((r) => r.regime !== 'judgment' && isUnmeasured(r))

  const rungs: LadderRung[] = ['structural', 'typecheck', 'test', 'hygiene', 'critic']
  const byRung: GapVector['byRung'] = {}
  for (const rung of rungs) {
    const expected = results.filter((r) => r.expectedCatch === rung)
    if (expected.length === 0) continue
    byRung[rung] = { expected: expected.length, caught: expected.filter((r) => r.caughtBy.includes(rung)).length }
  }

  const falsePositives = results.filter((r) => r.falsePositiveOnClean).length

  const calibration = summarizeCalibration(readCalibrationLog(cwd))
  const calibrationContradictionRate = calibration.total > 0 ? calibration.contradicting / calibration.total : 0

  return {
    at: new Date().toISOString(),
    ref: await gitRef(cwd),
    defectsTotal: results.length,
    defectsScored: scored.length,
    mechanicalCatchRate: scored.length > 0 ? caught / scored.length : 0,
    falsePositiveRate: results.length > 0 ? falsePositives / results.length : 0,
    byRegime,
    byRung,
    calibrationContradictionRate,
    // Left `undefined` when the rung did not run, which is what makes
    // `checkGapNotRegressed` skip the clause rather than read a missing
    // measurement as a perfect score.
    criticFalseAcceptRate: critic && !critic.unavailable ? critic.falseAcceptRate : undefined,
    criticVerdicts: critic?.verdicts,
    escapees: results.filter((r) => r.regime !== 'judgment' && !r.caught && !isUnmeasured(r)).map((r) => r.defectId),
    notMeasured: notMeasured.map((r) => `${r.defectId} (${r.skipped.join(', ')} unavailable)`),
  }
}

async function gitRef(cwd: string): Promise<string> {
  try {
    const result = await runShell('git rev-parse --short HEAD', 10_000, cwd)
    const sha = result.stdout.trim()
    return sha || 'working-tree'
  } catch {
    return 'working-tree'
  }
}
