import { statSync } from 'node:fs'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { boundedMap, registerCache } from '../cacheRegistry.ts'

/**
 * Cross-turn memoization of `read_file` results.
 *
 * The speculative cache (./cache.ts) is single-use — `take()` deletes the entry —
 * and is wiped wholesale whenever a batch mutates anything. That is right for
 * *speculation*: a guessed-ahead read must never outlive the write that could
 * invalidate it.
 *
 * But a repair loop re-reads the same unchanged files over and over: read A,
 * read B, verification fails, re-read A and B, edit A, re-read B. Every re-read
 * of an unchanged file is a wasted disk round-trip. This cache serves those:
 *
 *  - keyed by the exact tool input (path + any offset/limit window),
 *  - guarded by a `mtime:size` stamp taken at store time — a `get` that finds
 *    the file changed on disk (an external edit, a shell command, the user
 *    between turns) returns a miss and the caller reads fresh,
 *  - flushed per-path the moment elia's own `edit_file` / `write_file` touches
 *    it, so a same-size same-mtime edit can't slip a stale read through,
 *  - cleared entirely when the batch runs anything opaque (a shell command, a
 *    sub-agent) that could have rewritten files we can't see.
 *
 * Off with `ELIA_NO_READ_MEMO=1`.
 */

const MAX_ENTRIES = 256

interface Entry {
  result: string
  stamp: string
}

function disabled(): boolean {
  const value = process.env.ELIA_NO_READ_MEMO
  return value === '1' || value === 'true'
}

function stampOf(resolvedPath: string): string | undefined {
  try {
    const stat = statSync(resolvedPath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return undefined
  }
}

function keyOf(input: Record<string, unknown>): string {
  return Object.keys(input)
    .sort()
    .map((k) => `${k}=${JSON.stringify(input[k])}`)
    .join('&')
}

export interface DeterministicReadCache {
  /** Cached result for this read, or undefined on a miss / changed file / disabled. */
  get(input: Record<string, unknown>): string | undefined
  /** Records a real read's result, stamped with the file's current mtime:size. */
  put(input: Record<string, unknown>, result: string): void
  /** Drops every entry for one file — call after elia edits or writes it. */
  invalidatePath(resolvedPath: string): void
  /** Drops everything — call when something opaque may have touched the tree. */
  clear(): void
  stats(): { size: number; hits: number; misses: number }
}

function create(): DeterministicReadCache {
  const entries = boundedMap<string, Entry>(MAX_ENTRIES)
  // path -> set of cache keys that read it, so invalidatePath is O(keys for that path).
  const keysByPath = new Map<string, Set<string>>()
  let hits = 0
  let misses = 0

  const resolvedPathOf = (input: Record<string, unknown>): string | undefined => {
    const path = input.path
    if (typeof path !== 'string' || path.length === 0) return undefined
    try {
      return resolveWorkspacePath(path)
    } catch {
      return undefined
    }
  }

  return {
    get(input) {
      if (disabled()) return undefined
      const resolved = resolvedPathOf(input)
      if (!resolved) return undefined
      const entry = entries.get(keyOf(input))
      if (!entry) {
        misses += 1
        return undefined
      }
      if (entry.stamp !== stampOf(resolved)) {
        // The file moved under us. Drop the stale entry and read fresh.
        entries.delete(keyOf(input))
        misses += 1
        return undefined
      }
      hits += 1
      return entry.result
    },

    put(input, result) {
      if (disabled()) return
      const resolved = resolvedPathOf(input)
      if (!resolved) return
      const stamp = stampOf(resolved)
      if (!stamp) return
      const key = keyOf(input)
      entries.set(key, { result, stamp })
      let bucket = keysByPath.get(resolved)
      if (!bucket) {
        bucket = new Set()
        keysByPath.set(resolved, bucket)
      }
      bucket.add(key)
    },

    invalidatePath(resolvedPath) {
      const bucket = keysByPath.get(resolvedPath)
      if (!bucket) return
      for (const key of bucket) entries.delete(key)
      keysByPath.delete(resolvedPath)
    },

    clear() {
      entries.clear()
      keysByPath.clear()
    },

    stats() {
      return { size: entries.size, hits, misses }
    },
  }
}

/** Process-wide singleton — safe to share because every `get` re-checks the file stamp. */
export const readMemo: DeterministicReadCache = create()
registerCache('read-memo', () => readMemo.clear(), () => readMemo.stats().size)

/** Test-only: a fresh, isolated instance. */
export const createDeterministicReadCacheForTests = create
