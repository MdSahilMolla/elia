import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { appendSecureFile, ensureSecureDirectory, hardenSecureFile } from '../securePersistence.ts'
import { paths } from '../config.ts'
import type { Tool } from '../tools/types.ts'

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
}

const MAX_INJECTED_LESSONS = 25

export function appendLessons(texts: string[], path = paths.lessons): void {
  const cleaned = texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => text.length > 0)
  if (cleaned.length === 0) return

  const existing = new Set(loadLessons(path).map((lesson) => lesson.text.toLowerCase()))
  const fresh = cleaned.filter((text) => !existing.has(text.toLowerCase()))
  if (fresh.length === 0) return

  const stamp = new Date().toISOString()
  const block = fresh.map((text) => `- ${text} <!-- ${stamp} -->`).join('\n')

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
        const stampMatch = line.match(/<!--\s*(\S+)\s*-->/)
        const at = stampMatch?.[1] ? Date.parse(stampMatch[1]) : Number.NaN
        return {
          at: Number.isNaN(at) ? 0 : at,
          text: line.replace(/<!--.*?-->/g, '').replace(/^\s*-\s*/, '').trim(),
        }
      })
      .filter((lesson) => lesson.text.length > 0)
  } catch {
    return []
  }
}

/** The most recent lessons, formatted for injection into a planner's briefing. */
export function renderLessons(path = paths.lessons): string {
  const lessons = loadLessons(path).slice(-MAX_INJECTED_LESSONS)
  if (lessons.length === 0) return ''
  return `\n\n## What earlier runs learned about this project\n${lessons.map((lesson) => `- ${lesson.text}`).join('\n')}`
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
    async execute(input) {
      const lessons = Array.isArray(input.lessons)
        ? input.lessons.filter((lesson): lesson is string => typeof lesson === 'string')
        : []
      appendLessons(lessons)
      return `Recorded ${lessons.length} lesson(s) for future sessions in this project.`
    },
  }
}
