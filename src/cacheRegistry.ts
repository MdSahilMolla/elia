/**
 * One place that knows about every in-process cache.
 *
 * elia keeps several module-level caches — speculatively executed tool results,
 * compiled grep regexes, the brain fingerprint — for speed. Two properties
 * matter and were previously left to each site to get right (and some didn't):
 *
 *  1. **Bounded.** A cache that grows without limit is a slow memory leak over a
 *     long session. `boundedMap` caps entry count and evicts oldest-first.
 *  2. **Collectively clearable.** A checkpoint restore or `/rewind` moves the
 *     workspace out from under every cache at once. `clearAllCaches()` drops
 *     them in one call instead of each caller remembering the full list.
 *
 * This is deliberately not a memory-pressure framework: no byte budget, no
 * global LRU across cache boundaries, no pressure monitor. Just "nothing grows
 * unbounded" and "one switch clears everything".
 */

/**
 * A `Map` that never holds more than `maxEntries`. On insertion past the limit
 * the oldest entry (by insertion order) is evicted. `onEvict` sees each evicted
 * value — used by the speculative cache to settle a dropped pending promise.
 */
export function boundedMap<K, V>(maxEntries: number, onEvict?: (value: V) => void): Map<K, V> {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`boundedMap: maxEntries must be a positive integer, got ${maxEntries}`)
  }

  class BoundedMap extends Map<K, V> {
    override set(key: K, value: V): this {
      // Re-inserting an existing key should refresh its position, not double-count.
      if (super.has(key)) super.delete(key)
      super.set(key, value)
      while (super.size > maxEntries) {
        const oldest = super.keys().next().value as K | undefined
        if (oldest === undefined) break
        const evicted = super.get(oldest)
        super.delete(oldest)
        if (onEvict && evicted !== undefined) onEvict(evicted)
      }
      return this
    }
  }

  return new BoundedMap()
}

interface RegisteredCache {
  name: string
  clear: () => void
  size: () => number
}

const registry: RegisteredCache[] = []

/** Registers a cache so `clearAllCaches()` and `cacheRegistrySizes()` can see it. Idempotent by name. */
export function registerCache(name: string, clear: () => void, size: () => number): void {
  const existing = registry.findIndex((entry) => entry.name === name)
  const entry: RegisteredCache = { name, clear, size }
  if (existing >= 0) registry[existing] = entry
  else registry.push(entry)
}

/** Drops every registered cache. Call after a checkpoint restore / rewind, and in tests. */
export function clearAllCaches(): void {
  for (const entry of registry) {
    try {
      entry.clear()
    } catch {
      // A cache that throws on clear must not stop the others from clearing.
    }
  }
}

/** Current entry count of every registered cache, for diagnostics and tests. */
export function cacheRegistrySizes(): Record<string, number> {
  const sizes: Record<string, number> = {}
  for (const entry of registry) {
    try {
      sizes[entry.name] = entry.size()
    } catch {
      sizes[entry.name] = -1
    }
  }
  return sizes
}

/** Test-only: forget every registration (does not clear the underlying caches). */
export function resetCacheRegistryForTests(): void {
  registry.length = 0
}
