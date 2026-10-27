import { existsSync, readFileSync } from 'node:fs'
import { appendSecureFile, hardenSecureFile } from '../securePersistence.ts'
import { paths } from '../config.ts'
import type { VerifyResult } from './outcomes.ts'

/**
 * Does carrying a lesson actually make runs go better?
 *
 * Lessons are injected into every briefing unconditionally and never checked.
 * `src/autonomy/calibration.ts` proved elia can measure the honesty of its own
 * verdicts; this applies the same discipline to its own memory. Each run records
 * which lessons it saw and how it went; a lesson accrues a with-lesson clean
 * rate that `retireLessons` compares against a control-group baseline — the
 * clean rate of runs that did NOT see that lesson, not the project-wide rate
 * (which would itself be contaminated by exposure, since lessons ride along in
 * nearly every briefing). A lesson that has been present for enough runs and
 * measurably moved nothing against that control group is dead weight — every
 * future prompt pays to carry it.
 *
 * Append-only, folded on load — the same shape as `brain/relevance.ts`.
 */

export interface LessonExposureOutcome {
  verify: VerifyResult
  regime?: 'mechanical' | 'empirical' | 'judgment'
  /** The run landed with no tool errors, no failed verification, no contradictions. */
  clean: boolean
  /**
   * Lessons that were selected for this run and then withheld at random (see
   * `renderLessonsWithKeys`). They are the randomized control arm: the only
   * comparison that says whether a lesson *causes* anything, because the runs
   * that saw it and the runs that did not were picked by the same selection.
   *
   * `undefined` means holdout was not running for this run; `[]` means it was
   * and the coin kept everything. Only the second kind belongs in a trial.
   */
  heldOut?: string[]
  /**
   * The selected project lessons that entered the holdout coin. Unlike
   * `lessonKeys`, this excludes user rules and machine lessons that were never
   * randomized, so aggregate lift can use a real treatment size.
   */
  trialKeys?: string[]
}

interface ExposureRecord {
  at: number
  corr: string
  lessonKeys: string[]
  heldOutKeys?: string[]
  trialKeys?: string[]
  verify: VerifyResult
  regime?: LessonExposureOutcome['regime']
  clean: boolean
}

/** Only a completed check can measure a lesson; no-check and judgment-only runs are not trial evidence. */
function independentlyMeasured(record: Pick<ExposureRecord, 'verify' | 'regime'>): boolean {
  return (record.verify === 'pass' || record.verify === 'fail') && record.regime !== 'judgment'
}

export interface EfficacyCounts {
  exposures: number
  cleanRuns: number
  verifyPasses: number
}

/**
 * Below this, a lesson's with-lesson rate is too noisy to act on.
 *
 * Raised from 5: at 5 exposures a single bad run swings the rate by 20
 * points, and `retireLessons` used to pair that with a hard `lift <= 0` cutoff
 * — enough for one unlucky run to delete a lesson. 15 halves the standard
 * error of a proportion at p≈0.5 relative to 5 (√(0.25/5) ≈ 0.22 vs
 * √(0.25/15) ≈ 0.13), and `retireLessons` additionally requires the lift to
 * clear a confidence margin, not just be non-positive.
 */
export const MIN_EXPOSURES = 15

const EFFICACY_PATH = paths.lessonsEfficacy

/** Record that a run saw these lessons, and how the run turned out. Never throws. */
export function recordLessonExposure(
  corr: string,
  lessonKeys: string[],
  outcome: LessonExposureOutcome,
  path = EFFICACY_PATH,
): void {
  const heldOut = outcome.heldOut
  if (lessonKeys.length === 0 && (heldOut?.length ?? 0) === 0) return
  try {
    const record: ExposureRecord = {
      at: Date.now(),
      corr,
      lessonKeys,
      ...(heldOut ? { heldOutKeys: heldOut } : {}),
      ...(outcome.trialKeys ? { trialKeys: outcome.trialKeys } : {}),
      verify: outcome.verify,
      regime: outcome.regime,
      clean: outcome.clean,
    }
    appendSecureFile(path, `${JSON.stringify(record)}\n`)
  } catch {
    // A lost exposure line costs a data point, not correctness.
  }
}

/** Shared line-parsing for the append-only exposure log — every reader below folds over this. */
function readExposureRecords(path: string): ExposureRecord[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0)
  } catch {
    return []
  }
  const records: ExposureRecord[] = []
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as ExposureRecord
      if (Array.isArray(record.lessonKeys)) records.push(record)
    } catch {
      // A corrupt line costs one data point, not the rest of the log.
    }
  }
  return records
}

export function loadEfficacy(path = EFFICACY_PATH): Map<string, EfficacyCounts> {
  const counts = new Map<string, EfficacyCounts>()
  for (const record of readExposureRecords(path)) {
    for (const key of record.lessonKeys) {
      const entry = counts.get(key) ?? { exposures: 0, cleanRuns: 0, verifyPasses: 0 }
      entry.exposures += 1
      if (record.clean) entry.cleanRuns += 1
      if (record.verify === 'pass') entry.verifyPasses += 1
      counts.set(key, entry)
    }
  }
  return counts
}

/**
 * The `corr` ids (turn/run correlation ids — the same ids `outcomes.jsonl`
 * records under `TurnOutcome.corr`) of every run that had this lesson injected
 * into its briefing.
 *
 * This is what makes a true control-group baseline possible: lessons are
 * injected into nearly every briefing, so the project-wide clean rate is
 * mostly measuring runs that also had the lesson — comparing a lesson's
 * with-lesson rate against that biases the lift toward zero for exactly the
 * lessons that are injected most broadly. Excluding these corrs from the
 * baseline (see `retireLessons`) fixes that.
 */
export function exposedCorrs(key: string, path = EFFICACY_PATH): Set<string> {
  const out = new Set<string>()
  for (const record of readExposureRecords(path)) {
    if (record.lessonKeys.includes(key)) out.add(record.corr)
  }
  return out
}

/**
 * How much better runs go with this lesson present, versus the project baseline.
 * `undefined` when there is not enough evidence yet (fewer than `MIN_EXPOSURES`).
 */
export function lessonLift(key: string, counts: Map<string, EfficacyCounts>, baselineCleanRate: number): number | undefined {
  const entry = counts.get(key)
  if (!entry || entry.exposures < MIN_EXPOSURES) return undefined
  return entry.cleanRuns / entry.exposures - baselineCleanRate
}

/**
 * Held-out runs a lesson needs before its randomized lift is trusted. Lower
 * than `MIN_EXPOSURES` because the held-out arm is deliberately the small one
 * (see `DEFAULT_LESSON_HOLDOUT_RATE` in lessons.ts) — the standard error below carries
 * the uncertainty, this only keeps a handful of runs from being read at all.
 */
export const MIN_HELD_OUT = 8

/** One-tailed ~95%: a lift must clear this many standard errors to count. */
export const TRIAL_CONFIDENCE_Z = 1.645

export interface LessonTrial {
  shown: { runs: number; clean: number }
  heldOut: { runs: number; clean: number }
  /** clean rate when shown − clean rate when held out. */
  lift: number
  /** Standard error of that difference. */
  se: number
  verdict: 'helps' | 'hurts' | 'unclear'
}

/**
 * Every lesson's randomized trial: shown-vs-withheld among runs that selected it.
 *
 * Unlike `lessonLift`, which compares against runs that never selected the
 * lesson (and so differ in topic, not just in the lesson), both arms here were
 * chosen by the same selection and split only by a coin flip. Only records
 * written while holdout was running carry a control arm; a lesson with fewer than
 * `MIN_HELD_OUT` withheld runs is left out of the map.
 */
export function lessonTrials(path = EFFICACY_PATH): Map<string, LessonTrial> {
  const arms = new Map<string, { shown: { runs: number; clean: number }; heldOut: { runs: number; clean: number } }>()
  const arm = (key: string) => {
    let entry = arms.get(key)
    if (!entry) arms.set(key, (entry = { shown: { runs: 0, clean: 0 }, heldOut: { runs: 0, clean: 0 } }))
    return entry
  }
  for (const record of readExposureRecords(path)) {
    // Only runs that went through the coin flip. A run from before holdout
    // existed (or with it switched off) saw its lessons by selection alone, and
    // mixing it in would bring back exactly the confound this exists to remove.
    if (!Array.isArray(record.heldOutKeys) || !independentlyMeasured(record)) continue
    // New records name the lessons eligible for the coin explicitly. Older
    // records had only project lessons in a trial arm, so preserve them as a
    // compatibility fallback rather than discarding their evidence.
    const shownKeys = Array.isArray(record.trialKeys)
      ? record.lessonKeys.filter((key) => record.trialKeys!.includes(key))
      : record.lessonKeys
    for (const key of shownKeys) {
      const entry = arm(key).shown
      entry.runs += 1
      if (record.clean) entry.clean += 1
    }
    for (const key of record.heldOutKeys ?? []) {
      const entry = arm(key).heldOut
      entry.runs += 1
      if (record.clean) entry.clean += 1
    }
  }

  const trials = new Map<string, LessonTrial>()
  for (const [key, { shown, heldOut }] of arms) {
    if (heldOut.runs < MIN_HELD_OUT || shown.runs < MIN_HELD_OUT) continue
    const p1 = shown.clean / shown.runs
    const p0 = heldOut.clean / heldOut.runs
    const lift = p1 - p0
    // Floor the variance so an arm that happens to be all-clean or all-dirty
    // does not claim a standard error of zero.
    const variance = (p: number, n: number) => Math.max(p * (1 - p), 1 / (4 * n)) / n
    const se = Math.sqrt(variance(p1, shown.runs) + variance(p0, heldOut.runs))
    const verdict = lift > TRIAL_CONFIDENCE_Z * se ? 'helps' : lift < -TRIAL_CONFIDENCE_Z * se ? 'hurts' : 'unclear'
    trials.set(key, { shown, heldOut, lift, se, verdict })
  }
  return trials
}

/** One-line efficacy summary for `/lessons` / `/brain`. */
export function renderEfficacyLine(baselineCleanRate: number, path = EFFICACY_PATH): string {
  const counts = loadEfficacy(path)
  if (counts.size === 0) return 'Lesson efficacy: no exposures recorded yet.'
  let judged = 0
  let deadWeight = 0
  for (const key of counts.keys()) {
    const lift = lessonLift(key, counts, baselineCleanRate)
    if (lift === undefined) continue
    judged += 1
    if (lift <= 0) deadWeight += 1
  }
  const trials = [...lessonTrials(path).values()]
  const helps = trials.filter((trial) => trial.verdict === 'helps').length
  const hurts = trials.filter((trial) => trial.verdict === 'hurts').length
  const randomized = trials.length === 0
    ? ' No lesson has a randomized trial yet.'
    : ` Randomized trials: ${trials.length} judged, ${helps} proven to help, ${hurts} proven to hurt.`
  return `Lesson efficacy: ${judged} lesson(s) have enough exposures to judge, ${deadWeight} showing no lift.${randomized}`
}

/**
 * Where the lessons in the store stand in their randomized trials: how many
 * are proven to help, proven to hurt (these should already have been retired),
 * or still unproven. Unproven is the honest default — a lesson is never
 * counted as helping without a trial that says so.
 */
export function lessonStanding(keys: readonly string[], trials: Map<string, LessonTrial>): { helps: number; hurts: number; unproven: number } {
  let helps = 0
  let hurts = 0
  for (const key of keys) {
    const verdict = trials.get(key)?.verdict
    if (verdict === 'helps') helps += 1
    else if (verdict === 'hurts') hurts += 1
  }
  return { helps, hurts, unproven: keys.length - helps - hurts }
}
