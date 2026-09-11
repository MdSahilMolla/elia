import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { appendSecureFile, ensureSecureDirectory, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'
import { paths } from '../config.ts'
import type { Tool } from '../tools/types.ts'
import { loadEfficacy, lessonLift } from './lessonEfficacy.ts'

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

export function consumeInjectedLessonKeys(): string[] {
  const keys = lastInjectedLessonKeys
  lastInjectedLessonKeys = []
  return keys
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
  if (lesson.source) meta.push(`source=${lesson.source}`)
  if (typeof lesson.confidence === 'number') meta.push(`confidence=${lesson.confidence.toFixed(2)}`)
  return `- ${lesson.text} <!-- ${meta.join(' ')} -->`
}

export function appendLessons(texts: Array<string | LessonWrite>, path = paths.lessons): void {
  const cleaned = normalizeLessonInput(texts)
  if (cleaned.length === 0) return

  const existing = new Set(loadLessons(path).map((lesson) => lesson.text.toLowerCase()))
  const fresh = cleaned.filter((lesson) => !existing.has(lesson.text.toLowerCase()))
  if (fresh.length === 0) return

  const stamp = new Date().toISOString()
  const block = fresh.map((lesson) => formatLessonLine(lesson, stamp)).join('\n')

  try {
    ensureSecureDirectory(dirname(path))
    const header = existsSync(path) ? '' : '# Lessons\n\nThings elia learned about this project, carried into future runs.\n\n'
    appendSecureFile(path, `${header}${block}\n`)
  } catch {
    // Losing a lesson costs future efficiency, not this run's correctness.
  }
}

export function loadLessons(path = paths.lessons): Lesson[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('- '))
      .map((line) => {
        const stampMatch = line.match(/<!--\s*([^>]+?)\s*-->/)
        const meta = stampMatch?.[1] ?? ''
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
        const text = line.replace(/<!--.*?-->/g, '').replace(/^\s*-\s*/, '').trim()
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
 * The most recent lessons, formatted for injection into a planner's briefing,
 * together with their keys — so the caller can record which lessons a run saw.
 * Also stashes the keys module-locally for the interactive path (see
 * `consumeInjectedLessonKeys`).
 */
export function renderLessonsWithKeys(path = paths.lessons): { text: string; keys: string[] } {
  const lessons = loadLessons(path).slice(-MAX_INJECTED_LESSONS)
  lastInjectedLessonKeys = lessons.map((lesson) => lesson.key ?? lessonKey(lesson.text))
  if (lessons.length === 0) return { text: '', keys: [] }
  const text = `\n\n## What earlier runs learned about this project\n${lessons
    .map((lesson) => {
      const bits = [lesson.text]
      if (lesson.source) bits.push(`(source: ${lesson.source})`)
      if (typeof lesson.confidence === 'number') bits.push(`(confidence: ${lesson.confidence.toFixed(2)})`)
      return `- ${bits.join(' ')}`
    })
    .join('\n')}`
  return { text, keys: lastInjectedLessonKeys }
}

/** The most recent lessons, formatted for injection into a planner's briefing. */
export function renderLessons(path = paths.lessons): string {
  return renderLessonsWithKeys(path).text
}

/** Ceiling on how much of the file one retirement pass may remove — a runaway signal, not a cleanup. */
const RETIRE_MAX_SHRINK = 0.6

export interface RetireResult {
  retired: string[]
  kept: number
  skippedReason?: string
}

/**
 * Drop lessons that have been carried into enough runs to judge and have not
 * measurably helped.
 *
 * A lesson is injected into every briefing whether or not it earns its tokens.
 * `lessonLift` compares how runs went with a lesson present against the project
 * baseline; a lesson with `MIN_EXPOSURES`+ exposures and non-positive lift is
 * dead weight. Deterministic — no model call — and it refuses to remove more
 * than `RETIRE_MAX_SHRINK` of the file at once.
 */
export function retireLessons(
  baselineCleanRate: number,
  options: { lessonsPath?: string; efficacyPath?: string } = {},
): RetireResult {
  const lessonsPath = options.lessonsPath ?? paths.lessons
  const lessons = loadLessons(lessonsPath)
  if (lessons.length === 0) return { retired: [], kept: 0 }

  const counts = loadEfficacy(options.efficacyPath)

  const dead = new Set<string>()
  for (const lesson of lessons) {
    const key = lesson.key ?? lessonKey(lesson.text)
    const lift = lessonLift(key, counts, baselineCleanRate)
    if (lift !== undefined && lift <= 0) dead.add(key)
  }
  if (dead.size === 0) return { retired: [], kept: lessons.length }
  if (dead.size / lessons.length > RETIRE_MAX_SHRINK) {
    return { retired: [], kept: lessons.length, skippedReason: `would remove ${dead.size}/${lessons.length} lessons — over the ${Math.round(RETIRE_MAX_SHRINK * 100)}% ceiling` }
  }

  const kept = lessons.filter((lesson) => !dead.has(lesson.key ?? lessonKey(lesson.text)))
  const retired = lessons.filter((lesson) => dead.has(lesson.key ?? lessonKey(lesson.text))).map((lesson) => lesson.text)
  rewriteLessons(kept, lessonsPath)
  return { retired, kept: kept.length }
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
