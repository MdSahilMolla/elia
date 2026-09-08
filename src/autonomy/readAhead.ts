/**
 * Collapses "now read the files that search just listed" into a single turn.
 *
 * The dominant cost of an autonomous run is the number of model round-trips.
 * Measured live on `mercury-2`: a scenario whose ideal shape is two round-trips
 * (one grep, then every hit read in one batched turn) ran as **nine** — the
 * model opened one file per turn. The existing correction (toolBatchingNudge.ts)
 * is a text reminder, and a model that ignores the reminder keeps walking the
 * list one round-trip at a time.
 *
 * This is the deterministic version. It watches for the exact shape — a lone
 * `read_file` for a path that appeared in a `grep` / `list_files` result (or a
 * stack trace) the model just saw — and, when it fires, reads the *other*
 * still-unopened paths from that same worklist in the same step and hands them
 * back alongside the model's own read. The reads themselves are cheap (local
 * disk, usually already warm in the speculative cache); what it removes is the
 * chain of model round-trips that would have asked for them one by one.
 *
 * Conservative by construction: it only expands a batch that is *exactly* one
 * read (never alongside a write or a command), only toward files that were
 * genuinely on a worklist the model has already seen, never re-shows a file,
 * and is bounded per file, per expansion, and per loop.
 */

import { clampOutput } from '../shell.ts'
import { extractPaths } from '../speculation/prefetch.ts'

/** Other unopened worklist entries required before an expansion is worth it. */
const MIN_REMAINING = 2
/** Most files pulled forward in one expansion. */
const MAX_EXPAND_FILES = 6
/** Per-file clamp on injected content. */
const MAX_BYTES_PER_FILE = 12_000
/** Whole-expansion clamp, so one huge worklist can't dump the context window. */
const MAX_TOTAL_BYTES = 48_000
/** Whole-loop ceiling on expansions — a pathological session can't run away. */
const MAX_EXPANSIONS_PER_LOOP = 8

export interface ObservedToolCall {
  name: string
  input: Record<string, unknown>
  result: string
}

export interface ReadAheadExpansion {
  /** Synthetic user-turn text carrying the pulled-forward file contents. */
  text: string
  /** Repo-relative paths that were injected. */
  paths: string[]
}

export interface ReadAhead {
  /** Record an executed batch: harvest new worklist paths, retire opened ones. */
  observe(calls: ObservedToolCall[]): void
  /**
   * If `batch` is a lone `read_file` of a worklisted path and enough of that
   * worklist is still unopened, read the rest now (via `read`) and return them
   * as one injectable block. Returns undefined when the shape doesn't match or
   * a bound is hit.
   */
  expand(
    batch: { name: string; input: Record<string, unknown> }[],
    read: (path: string) => Promise<string>,
  ): Promise<ReadAheadExpansion | undefined>
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Paths a `grep` / `list_files` result points at — the model's next worklist. */
function worklistFrom(call: ObservedToolCall, cwd: string): string[] {
  if (call.name === 'list_files') {
    return call.result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('[') && !line.startsWith('No files'))
      .map(normalize)
  }
  if (call.name === 'grep' || call.name === 'run_command') {
    // grep output is `dir/path:line:text`; a stack trace names frames the model
    // is about to open. extractPaths handles both and filters to files that
    // actually exist and are readable.
    return extractPaths(call.result, cwd).map(normalize)
  }
  return []
}

export function createReadAhead(cwd: string = process.cwd()): ReadAhead {
  // Worklist paths the model has been told about but not yet opened.
  const pending = new Set<string>()
  // Every path already in the model's context — its own reads, and anything we
  // pulled forward. Never shown twice.
  const shown = new Set<string>()
  let expansionsUsed = 0

  return {
    observe(calls) {
      for (const call of calls) {
        if (call.name === 'read_file') {
          const path = typeof call.input.path === 'string' ? normalize(call.input.path) : undefined
          if (path) {
            shown.add(path)
            pending.delete(path)
          }
          continue
        }
        if (call.name === 'edit_file' || call.name === 'write_file') {
          const path = typeof call.input.path === 'string' ? normalize(call.input.path) : undefined
          // The model just wrote this file, so it already has the content — drop
          // it from the worklist rather than pull a copy forward. A later
          // independent read of it stays legitimate; we just won't volunteer one.
          if (path) {
            shown.delete(path)
            pending.delete(path)
          }
          continue
        }
        for (const path of worklistFrom(call, cwd)) {
          if (!shown.has(path)) pending.add(path)
        }
      }
    },

    async expand(batch, read) {
      if (expansionsUsed >= MAX_EXPANSIONS_PER_LOOP) return undefined
      if (batch.length !== 1) return undefined
      const only = batch[0]!
      if (only.name !== 'read_file') return undefined
      const triggerPath = typeof only.input.path === 'string' ? normalize(only.input.path) : undefined
      if (!triggerPath) return undefined

      // The trigger read is dispatched by the loop itself this turn; count it as
      // shown and off the worklist so we don't pull it forward.
      shown.add(triggerPath)
      pending.delete(triggerPath)

      const candidates = [...pending].slice(0, MAX_EXPAND_FILES)
      if (candidates.length < MIN_REMAINING) return undefined

      const sections: string[] = []
      const injected: string[] = []
      let totalBytes = 0
      for (const path of candidates) {
        if (totalBytes >= MAX_TOTAL_BYTES) break
        let body: string
        try {
          body = await read(path)
        } catch {
          // Unreadable / sensitive / vanished — drop it silently and let the
          // model ask if it really wants it.
          pending.delete(path)
          continue
        }
        const clamped = clampOutput(body, MAX_BYTES_PER_FILE)
        totalBytes += clamped.length
        sections.push(`===== ${path} =====\n${clamped}`)
        injected.push(path)
        shown.add(path)
        pending.delete(path)
      }

      if (injected.length < MIN_REMAINING) return undefined
      expansionsUsed += 1

      return {
        paths: injected,
        text:
          `[elia read-ahead] You opened one file from a list you just searched. To save round-trips, here are the other ` +
          `${injected.length} file(s) from that same worklist you had not opened yet — treat them as if you had read them ` +
          `this turn, and don't issue separate read_file calls for them:\n\n${sections.join('\n\n')}\n\n` +
          `(Ignore any you don't need.)`,
      }
    },
  }
}
