import { existsSync, readFileSync } from 'node:fs'
import { appendSecureFile, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'
import { paths } from '../config.ts'

/**
 * Durable notes — the free-form half of elia's second brain.
 *
 * Lessons are "what a future run should know before it starts"; rationale is
 * "why this specific file is shaped like this". Notes are everything else worth
 * keeping across sessions: how a subsystem actually behaves, a gotcha in a
 * dependency, the shape of an external API, a fact the user stated once. Append
 * only, project-scoped, folded on load, deduped by exact text.
 */

export interface BrainNote {
  id: string
  at: number
  text: string
  /** Repo-relative paths this note concerns, when it is anchored to code. */
  paths: string[]
  /** Free tags for grouping/recall. */
  tags: string[]
}

function newNoteId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function appendNote(
  input: { text: string; paths?: string[]; tags?: string[] },
  path = paths.brainNotes,
): BrainNote | undefined {
  const text = clean(input.text)
  if (!text) return undefined

  const existing = loadNotes(path)
  if (existing.some((note) => note.text.toLowerCase() === text.toLowerCase())) return undefined

  const note: BrainNote = {
    id: newNoteId(),
    at: Date.now(),
    text,
    paths: (input.paths ?? []).map(clean).filter(Boolean),
    tags: (input.tags ?? []).map((tag) => clean(tag).toLowerCase()).filter(Boolean),
  }
  try {
    appendSecureFile(path, `${JSON.stringify(note)}\n`)
  } catch {
    // A lost note costs future understanding, not this run's correctness.
    return undefined
  }
  return note
}

export function loadNotes(path = paths.brainNotes): BrainNote[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<BrainNote>
          if (!parsed || typeof parsed.text !== 'string' || !parsed.text) return undefined
          return {
            id: typeof parsed.id === 'string' ? parsed.id : newNoteId(),
            at: typeof parsed.at === 'number' ? parsed.at : 0,
            text: parsed.text,
            paths: Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === 'string') : [],
            tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
          }
        } catch {
          return undefined
        }
      })
      .filter((note): note is BrainNote => note !== undefined)
  } catch {
    return []
  }
}

/** Overwrites the notes file with a curated set — used by consolidation only. */
export function rewriteNotes(notes: BrainNote[], path = paths.brainNotes): void {
  try {
    const body = notes.map((note) => JSON.stringify(note)).join('\n')
    writeSecureFile(path, body ? `${body}\n` : '')
  } catch {
    // Consolidation is best-effort; leaving the old file in place is safe.
  }
}
