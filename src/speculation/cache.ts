/**
 * A cache of *speculatively executed* tool results.
 *
 * The agent loop spends most of its wall clock waiting on two things: the model
 * generating tokens, and tool calls running afterwards. Those two waits are
 * normally strictly sequential — but the read-only tools the model is about to
 * call are usually guessable from what it has already seen (a grep hit list, an
 * import statement, a stack trace). So while the model is still generating, elia
 * runs those reads in the background. When the real call arrives it's already
 * done, and the tool phase costs ~0ms instead of a disk round-trip per file.
 *
 * Only read-only tools are ever speculated — never a write, never a shell
 * command — so a wrong guess costs a wasted file read and nothing else. Any
 * mutating tool call clears the cache, so the model can never be handed a
 * pre-write snapshot of a file it just changed.
 */

import { boundedMap, registerCache } from '../cacheRegistry.ts'

/** Tools that are safe to run speculatively: no side effects, idempotent, cheap. */
export const SPECULABLE_TOOLS = new Set(['read_file', 'list_files', 'grep'])

export interface CacheStats {
  /** Speculative executions started. */
  speculated: number
  /** Speculated results the model actually went on to ask for. */
  hits: number
  /** Real calls that found nothing cached. */
  misses: number
  /** Entries currently held. */
  size: number
  /** Entries dropped because the cache was at its entry cap. */
  evictions: number
}

/**
 * Entry-count cap. A single loop is bounded to 80 speculative reads by the
 * prefetcher (MAX_PREDICTIONS_PER_LOOP) plus mid-stream dispatch, so this is
 * well clear of normal use and only bites a pathological run.
 */
const MAX_CACHE_ENTRIES = 512

export interface ToolResultCache {
  /** True when this tool may be speculated at all. */
  canSpeculate(name: string): boolean
  /** Records a speculative run. Duplicate keys are ignored so work is never done twice. */
  speculate(name: string, input: Record<string, unknown>, run: () => Promise<string>): void
  /** Consumes a cached result, or returns undefined on a miss. Counts toward hit rate. */
  take(name: string, input: Record<string, unknown>): Promise<string> | undefined
  /** Drops everything. Called before any batch containing a mutating tool. */
  invalidate(): void
  stats(): CacheStats
  hitRate(): number
}

export function createToolResultCache(): ToolResultCache {
  let evictions = 0
  const entries = boundedMap<string, Promise<string>>(MAX_CACHE_ENTRIES, (dropped) => {
    evictions += 1
    // The dropped speculation may still be in flight and will never be `take`n now.
    void dropped.catch(() => {})
  })
  const counters = { speculated: 0, hits: 0, misses: 0 }

  // Registered so a checkpoint restore drops it along with every other cache.
  // Loops and sub-agents each make their own; the most recent wins the name,
  // which is all clearAllCaches (a lead-loop operation) needs.
  registerCache('speculation', () => entries.clear(), () => entries.size)

  function key(name: string, input: Record<string, unknown>): string {
    // Sorted keys so `{a,b}` and `{b,a}` are the same call. JSON.stringify on
    // each value keeps the encoding unambiguous — a hand-rolled `k=v` join left
    // `{pattern:'x',path:'y'}` and `{path:'y&pattern=x'}` with the same key.
    const normalized = Object.keys(input)
      .sort()
      .map((k) => `${k}=${JSON.stringify(input[k])}`)
      .join('&')
    return `${name}?${normalized}`
  }

  return {
    canSpeculate(name) {
      return SPECULABLE_TOOLS.has(name)
    },

    speculate(name, input, run) {
      if (!SPECULABLE_TOOLS.has(name)) return
      const k = key(name, input)
      if (entries.has(k)) return
      counters.speculated += 1
      const pending = run().catch((err: unknown) => {
        throw err instanceof Error ? err : new Error(String(err))
      })
      // A speculation that rejects but is never `take`n — the model didn't end
      // up asking for it, or the batch mutated and the cache was dropped — must
      // not surface as an unhandledRejection. This detached handler settles that
      // case; a real `take()` consumer still awaits `pending` and sees the throw.
      void pending.catch(() => {})
      entries.set(k, pending)
    },

    take(name, input) {
      if (!SPECULABLE_TOOLS.has(name)) return undefined
      const k = key(name, input)
      const hit = entries.get(k)
      if (!hit) {
        counters.misses += 1
        return undefined
      }
      entries.delete(k)
      counters.hits += 1
      return hit
    },

    invalidate() {
      entries.clear()
    },

    stats() {
      return { ...counters, size: entries.size, evictions }
    },

    hitRate() {
      const attempts = counters.hits + counters.misses
      return attempts === 0 ? 0 : counters.hits / attempts
    },
  }
}
