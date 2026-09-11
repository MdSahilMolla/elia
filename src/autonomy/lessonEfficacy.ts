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
}

interface ExposureRecord extends LessonExposureOutcome {
  at: number
  corr: string
  lessonKeys: string[]
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
  if (lessonKeys.length === 0) return
  try {
    const record: ExposureRecord = { at: Date.now(), corr, lessonKeys, verify: outcome.verify, regime: outcome.regime, clean: outcome.clean }
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
  return `Lesson efficacy: ${judged} lesson(s) have enough exposures to judge, ${deadWeight} showing no lift.`
}
