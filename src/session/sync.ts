/**
 * Cross-session memory sync: a deterministic diff + merge over two sessions'
 * memory slices.
 *
 * Keys are content-addressed ids derived from each single-line lesson/note
 * (whitespace collapsed, lower-cased — the same identity formula the lesson
 * store uses, minus the stable hash). Two entries that differ only cosmetically
 * (case or spacing) collide on one key and surface as a conflict to resolve;
 * entries with genuinely different text are additive and merge silently.
 *
 * Project-level arrays (`lessons`, `projectNotes`) are shared read-only memory
 * and never enter the diff or the merge: only each session's private local
 * slices participate, so a sync can never mutate project memory.
 */
import type { MemorySlice, SessionBus, SyncChoice, SyncConflict, SyncDiff, SyncReport } from './types.ts'

/** One conflict resolution: which side's value a key keeps. */
export interface SyncDecision {
  key: string
  choice: SyncChoice
}

const VALID_CHOICES: ReadonlySet<SyncChoice> = new Set(['a', 'b', 'both', 'drop'])

/** Content-addressed id for a single-line lesson/note entry. */
function entryKey(entry: string): string {
  return entry.replace(/\s+/g, ' ').trim().toLowerCase()
}

function isBlank(entry: string): boolean {
  return entry.trim().length === 0
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

interface KeyMap {
  map: Map<string, string>
  order: string[]
}

function buildKeyMap(slice: MemorySlice): KeyMap {
  const map = new Map<string, string>()
  const order: string[] = []
  for (const entry of [...slice.localLessons, ...slice.localNotes]) {
    if (isBlank(entry)) continue
    const key = entryKey(entry)
    if (map.has(key)) continue
    map.set(key, entry)
    order.push(key)
  }
  return { map, order }
}

/**
 * Diffs two memory slices by single-line lesson/note id. Entries that exist in
 * only one slice land in `aOnly`/`bOnly` (as the exact original strings); the
 * same key with a different exact value on each side is a conflict carrying
 * both strings; identical entries are not listed at all.
 */
export function computeSessionSyncDiff(a: MemorySlice, b: MemorySlice): SyncDiff {
  const { map: mapA, order: orderA } = buildKeyMap(a)
  const { map: mapB, order: orderB } = buildKeyMap(b)

  const aOnly: string[] = []
  const bOnly: string[] = []
  const conflicts: SyncConflict[] = []

  for (const key of orderA) {
    const valueA = mapA.get(key)
    const valueB = mapB.get(key)
    if (valueB === undefined) {
      if (valueA !== undefined) aOnly.push(valueA)
    } else if (valueA !== undefined && valueA !== valueB) {
      conflicts.push({ key, a: valueA, b: valueB })
    }
  }
  for (const key of orderB) {
    const valueB = mapB.get(key)
    if (valueB !== undefined && !mapA.has(key)) bOnly.push(valueB)
  }

  return { aOnly, bOnly, conflicts }
}

export interface ResolveConflictsResult {
  merged: { localA: string[]; localB: string[] }
  report: SyncReport
}

/**
 * Applies conflict choices and returns the merged local content for both
 * sides. The merge is symmetric, so both sides converge on the same arrays:
 * A's one-sided additions, then each decided conflict's winner (A first for
 * 'both', deduped), then B's one-sided additions. Undecided conflicts stay out
 * of `merged` and appear only via `report.diff.conflicts`.
 */
export function resolveConflicts(diff: SyncDiff, decisions: Array<SyncDecision>): ResolveConflictsResult {
  const resolved: Array<SyncDecision> = []
  const merged: string[] = []
  const seen = new Set<string>()

  const push = (value: string | undefined): void => {
    if (value === undefined || isBlank(value) || seen.has(value)) return
    seen.add(value)
    merged.push(value)
  }

  for (const value of diff.aOnly) push(value)
  for (const conflict of diff.conflicts) {
    const decision = decisions.find((candidate) => candidate.key === conflict.key)
    if (!decision) continue
    if (!VALID_CHOICES.has(decision.choice)) continue
    if (decision.choice === 'a') push(conflict.a)
    else if (decision.choice === 'b') push(conflict.b)
    else if (decision.choice === 'both') {
      push(conflict.a)
      push(conflict.b)
    }
    // 'drop' keeps neither.
    resolved.push({ key: conflict.key, choice: decision.choice })
  }
  for (const value of diff.bOnly) push(value)

  return { merged: { localA: [...merged], localB: [...merged] }, report: { diff, resolved } }
}

interface SyncConflictIndex {
  conflictsByKey: Map<string, SyncConflict>
  decisionsByKey: Map<string, SyncChoice>
}

function mergeBucket(
  aValues: readonly string[],
  bValues: readonly string[],
  { conflictsByKey, decisionsByKey }: SyncConflictIndex,
): string[] {
  const result: string[] = []
  const seenKey = new Set<string>()

  for (const value of aValues) {
    const key = entryKey(value)
    const conflict = conflictsByKey.get(key)
    if (conflict) {
      const choice = decisionsByKey.get(key)
      if (choice === 'b') {
        if (!seenKey.has(key)) {
          seenKey.add(key)
          result.push(conflict.b ?? value)
        }
      } else if (choice === 'both') {
        if (!seenKey.has(key)) {
          const first = conflict.a ?? value
          seenKey.add(key)
          result.push(first)
          const second = conflict.b
          if (second !== undefined && !seenKey.has(entryKey(second))) {
            seenKey.add(entryKey(second))
            result.push(second)
          }
        }
      } else if (choice === 'drop') {
        seenKey.add(key)
      } else {
        // 'a' (or, defensively, anything unexpected) keeps A's exact wording.
        if (!seenKey.has(key)) {
          seenKey.add(key)
          result.push(value)
        }
      }
    } else if (!isBlank(value)) {
      if (!seenKey.has(key)) {
        seenKey.add(key)
        result.push(value)
      }
    }
  }

  for (const value of bValues) {
    if (isBlank(value)) continue
    const key = entryKey(value)
    if (seenKey.has(key)) continue
    seenKey.add(key)
    result.push(value)
  }

  return result
}

/**
 * Syncs two sessions' local memory slices. Both refs resolve through the bus
 * (an unknown ref throws). When the diff has conflicts and no `decide` is
 * given the conflicts are left unresolved and the report returned unmerged;
 * when every conflict is decided the merged arrays are written back to BOTH
 * sessions. Project-level arrays are never touched.
 */
export async function syncSessions(
  aRef: string,
  bRef: string,
  bus: SessionBus,
  decide?: (conflicts: SyncConflict[]) => Promise<Array<SyncDecision>>,
): Promise<SyncReport> {
  const handleA = bus.resolve(aRef)
  if (!handleA) throw new Error(`Unknown session "${aRef}" — nothing to sync with.`)
  const handleB = bus.resolve(bRef)
  if (!handleB) throw new Error(`Unknown session "${bRef}" — nothing to sync with.`)

  const diff = computeSessionSyncDiff(handleA.memorySlice, handleB.memorySlice)

  let decisions: Array<SyncDecision> = []
  if (diff.conflicts.length > 0) {
    if (!decide) return { diff, resolved: [] }
    decisions = (await decide(diff.conflicts)) ?? []
  }

  const validDecisions = decisions.filter(
    (decision) => VALID_CHOICES.has(decision.choice) && diff.conflicts.some((conflict) => conflict.key === decision.key),
  )
  const decidedKeys = new Set(validDecisions.map((decision) => decision.key))
  if (diff.conflicts.some((conflict) => !decidedKeys.has(conflict.key))) {
    // A partial decision set would silently drop one side's wording — refuse to
    // mutate and leave the report to surface the unresolved conflicts.
    return { diff, resolved: [] }
  }

  const index: SyncConflictIndex = {
    conflictsByKey: new Map(diff.conflicts.map((conflict) => [conflict.key, conflict])),
    decisionsByKey: new Map(validDecisions.map((decision) => [decision.key, decision.choice])),
  }
  const mergedLessons = mergeBucket(handleA.memorySlice.localLessons, handleB.memorySlice.localLessons, index)
  const mergedNotes = mergeBucket(handleA.memorySlice.localNotes, handleB.memorySlice.localNotes, index)

  const sliceA = handleA.memorySlice
  const sliceB = handleB.memorySlice
  const alreadySynchronized =
    sameList(sliceA.localLessons, mergedLessons) &&
    sameList(sliceA.localNotes, mergedNotes) &&
    sameList(sliceB.localLessons, mergedLessons) &&
    sameList(sliceB.localNotes, mergedNotes)

  if (!alreadySynchronized) {
    bus.update(handleA.id, {
      memorySlice: { ...sliceA, localLessons: [...mergedLessons], localNotes: [...mergedNotes] },
    })
    bus.update(handleB.id, {
      memorySlice: { ...sliceB, localLessons: [...mergedLessons], localNotes: [...mergedNotes] },
    })
  }

  return { diff, resolved: validDecisions }
}