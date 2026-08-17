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

/** Tools that are safe to run speculatively: no side effects, idempotent, cheap. */
export const SPECULABLE_TOOLS = new Set(['read_file', 'list_files', 'grep'])

export interface CacheStats {
  /** Speculative executions started. */
  speculated: number
  /** Speculated results the model actually went on to ask for. */
  hits: number
  /** Real calls that found nothing cached. */
  misses: number
}

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
  const entries = new Map<string, Promise<string>>()
  const stats: CacheStats = { speculated: 0, hits: 0, misses: 0 }

  function key(name: string, input: Record<string, unknown>): string {
    // Sorted keys so `{a,b}` and `{b,a}` are the same call.
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
      stats.speculated += 1
      // A speculative miss is not an error — swallow it so an unhandled rejection
      // can't take the process down, and let the real call surface the failure.
      entries.set(
        k,
        run().catch((err: unknown) => {
          throw err instanceof Error ? err : new Error(String(err))
        }),
      )
    },

    take(name, input) {
      if (!SPECULABLE_TOOLS.has(name)) return undefined
      const k = key(name, input)
      const hit = entries.get(k)
      if (!hit) {
        stats.misses += 1
        return undefined
      }
      entries.delete(k)
      stats.hits += 1
      return hit
    },

    invalidate() {
      entries.clear()
    },

    stats() {
      return { ...stats }
    },

    hitRate() {
      const attempts = stats.hits + stats.misses
      return attempts === 0 ? 0 : stats.hits / attempts
    },
  }
}
