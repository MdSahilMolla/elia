import { existsSync, readFileSync } from 'node:fs'
import { writeSecureFile } from '../securePersistence.ts'
import { paths, tierConfig } from '../config.ts'
import type { ContentBlock } from '../providers/types.ts'
import { loadLessons, rewriteLessons, type Lesson } from '../autonomy/lessons.ts'
import { loadNotes, rewriteNotes } from './notes.ts'

/**
 * The reflective pass over elia's second brain.
 *
 * Lessons accrete by exact-text dedupe only, so a project slowly fills with
 * near-duplicates ("run tests with bun" / "the test runner is bun, not node")
 * and lessons that were true once and aren't any more. Left alone, every future
 * prompt pays to carry that. Consolidation is a single cheap fast-tier call
 * that merges the duplicates, drops the stale, and tightens the wording —
 * conservatively: when the model is unsure, the item stays.
 *
 * Runs opportunistically at session start (see index.ts) and on `/brain
 * consolidate`. Never throws; a failed pass leaves every file untouched.
 */

const MIN_ITEMS_TO_CONSOLIDATE = 8
const RECONSOLIDATE_AFTER_MS = 24 * 60 * 60 * 1000
/** Refuse a rewrite that would delete more than this fraction of the lessons — a runaway model, not a consolidation. */
const MAX_SHRINK = 0.6

export interface ConsolidationResult {
  changed: boolean
  reason: string
  lessonsBefore: number
  lessonsAfter: number
  notesRemoved: number
}

const SYSTEM_PROMPT = `You tidy an engineering agent's long-term memory for one project. You are given its LESSONS (durable "know this before you start" facts) and its NOTES (durable facts about how the project and its dependencies behave).

Return ONLY a JSON object, no prose, no fences:
{"lessons": ["..."], "removeNotes": ["<verbatim note text>", "..."]}

"lessons": the full curated lesson list. Merge lessons that say the same thing into one crisp sentence. Drop a lesson only if it is clearly redundant with another, contradicted by another, or obviously transient ("X was just added"). Keep everything else, wording tightened but meaning intact. Preserve the order from most to least important. When in doubt, keep it.

"removeNotes": the exact text of any note that is now fully covered by a lesson or another note, or that is plainly stale. Copy the text verbatim. Empty array if none.

Be conservative. It is much worse to delete a true fact than to leave a near-duplicate.`

function shouldConsolidate(lessonCount: number, noteCount: number, force: boolean, consolidatedAtPath: string): boolean {
  if (force) return true
  if (lessonCount + noteCount < MIN_ITEMS_TO_CONSOLIDATE) return false
  if (!existsSync(consolidatedAtPath)) return true
  try {
    const last = Number.parseInt(readFileSync(consolidatedAtPath, 'utf8').trim(), 10)
    if (!Number.isFinite(last)) return true
    return Date.now() - last > RECONSOLIDATE_AFTER_MS
  } catch {
    return true
  }
}

function parseResponse(raw: string): { lessons: string[]; removeNotes: string[] } | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const lessons = Array.isArray(parsed.lessons) ? parsed.lessons.filter((l): l is string => typeof l === 'string' && l.trim().length > 0) : undefined
    if (!lessons) return undefined
    const removeNotes = Array.isArray(parsed.removeNotes) ? parsed.removeNotes.filter((n): n is string => typeof n === 'string') : []
    return { lessons: lessons.map((l) => l.replace(/\s+/g, ' ').trim()), removeNotes }
  } catch {
    return undefined
  }
}

export interface ConsolidateOptions {
  force?: boolean
  lessonsPath?: string
  notesPath?: string
  consolidatedAtPath?: string
}

export async function consolidateBrain(options: ConsolidateOptions = {}): Promise<ConsolidationResult> {
  const lessonsPath = options.lessonsPath ?? paths.lessons
  const notesPath = options.notesPath ?? paths.brainNotes
  const consolidatedAtPath = options.consolidatedAtPath ?? paths.brainConsolidatedAt

  const lessons = loadLessons(lessonsPath)
  const notes = loadNotes(notesPath)
  const skip = (reason: string): ConsolidationResult => ({ changed: false, reason, lessonsBefore: lessons.length, lessonsAfter: lessons.length, notesRemoved: 0 })

  if (!shouldConsolidate(lessons.length, notes.length, options.force ?? false, consolidatedAtPath)) {
    return skip('nothing to consolidate yet')
  }

  let text = ''
  try {
    const fast = tierConfig('fast')
    const payload = [
      `LESSONS:\n${lessons.map((l, i) => `${i + 1}. ${l.text}`).join('\n') || '(none)'}`,
      `\nNOTES:\n${notes.map((n) => `- ${n.text}`).join('\n') || '(none)'}`,
    ].join('\n')
    await fast.provider.streamTurn({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: payload.slice(0, 40_000) } as ContentBlock] }],
      tools: [],
      onText: (delta) => { text += delta },
    })
  } catch {
    return skip('consolidation model call failed')
  }

  const parsed = parseResponse(text)
  if (!parsed) return skip('consolidation response was not usable')

  // Guard against a model that collapses the list to nothing. Mark it done
  // anyway so a persistently misbehaving model doesn't trigger a call every launch.
  if (lessons.length > 0 && parsed.lessons.length < Math.ceil(lessons.length * (1 - MAX_SHRINK))) {
    markConsolidated(consolidatedAtPath)
    return skip('consolidation would have removed too much — kept the originals')
  }

  const removeSet = new Set(parsed.removeNotes.map((n) => n.replace(/\s+/g, ' ').trim().toLowerCase()))
  const keptNotes = notes.filter((n) => !removeSet.has(n.text.toLowerCase()))
  const notesRemoved = notes.length - keptNotes.length

  const lessonsChanged = !sameList(lessons.map((l) => l.text), parsed.lessons)
  if (!lessonsChanged && notesRemoved === 0) {
    markConsolidated(consolidatedAtPath)
    return { changed: false, reason: 'already tidy', lessonsBefore: lessons.length, lessonsAfter: lessons.length, notesRemoved: 0 }
  }

  if (lessonsChanged) {
    const now = Date.now()
    const byText = new Map(lessons.map((l) => [l.text.toLowerCase(), l]))
    const rewritten: Lesson[] = parsed.lessons.map((textLine) => ({
      text: textLine,
      at: byText.get(textLine.toLowerCase())?.at || now,
    }))
    rewriteLessons(rewritten, lessonsPath)
  }
  if (notesRemoved > 0) rewriteNotes(keptNotes, notesPath)

  markConsolidated(consolidatedAtPath)
  return {
    changed: true,
    reason: 'consolidated',
    lessonsBefore: lessons.length,
    lessonsAfter: lessonsChanged ? parsed.lessons.length : lessons.length,
    notesRemoved,
  }
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value.trim().toLowerCase() === (b[index] ?? '').trim().toLowerCase())
}

function markConsolidated(path: string): void {
  try {
    writeSecureFile(path, String(Date.now()))
  } catch {
    // A missing timestamp just means the next session reconsiders sooner.
  }
}
