import { runShell } from '../shell.ts'
import { readCalibrationLog, summarizeCalibration } from '../autonomy/calibration.ts'
import type { VerificationRegime } from '../autonomy/detectChecks.ts'
import { annotateWithHistory, CORPUS } from './corpus.ts'
import { runLadder } from './ladder.ts'
import type { GapVector, LadderResult, LadderRung, PlantedDefect } from './types.ts'

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

  const regimes: VerificationRegime[] = ['mechanical', 'empirical', 'judgment']
  const byRegime = Object.fromEntries(
    regimes.map((regime) => {
      const inRegime = results.filter((r) => r.regime === regime)
      return [regime, { total: inRegime.length, caught: inRegime.filter((r) => r.caught).length }]
    }),
  ) as GapVector['byRegime']

  // Scored = the defects a cheap ladder is actually supposed to catch.
  const scored = results.filter((r) => r.regime !== 'judgment')
  const caught = scored.filter((r) => r.caught).length

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
    escapees: results.filter((r) => r.regime !== 'judgment' && !r.caught).map((r) => r.defectId),
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
