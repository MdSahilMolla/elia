/**
 * One canonical identity for keys that differ only by case or spacing.
 *
 * The delivered corpus was scraped from writeups that spell the same technique
 * several ways ('Insecure Deserialization' vs 'Insecure deserialization'), and a
 * reader that keeps both would double-count or drop entries — a strict parser
 * rejects the file outright once such keys collide. This groups the variants by
 * a canonical key, merges their values into one entry, and reports the groups so
 * `validate.ts` can fail the corpus instead of quietly loading half of it.
 */

/** The merge identity for a key: trimmed, internal whitespace collapsed, lowercased. */
export function canonicalKey(key: string): string {
  return key.trim().replace(/\s+/g, ' ').toLowerCase()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function union(first: unknown[], second: unknown[]): unknown[] {
  const seen = new Set(first)
  const out = [...first]
  for (const item of second) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function mergeValues(first: unknown, second: unknown): unknown {
  if (Array.isArray(first) && Array.isArray(second)) return union(first, second)
  if (isPlainObject(first) && isPlainObject(second) && typeof first.count === 'number' && typeof second.count === 'number') {
    return { ...first, ...second, count: first.count + second.count }
  }
  return first
}

interface KeyGroup {
  /** Original keys in first-seen order. */
  keys: string[]
  value: unknown
}

/**
 * Groups `obj`'s top-level keys by {@link canonicalKey} and merges each group
 * into one entry.
 *
 * A group of distinct original keys is a collision: its original keys are
 * reported in `collisions` (and, as a group, in `merged`) and the merged value
 * lands under the group's canonical key — deterministic regardless of key order.
 * Single-key groups keep their own key and value untouched, so a clean object
 * comes back unchanged with `collisions: []`.
 */
export function canonicalizeKeys<T extends Record<string, unknown>>(obj: T): { value: Record<string, unknown>; merged: string[][]; collisions: string[] } {
  const groups = new Map<string, KeyGroup>()
  for (const [key, value] of Object.entries(obj)) {
    const canonical = canonicalKey(key)
    const group = groups.get(canonical)
    if (group) {
      group.keys.push(key)
      group.value = mergeValues(group.value, value)
    } else {
      groups.set(canonical, { keys: [key], value })
    }
  }

  const value: Record<string, unknown> = {}
  const merged: string[][] = []
  for (const [canonical, group] of groups) {
    if (group.keys.length > 1) {
      merged.push(group.keys)
      value[canonical] = group.value
    } else {
      value[group.keys[0]!] = group.value
    }
  }
  return { value, merged, collisions: merged.flat() }
}
