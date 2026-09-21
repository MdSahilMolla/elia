import { dirname, join } from 'node:path'
import { readLibrary, recordReuse, registerArtifact, type Artifact, type Check } from './library.ts'

/**
 * Lessons, admitted the way §5 says library artifacts must be.
 *
 * A lesson is a claim a model made about a project, and it goes into every
 * later prompt. Before this, the only check on that claim was a text filter
 * that ran on one of the four paths lessons are written from — the interactive
 * reflection pass. An autonomous run's lessons, `note_lesson`, and a repair
 * loop's deterministic facts went in unchecked, which is how "create a
 * placeholder if the import is missing" reached a run and made it fabricate.
 *
 * Now every lesson written through `appendLessons` is registered in the
 * certified library with the checks its origin can honestly claim:
 *
 * - `lesson-hygiene` (family `lint`): the text is not generic advice and does
 *   not tell a future run to fabricate what is missing. A lesson that fails it
 *   is quarantined and never injected.
 * - execution evidence (family `execution`), only when the lesson came from
 *   somewhere a check actually ran: the loop's own counters, a run whose
 *   mechanical or empirical verification passed, a failing check a repair put
 *   right.
 * - a randomized trial verdict (family `trial`), added later by the audit when
 *   the holdout arm proves the lesson helps.
 *
 * Two independent families admit a lesson; one leaves it on probation, where it
 * is still injected but ranked behind admitted lessons — that ranking is the
 * σ > 1 of Theorem 1, the reuse advantage without which no leap size is safe.
 */

const GENERIC_ADVICE = /\b(?:carefully|double[-\s]?check|be careful|pay attention|make sure to test|always test|best practice|good practice)\b/i

/**
 * A lesson that tells the next run to paper over something missing — "create a
 * placeholder file if the import does not exist", "mkdir the folder first so
 * `dir` stops failing". The reflection model reaches for these whenever a read
 * came back "not found", and every later prompt then carries an instruction to
 * fabricate. Seen live: one such lesson was in context when a run asked to
 * "install ponytail skill" searched twice, found nothing, and wrote a stub whose
 * only content logged "Ponytail skill installed", plus a barrel to export it.
 * A missing thing is a finding to report, never a gap to fill.
 */
const FABRICATES_MISSING = [
  /\b(?:placeholder|stub|dummy|empty module|fake)\b/i,
  /\bcreate\b.*?\b(?:if|when|so that|to avoid)\b.*?\b(?:missing|absent|does not exist|doesn't exist|not found|not exist)\b/i,
]

/** Why a lesson should not be carried, or `undefined` when it is fit to. */
export function lessonHygieneProblem(text: string): string | undefined {
  const lesson = text.replace(/\s+/g, ' ').trim()
  if (GENERIC_ADVICE.test(lesson)) return 'generic advice, not a fact about this project'
  if (FABRICATES_MISSING.some((pattern) => pattern.test(lesson))) return 'tells a future run to fabricate what is missing'
  return undefined
}

export function lessonArtifactId(key: string): string {
  return `lesson:${key}`
}

/** The library lives beside the lessons file it certifies, so a test's lessons never reach the real one. */
export function lessonLibraryPath(lessonsPath: string): string {
  return join(dirname(lessonsPath), 'vde', 'library.jsonl')
}

/** The check a lesson's origin can honestly claim, if any. Unknown and opinion-only origins claim none. */
export function evidenceForSource(source: string | undefined, at = Date.now()): Check | undefined {
  switch (source) {
    case 'auto-deterministic':
      return { verifier: 'loop-observation', tier: 'exact', family: 'execution', passed: true, at, detail: 'counted from the run\'s own repair record' }
    case 'auto-mechanical':
      return { verifier: 'run-verification', tier: 'exact', family: 'execution', passed: true, at, detail: 'the run\'s tests or typecheck passed' }
    case 'auto-empirical':
      return { verifier: 'run-verification', tier: 'empirical', family: 'execution', passed: true, at, detail: 'the run\'s rendered artifact was observed' }
    case 'interactive-auto':
      return { verifier: 'repaired-check', tier: 'exact', family: 'execution', passed: true, at, detail: 'a failing check was put right' }
    case 'user':
      return { verifier: 'human', tier: 'critic', family: 'human', passed: true, at }
    default:
      return undefined
  }
}

export interface LessonToCertify {
  text: string
  key: string
  source?: string
}

/** Registers lessons in the library with the checks their origin earns. Never throws. */
export function certifyLessons(lessons: readonly LessonToCertify[], lessonsPath: string): void {
  if (lessons.length === 0) return
  const path = lessonLibraryPath(lessonsPath)
  try {
    const known = readLibrary(path)
    for (const lesson of lessons) {
      const at = Date.now()
      const problem = lessonHygieneProblem(lesson.text)
      const checks: Check[] = [
        { verifier: 'lesson-hygiene', tier: 'exact', family: 'lint', passed: problem === undefined, at, ...(problem ? { detail: problem } : {}) },
      ]
      const evidence = evidenceForSource(lesson.source, at)
      if (evidence) checks.push(evidence)
      const id = lessonArtifactId(lesson.key)
      known.set(id, registerArtifact({ id, kind: 'lesson', summary: lesson.text, source: lesson.source ?? 'unknown', checks }, path, known))
    }
  } catch {
    // Certification is evidence about a lesson; losing it must not lose the lesson.
  }
}

/**
 * Certifies lessons that predate the library, so the audit covers the whole
 * store: each gets the same hygiene check and origin evidence a new lesson
 * would, and one that fails hygiene is quarantined from then on. Returns how
 * many were newly certified.
 */
export function backfillLessons(lessons: readonly LessonToCertify[], lessonsPath: string): number {
  const known = lessonArtifacts(lessonsPath)
  const missing = lessons.filter((lesson) => !known.has(lesson.key))
  certifyLessons(missing, lessonsPath)
  return missing.length
}

/** Each key's library record, for retrieval to filter and rank by. */
export function lessonArtifacts(lessonsPath: string): Map<string, Artifact> {
  const byKey = new Map<string, Artifact>()
  try {
    for (const artifact of readLibrary(lessonLibraryPath(lessonsPath)).values()) {
      if (artifact.kind === 'lesson' && artifact.id.startsWith('lesson:')) byKey.set(artifact.id.slice('lesson:'.length), artifact)
    }
  } catch {
    // An unreadable library certifies nothing and blocks nothing.
  }
  return byKey
}

/** Records that these lessons were handed to a model — the reuse σ is measured over. */
export function recordLessonReuse(keys: readonly string[], lessonsPath: string): void {
  try {
    recordReuse(keys.map(lessonArtifactId), lessonLibraryPath(lessonsPath))
  } catch {
    // Reuse is a measurement, never a precondition.
  }
}
