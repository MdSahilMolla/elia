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
 * rate that `retireLessons` compares against the project baseline. A lesson that
 * has been present for enough runs and moved nothing is dead weight — every
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

/** Below this, a lesson's with-lesson rate is too noisy to act on. */
export const MIN_EXPOSURES = 5

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

export function loadEfficacy(path = EFFICACY_PATH): Map<string, EfficacyCounts> {
  const counts = new Map<string, EfficacyCounts>()
  if (!existsSync(path)) return counts
  hardenSecureFile(path)
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0)
  } catch {
    return counts
  }
  for (const line of lines) {
    let record: ExposureRecord
    try {
      record = JSON.parse(line) as ExposureRecord
    } catch {
      continue
    }
    if (!Array.isArray(record.lessonKeys)) continue
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
