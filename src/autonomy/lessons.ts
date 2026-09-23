import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { appendSecureFile, ensureSecureDirectory, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'
import { paths } from '../config.ts'
import type { Tool } from '../tools/types.ts'
import { exposedCorrs, lessonTrials, loadEfficacy, MIN_EXPOSURES, type LessonTrial } from './lessonEfficacy.ts'
import { certifyLessons, lessonArtifactId, lessonArtifacts, lessonLibraryPath, recordLessonReuse } from './lessonCertificates.ts'
import { purgeArtifact, registerArtifact, retrievable } from './certifiedLibrary.ts'
import { rankBm25 } from '../bm25.ts'
import { globalLessonsPath, partitionByScope } from './lessonScope.ts'
import { competenceReport } from './outcomes.ts'

/**
 * What elia learned the hard way, carried across runs.
 *
 * Sessions are amnesiac by default: elia rediscovers that this project's tests
 * need a particular flag, or that a certain module is generated and must not be
 * edited by hand, every single time. Lessons are the fix — written at the end of
 * a run, injected at the start of the next one. Only durable, project-specific
 * facts belong here, which is why they're captured after verification rather
 * than while the model is still guessing.
 */

export interface Lesson {
  at: number
  text: string
  /** Where the lesson came from — run id, interactive, auto-repair, etc. */
  source?: string
  /** 0–1 confidence; omitted means unknown / legacy. */
  confidence?: number
  /**
   * Content-addressed identity, derived on read (not stored in the file). Joins
   * a lesson to its rows in `.elia/lessons-efficacy.jsonl` so we can tell whether
   * carrying it actually helps. Same formula as `brain/store.ts` `keyHash`.
   */
  key?: string
}

/** Stable identity for a lesson from its text alone. */
export function lessonKey(text: string): string {
  return Bun.hash(text.replace(/\s+/g, ' ').trim().toLowerCase()).toString(36)
}

const MAX_INJECTED_LESSONS = 25

const PROJECT_HEADING = '# Lessons\n\nThings elia learned about this project, carried into future runs.\n\n'
const GLOBAL_HEADING = '# Lessons about this machine\n\nEnvironment facts elia learned that hold across every project here.\n\n'

/**
 * Global lessons never exceed this share of the injection budget. They are
 * about the machine, so they are relevant everywhere and would otherwise crowd
 * out the project's own hard-won facts on every turn in every repository.
 */
const MAX_INJECTED_GLOBAL = 5

/**
 * The keys of the lessons injected into the most recent briefing.
 *
 * Threading these out through every call frame between `renderLessons` (deep in
 * prompt assembly) and the outcome record (the turn's `finally` block) would
 * touch a dozen signatures. elia runs one turn at a time in one process, so a
 * module-local set that the injector fills and the recorder drains is enough —
 * and it is the same shape the autonomous loop passes explicitly through run
 * scope.
 */
let lastInjectedLessonKeys: string[] = []
let lastHeldOutLessonKeys: string[] | undefined

export function consumeInjectedLessonKeys(): string[] {
  const keys = lastInjectedLessonKeys
  lastInjectedLessonKeys = []
  return keys
}

/**
 * The lessons the most recent briefing selected and then withheld — drained
 * like the injected set. `undefined` when holdout was not running for it, so
 * the recorder can keep that run out of the randomized trial.
 */
export function consumeHeldOutLessonKeys(): string[] | undefined {
  const keys = lastHeldOutLessonKeys
  lastHeldOutLessonKeys = undefined
  return keys
}

/**
 * Chance that a selected project lesson is withheld from a briefing.
 *
 * Without this, nothing can say whether a lesson helps: lessons are chosen by
 * recency and topic, so the runs that saw one differ from the runs that did not
 * in what they were about, not only in the lesson. Withholding a random slice of
 * the *selected* lessons gives each one a control arm split by a coin flip —
 * `lessonTrials` compares the two. 15% keeps the cost small (a withheld lesson
 * is one this run might have wanted) while a lesson selected on most turns still
 * gathers a usable control arm within a few dozen runs.
 *
 * `ELIA_LESSON_HOLDOUT` overrides it (0 turns holdout off; capped at 0.5).
 * Machine-level lessons are never withheld: they are what keeps commands
 * working on this machine at all, and one missing costs a broken run.
 */
export const DEFAULT_LESSON_HOLDOUT_RATE = 0.15

export function lessonHoldoutRate(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ELIA_LESSON_HOLDOUT
  if (raw === undefined || raw.trim() === '') return DEFAULT_LESSON_HOLDOUT_RATE
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, 0.5)
}

export interface LessonWrite {
  text: string
  source?: string
  confidence?: number
}

function normalizeLessonInput(texts: Array<string | LessonWrite>): LessonWrite[] {
  return texts
    .map((entry) => {
      if (typeof entry === 'string') return { text: entry.replace(/\s+/g, ' ').trim() }
      return {
        text: entry.text.replace(/\s+/g, ' ').trim(),
        source: entry.source?.replace(/\s+/g, ' ').trim() || undefined,
        confidence:
          typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
            ? Math.min(1, Math.max(0, entry.confidence))
            : undefined,
      }
    })
    .filter((entry) => entry.text.length > 0)
}

function formatLessonLine(lesson: LessonWrite, stamp: string): string {
  const meta = [`${stamp}`]
  // The source lives inside the metadata comment, so it must not be able to close it.
  if (lesson.source) meta.push(`source=${lesson.source.replace(/<!--|-->/g, '').replace(/\s+/g, '-')}`)
  if (typeof lesson.confidence === 'number') meta.push(`confidence=${lesson.confidence.toFixed(2)}`)
  return `- ${lesson.text} <!-- ${meta.join(' ')} -->`
}

function writeLessonBlock(lessons: LessonWrite[], path: string, heading: string): void {
  if (lessons.length === 0) return
  const stamp = new Date().toISOString()
  const block = lessons.map((lesson) => formatLessonLine(lesson, stamp)).join('\n')
  try {
    ensureSecureDirectory(dirname(path))
    const header = existsSync(path) ? '' : heading
    appendSecureFile(path, `${header}${block}\n`)
  } catch {
    // Losing a lesson costs future efficiency, not this run's correctness.
  }
}

/**
 * Writes lessons, sending the ones about *this machine* to the global store
 * rather than this project's.
 *
 * A fact about the environment — that `ls` is not a command here, that a
 * toolchain needs a particular target — is true of every repository on this
 * machine, but lessons lived only in each project's `.elia/lessons.md`, so it
 * was learned painfully in one repo and unavailable in the next, where it was
 * learned painfully again.
 *
 * `globalPath` defaults to the real global store only when writing to the real
 * project store. A caller that passes its own `path` (every test does) keeps
 * everything in that one file unless it asks otherwise — so no test can write
 * into the operator's home directory by omission.
 */
export function appendLessons(
  texts: Array<string | LessonWrite>,
  path = paths.lessons,
  globalPath = path === paths.lessons ? globalLessonsPath() : path,
): void {
  const cleaned = normalizeLessonInput(texts)
  if (cleaned.length === 0) return

  const seen = new Set(
    [...loadLessons(path), ...(globalPath === path ? [] : loadLessons(globalPath))].map((lesson) => lesson.text.toLowerCase()),
  )
  const fresh = cleaned.filter((lesson) => !seen.has(lesson.text.toLowerCase()))
  if (fresh.length === 0) return

  // Every lesson enters the certified library with the checks its origin can
  // claim; one that fails hygiene is written but quarantined, so it is on
  // record and never injected. See lessonCertificates.ts.
  certifyLessons(
    fresh.map((lesson) => ({ text: lesson.text, key: lessonKey(lesson.text), ...(lesson.source ? { source: lesson.source } : {}) })),
    path,
  )

  if (globalPath === path) {
    writeLessonBlock(fresh, path, PROJECT_HEADING)
    return
  }
  const { project, environment } = partitionByScope(fresh)
  writeLessonBlock(project, path, PROJECT_HEADING)
  writeLessonBlock(environment, globalPath, GLOBAL_HEADING)
}

/** Split `- <text> <!-- <meta> -->` into its text and trailing metadata. */
function splitLessonLine(line: string): { text: string; meta: string } {
  const body = line.replace(/^\s*-\s*/, '').trimEnd()
  const open = body.lastIndexOf('<!--')
  if (!body.endsWith('-->') || open === -1 || open + 4 > body.length - 3) return { text: body.trim(), meta: '' }
  return { text: body.slice(0, open).trim(), meta: body.slice(open + 4, -3).trim() }
}

export function loadLessons(path = paths.lessons): Lesson[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('- '))
      .map((line) => {
        // The metadata comment is the one formatLessonLine appends at the very
        // end. Parse only that — the first `<!--` on the line used to be taken
        // for it, so a lesson whose own text mentioned an HTML comment lost its
        // timestamp (`at` fell to 0) and had part of its text cut out.
        const { text, meta } = splitLessonLine(line)
        const parts = meta.split(/\s+/).filter(Boolean)
        const at = parts[0] ? Date.parse(parts[0]) : Number.NaN
        let source: string | undefined
        let confidence: number | undefined
        for (const part of parts.slice(1)) {
          if (part.startsWith('source=')) source = part.slice('source='.length) || undefined
          if (part.startsWith('confidence=')) {
            const value = Number.parseFloat(part.slice('confidence='.length))
            if (Number.isFinite(value)) confidence = Math.min(1, Math.max(0, value))
          }
        }
        return {
          at: Number.isNaN(at) ? 0 : at,
          text,
          source,
          confidence,
          key: lessonKey(text),
        }
      })
      .filter((lesson) => lesson.text.length > 0)
  } catch {
    return []
  }
}

const LESSONS_HEADER = '# Lessons\n\nThings elia learned about this project, carried into future runs.\n\n'

/**
 * Replaces the whole lessons file with a curated set — used only by the brain's
 * consolidation pass (brain/consolidate.ts), which merges near-duplicates and
 * drops lessons that have gone stale. Each lesson keeps its original timestamp
 * so recency ordering survives the rewrite.
 */
export function rewriteLessons(lessons: Lesson[], path = paths.lessons): void {
  try {
    const body = lessons
      .map((lesson) =>
        formatLessonLine(
          { text: lesson.text.replace(/\s+/g, ' ').trim(), source: lesson.source, confidence: lesson.confidence },
          new Date(lesson.at || Date.now()).toISOString(),
        ),
      )
      .join('\n')
    writeSecureFile(path, body ? `${LESSONS_HEADER}${body}\n` : LESSONS_HEADER)
  } catch {
    // Consolidation is best-effort; the existing file staying in place is safe.
  }
}

/**
 * How many of the newest lessons go in unconditionally, before relevance picks
 * the rest.
 *
 * Not arbitrary, and not just a safety net. Exposure is what
 * `lessonEfficacy`/`retireLessons` measure against a control group of runs that
 * did *not* see a lesson, so *which* lessons get injected decides what that
 * statistic means. Keeping the newest slice unconditional keeps their exposure
 * pattern exactly as it was, so efficacy data already on disk stays comparable;
 * the relevance-picked remainder only ever reaches lessons that under pure
 * recency were never injected at all past the ceiling, and therefore have no
 * efficacy history to invalidate. Their exposure does become topic-correlated,
 * which is a real confound for their lift — but a confounded signal on a lesson
 * that could never be measured before is strictly more than none.
 */
const RECENCY_FLOOR = 10

/** Lessons in file order, so the injected block reads chronologically however members were chosen. */
function inFileOrder(all: Lesson[], chosen: Set<Lesson>): Lesson[] {
  return all.filter((lesson) => chosen.has(lesson))
}

/**
 * The lessons to inject for a turn: the newest `RECENCY_FLOOR`, plus whatever
 * else is most relevant to `query`, up to `MAX_INJECTED_LESSONS`.
 *
 * Pure recency capped compounding at a fixed horizon — past 25 lessons the most
 * relevant one in the store silently stopped being injected because it was old,
 * while 25 unrelated recent ones took the whole budget. The store kept growing
 * and recall did not improve. BM25 is already how `recall` and `brain` search
 * rank; lessons were the one consumer that did not use it.
 */
/**
 * How much more a certified lesson's relevance counts than an uncertified one's
 * when the two compete for the relevance-picked slots. This is σ in Theorem 1
 * of the discovery-engine paper: without a reuse advantage for sound artifacts
 * no leap size is safe, because nothing in retrieval pushes back against the
 * unsound ones. Kept modest — a certified lesson on the wrong topic should still
 * lose to an uncertified one on the right topic.
 */
export const CERTIFIED_REUSE_ADVANTAGE = 1.5

function selectLessons(all: Lesson[], query: string, certified: ReadonlySet<string> = new Set()): Lesson[] {
  if (all.length <= MAX_INJECTED_LESSONS) return all
  const recent = all.slice(-RECENCY_FLOOR)
  const chosen = new Set(recent)
  const budget = MAX_INJECTED_LESSONS - chosen.size
  if (budget <= 0 || !query.trim()) return inFileOrder(all, new Set(all.slice(-MAX_INJECTED_LESSONS)))

  const older = all.slice(0, -RECENCY_FLOOR)
  const byId = new Map(older.map((lesson, index) => [String(index), lesson]))
  const ranked = rankBm25(older.map((lesson, index) => ({ id: String(index), text: lesson.text })), query)
    .map((hit) => {
      const lesson = byId.get(hit.id)
      const boost = lesson && certified.has(lesson.key ?? lessonKey(lesson.text)) ? CERTIFIED_REUSE_ADVANTAGE : 1
      return { ...hit, score: hit.score * boost }
    })
    .sort((a, b) => b.score - a.score)
  for (const hit of ranked) {
    if (chosen.size >= MAX_INJECTED_LESSONS) break
    const lesson = byId.get(hit.id)
    if (lesson) chosen.add(lesson)
  }
  // Nothing matched the query — fall back to recency for the remaining budget
  // rather than injecting fewer lessons than the budget allows.
  if (chosen.size < MAX_INJECTED_LESSONS) {
    for (const lesson of older.slice(-(MAX_INJECTED_LESSONS - chosen.size))) chosen.add(lesson)
  }
  return inFileOrder(all, chosen)
}

/**
 * The lessons most worth this turn, formatted for injection into a planner's
 * briefing, together with their keys — so the caller can record which lessons a
 * run saw. Also stashes the keys module-locally for the interactive path (see
 * `consumeInjectedLessonKeys`).
 *
 * `query` is what the turn is about; without one this falls back to pure
 * recency, so a caller with no query behaves exactly as before.
 *
 * Machine-level lessons from the global store are injected alongside the
 * project's own, capped at `MAX_INJECTED_GLOBAL`: they are true everywhere, so
 * without a cap they would crowd out the project's hard-won facts on every turn
 * in every repository. `globalPath` follows the same rule as `appendLessons` —
 * the real global store only when reading the real project store, so a test
 * passing its own path never reaches the operator's home directory.
 */
export function renderLessonsWithKeys(
  query = '',
  path = paths.lessons,
  globalPath = path === paths.lessons ? globalLessonsPath() : undefined,
  holdout: { rate: number; random?: () => number } = { rate: path === paths.lessons ? lessonHoldoutRate() : 0 },
): { text: string; keys: string[]; heldOut: string[] } {
  // Quarantined and purged lessons never reach a model; lessons that predate
  // the certified library have no record and stay usable.
  const certificates = lessonArtifacts(path)
  const usable = loadLessons(path).filter((lesson) => retrievable(certificates.get(lesson.key ?? lessonKey(lesson.text))))
  const certified = new Set([...certificates].filter(([, artifact]) => artifact.status === 'admitted').map(([key]) => key))
  const selected = selectLessons(usable, query, certified)
  const random = holdout.random ?? Math.random
  const project: Lesson[] = []
  const heldOut: string[] = []
  for (const lesson of selected) {
    if (holdout.rate > 0 && random() < holdout.rate) heldOut.push(lesson.key ?? lessonKey(lesson.text))
    else project.push(lesson)
  }
  const global = globalPath && globalPath !== path ? selectLessons(loadLessons(globalPath), query).slice(-MAX_INJECTED_GLOBAL) : []
  // Machine facts first: they constrain how a command can be run at all, which
  // is worth knowing before anything specific to this repository.
  const lessons = [...global, ...project]
  lastInjectedLessonKeys = lessons.map((lesson) => lesson.key ?? lessonKey(lesson.text))
  lastHeldOutLessonKeys = holdout.rate > 0 ? heldOut : undefined
  if (lessons.length === 0) return { text: '', keys: [], heldOut }
  recordLessonReuse(lastInjectedLessonKeys, path)
  const text = `\n\n## What earlier runs learned about this project\n${lessons
    .map((lesson) => {
      const bits = [lesson.text]
      if (lesson.source) bits.push(`(source: ${lesson.source})`)
      if (typeof lesson.confidence === 'number') bits.push(`(confidence: ${lesson.confidence.toFixed(2)})`)
      return `- ${bits.join(' ')}`
    })
    .join('\n')}`
  return { text, keys: lastInjectedLessonKeys, heldOut }
}

/** The lessons most worth this turn, formatted for injection into a planner's briefing. */
export function renderLessons(query = '', path = paths.lessons): string {
  return renderLessonsWithKeys(query, path).text
}

/** Ceiling on how much of the file one retirement pass may remove — a runaway signal, not a cleanup. */
const RETIRE_MAX_SHRINK = 0.6

export interface RetireResult {
  retired: string[]
  kept: number
  skippedReason?: string
}

/**
 * A lesson needs at least this many *unexposed* turns to build a control-group
 * baseline before its lift is trusted — below this, "the baseline" is itself
 * too noisy a number to compare against, whatever the lift looks like.
 */
const MIN_CONTROL_SAMPLE = 10

/**
 * One-tailed ~95% z-score: the negative lift must exceed this many standard
 * errors of the (with-lesson rate vs. control rate) difference before a lesson
 * is judged dead weight, rather than merely being non-positive. At small
 * sample sizes a lift of, say, -0.05 is well within noise.
 */
const RETIRE_CONFIDENCE_Z = 1.645

/**
 * Drop lessons that have been carried into enough runs to judge and have not
 * measurably helped.
 *
 * A lesson is injected into every briefing whether or not it earns its tokens,
 * which makes "the project baseline" a contaminated comparison — it mostly
 * measures runs that also had the lesson. So for each lesson this builds a
 * true control-group baseline: the clean rate of runs that were NOT exposed to
 * it (`exposedCorrs` joins back to `outcomes.jsonl` by the same `corr` both
 * logs already record), and only calls a lesson dead weight when its lift
 * below that baseline clears a confidence margin — not merely `<= 0`, which at
 * `MIN_EXPOSURES` runs is well within sampling noise. Deterministic — no model
 * call — and it refuses to remove more than `RETIRE_MAX_SHRINK` of the file at
 * once.
 */
export function retireLessons(
  options: { lessonsPath?: string; efficacyPath?: string; outcomesPath?: string } = {},
): RetireResult {
  const lessonsPath = options.lessonsPath ?? paths.lessons
  const lessons = loadLessons(lessonsPath)
  if (lessons.length === 0) return { retired: [], kept: 0 }

  const counts = loadEfficacy(options.efficacyPath)
  const trials = lessonTrials(options.efficacyPath)

  const dead = new Set<string>()
  const certificates = lessonArtifacts(lessonsPath)
  for (const lesson of lessons) {
    const key = lesson.key ?? lessonKey(lesson.text)
    // A randomized trial outranks the observational comparison below: once a
    // lesson has one, its verdict is the only one that says what the lesson
    // itself did.
    const trial = trials.get(key)
    if (trial) {
      if (trial.verdict === 'hurts') dead.add(key)
      // A trial that proves a lesson helps is the independent check that
      // admits it to the certified library — the audit half of §5.3.
      if (trial.verdict === 'helps' && !certificates.get(key)?.checks.some((check) => check.family === 'trial')) {
        if (!certificates.has(key)) certifyLessons([{ text: lesson.text, key, ...(lesson.source ? { source: lesson.source } : {}) }], lessonsPath)
        certifyTrial(key, lesson, trial, lessonsPath)
      }
      continue
    }
    const entry = counts.get(key)
    if (!entry || entry.exposures < MIN_EXPOSURES) continue

    const excluded = exposedCorrs(key, options.efficacyPath)
    const control = competenceReport(options.outcomesPath, { excludeCorrs: excluded })
    if (control.changingTurns < MIN_CONTROL_SAMPLE) continue // not enough of a control group to trust yet

    const withLessonRate = entry.cleanRuns / entry.exposures
    const lift = withLessonRate - control.cleanRate
    const se = Math.sqrt(
      (withLessonRate * (1 - withLessonRate)) / entry.exposures +
        (control.cleanRate * (1 - control.cleanRate)) / control.changingTurns,
    )
    if (lift < -RETIRE_CONFIDENCE_Z * se) dead.add(key)
  }
  if (dead.size === 0) return { retired: [], kept: lessons.length }
  if (dead.size / lessons.length > RETIRE_MAX_SHRINK) {
    return { retired: [], kept: lessons.length, skippedReason: `would remove ${dead.size}/${lessons.length} lessons — over the ${Math.round(RETIRE_MAX_SHRINK * 100)}% ceiling` }
  }

  const kept = lessons.filter((lesson) => !dead.has(lesson.key ?? lessonKey(lesson.text)))
  const retired = lessons.filter((lesson) => dead.has(lesson.key ?? lessonKey(lesson.text))).map((lesson) => lesson.text)
  rewriteLessons(kept, lessonsPath)
  // A lesson retired for hurting is an unsound artifact the audit caught: the
  // library's slip-rate estimate (ε) is built from exactly these.
  for (const key of dead) {
    try {
      const lesson = lessons.find((candidate) => (candidate.key ?? lessonKey(candidate.text)) === key)
      // A lesson older than the library gets its record first, so the slip it
      // represents is counted rather than lost.
      if (lesson && !certificates.has(key)) certifyLessons([{ text: lesson.text, key, ...(lesson.source ? { source: lesson.source } : {}) }], lessonsPath)
      purgeArtifact(lessonArtifactId(key), 'retired: measured to hurt the runs that carried it', { audit: true, path: lessonLibraryPath(lessonsPath) })
    } catch {
      // The lesson is already gone from the store; the library record is evidence only.
    }
  }
  return { retired, kept: kept.length }
}

function certifyTrial(key: string, lesson: Lesson, trial: LessonTrial, lessonsPath: string): void {
  try {
    const path = lessonLibraryPath(lessonsPath)
    const id = lessonArtifactId(key)
    registerArtifact(
      {
        id,
        kind: 'lesson',
        summary: lesson.text,
        source: lesson.source ?? 'unknown',
        checks: [
          {
            verifier: 'randomized-trial',
            tier: 'empirical',
            family: 'trial',
            passed: true,
            at: Date.now(),
            detail: `clean ${Math.round((trial.shown.clean / trial.shown.runs) * 100)}% shown vs ${Math.round((trial.heldOut.clean / trial.heldOut.runs) * 100)}% withheld`,
          },
        ],
      },
      path,
    )
  } catch {
    // Certification is evidence; the lesson stays in the store either way.
  }
}

function relativeAge(at: number): string {
  if (!at) return ''
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 90) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 90) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 36) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * A boxless listing for `/lessons` — a `✦`-bulleted list newest-first with a
 * relative age, plus a one-line footer explaining what the store is for. The
 * markdown `renderLessons` above is for prompt injection, not the terminal.
 */
export function renderLessonsListing(path = paths.lessons): string {
  const lessons = loadLessons(path)
  if (lessons.length === 0) return 'No lessons recorded for this project yet.'
  const rows = [...lessons]
    .reverse()
    .map((lesson) => {
      const age = relativeAge(lesson.at)
      return `  ✦ ${lesson.text}${age ? `  (${age})` : ''}`
    })
  return [
    `LESSONS · this project · ${lessons.length} kept`,
    '',
    ...rows,
    '',
    '  injected into every planning briefing · consolidated periodically · edit .elia/lessons.md',
  ].join('\n')
}

export interface LessonsCapture {
  tool: Tool
  taken(): string[]
}

/**
 * Captures lessons as a list rather than prose, because they are appended to a
 * file that later runs read verbatim — a paragraph of reflection would pollute
 * every future prompt with things that were only true once.
 */
export function createLessonsTool(): LessonsCapture {
  let captured: string[] = []

  const tool: Tool = {
    name: 'submit_lessons',
    description:
      `Record what a future run in this same project would want to have known before starting.

Only durable facts about *this project*: where something lives, a command that has to be run a particular way, a constraint that is not obvious from the code, a trap you fell into.

The test is whether the sentence will still be true and useful in six months. "The test suite must be run with bun, not node — node cannot resolve the .ts imports" passes. "greet.ts now has a farewell function, do not re-add it" fails: it describes what this run did, and it goes stale the moment anyone edits that file.

Never record what happened in this run, what the code currently contains, praise, or generic engineering advice. Zero lessons is a perfectly good answer — submit an empty list rather than padding it.`,
    input_schema: {
      type: 'object',
      properties: {
        lessons: {
          type: 'array',
          items: { type: 'string' },
          description: 'One sentence each, written as an instruction to a future run',
        },
      },
      required: ['lessons'],
    },
    async execute(input) {
      captured = Array.isArray(input.lessons)
        ? input.lessons.filter((lesson): lesson is string => typeof lesson === 'string')
        : []
      return `Recorded ${captured.length} lesson(s).`
    },
  }

  return {
    tool,
    taken() {
      const lessons = captured
      captured = []
      return lessons
    },
  }
}

/**
 * The same contract as `createLessonsTool`, but it persists immediately instead
 * of buffering for an end-of-run collector — for the interactive loop, which has
 * no single "run end" the way `elia auto` does.
 */
export function createDirectLessonsTool(): Tool {
  const { tool } = createLessonsTool()
  return {
    ...tool,
    name: 'note_lesson',
    input_schema: {
      type: 'object',
      properties: {
        lessons: {
          type: 'array',
          items: { type: 'string' },
          description: 'One sentence each, written as an instruction to a future run',
        },
        source: {
          type: 'string',
          description: 'Optional provenance label (e.g. interactive, repair, user)',
        },
        confidence: {
          type: 'number',
          description: 'Optional 0–1 confidence that the lesson will stay true',
        },
      },
      required: ['lessons'],
    },
    async execute(input) {
      const lessons = Array.isArray(input.lessons)
        ? input.lessons.filter((lesson): lesson is string => typeof lesson === 'string')
        : []
      const source = typeof input.source === 'string' ? input.source : 'interactive'
      const confidence = typeof input.confidence === 'number' ? input.confidence : undefined
      appendLessons(lessons.map((text) => ({ text, source, confidence })))
      return `Recorded ${lessons.length} lesson(s) for future sessions in this project.`
    },
  }
}
