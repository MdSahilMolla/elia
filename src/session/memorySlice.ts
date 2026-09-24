import type { MemorySlice } from './types.ts'

/**
 * Copies a parent's memory slice for a forked session. Local scratch arrays are
 * deep-copied (each session mutates its own); project-level arrays are shared
 * read-only and frozen so a session cannot mutate the shared lesson/note store.
 * An undefined parent yields a pristine root slice.
 */
export function forkMemorySlice(parent: MemorySlice | undefined): MemorySlice {
  if (!parent) {
    return {
      lessons: Object.freeze([]),
      projectNotes: Object.freeze([]),
      localLessons: [],
      localNotes: [],
    }
  }
  return {
    lessons: Object.freeze(parent.lessons),
    projectNotes: Object.freeze(parent.projectNotes),
    localLessons: [...parent.localLessons],
    localNotes: [...parent.localNotes],
  }
}

/**
 * Permanently moves chosen session-local lessons into the project store.
 * Throws if any chosen lesson is not actually present in `localLessons`, so a
 * promotion can never silently drop work. Removes the lessons from the local
 * scratch and returns them (deduplicated, first-chosen order) for the caller to
 * append to the durable project lesson store.
 */
export function promoteLocalLessons(mem: MemorySlice, chosen: string[]): string[] {
  const unknown = chosen.filter((lesson) => !mem.localLessons.includes(lesson))
  if (unknown.length > 0) {
    throw new Error(`cannot promote lessons absent from localLessons: ${unknown.join(', ')}`)
  }
  const promoted = [...new Set(chosen)]
  for (const lesson of promoted) {
    const index = mem.localLessons.indexOf(lesson)
    if (index !== -1) mem.localLessons.splice(index, 1)
  }
  return promoted
}