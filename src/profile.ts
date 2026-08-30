import type { Usage } from './providers/types.ts'

/**
 * Per-turn profiling for the agent loop.
 *
 * The loop's cost and latency are dominated by one thing — how much of the
 * request the provider has to reprocess on each model round-trip instead of
 * reading back from its prompt cache. That is invisible in the normal usage
 * line, which only sums tokens. With `ELIA_PROFILE=1` set, every model call
 * records a sample here (wall time, time-to-first-token, and the exact
 * cache-read / cache-write / fresh-input split), and a table is printed at the
 * end of the run.
 *
 * This is measurement only. It never changes the request, the prompt, or the
 * model's behaviour, and when profiling is off `recordModelCall` is a cheap
 * early return.
 */

export interface ModelCallSample {
  /** 1-based index of this model round-trip within its own loop. */
  callIndex: number
  /** "top" for the lead agent loop, or a sub-agent label like "scout#2". */
  actor: string
  /** Wall-clock time for the whole provider request. */
  wallMs: number
  /**
   * Time from request start to the first streamed token (text or reasoning).
   * Undefined for a tool-only turn that streams nothing before the final
   * message, or a provider that does not stream.
   */
  ttftMs?: number
  /** Non-cached prompt tokens the provider had to process fresh this call. */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** tool_use blocks the model emitted this call. */
  toolCalls: number
  /** Character length of the stable (cacheable) system prompt. */
  systemChars: number
  /** Character length of the per-turn dynamic system suffix, 0 when none. */
  dynamicSystemChars: number
  /** Number of tool definitions sent. */
  toolDefs: number
  /** Messages in the conversation array at request time. */
  messageCount: number
}

let enabled = readEnabled()
let samples: ModelCallSample[] = []

function readEnabled(): boolean {
  const value = process.env.ELIA_PROFILE
  return value === '1' || value === 'true'
}

/** Whether `ELIA_PROFILE` is set. Re-read each call so a test can toggle it. */
export function profilingEnabled(): boolean {
  enabled = readEnabled()
  return enabled
}

export function recordModelCall(sample: ModelCallSample): void {
  if (!profilingEnabled()) return
  samples.push(sample)
}

export function profileSampleCount(): number {
  return samples.length
}

export function resetProfilerForTests(): void {
  samples = []
  enabled = readEnabled()
}

function cacheHitRate(input: number, read: number, write: number): number {
  const total = input + read + write
  return total === 0 ? 0 : read / total
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

function ms(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(1)}s`
}

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

export interface ProfileReport {
  calls: number
  /** Fresh prefix cache writes on calls after the first of an actor's loop — each is a stall. */
  prefixMisses: number
  aggregateHitRate: number
  totalCacheWrite: number
  totalCacheRead: number
  totalInput: number
  totalOutput: number
  p50TtftMs?: number
  p90TtftMs?: number
  totalWallMs: number
}

export function profileReport(): ProfileReport {
  const totalInput = samples.reduce((sum, s) => sum + s.inputTokens, 0)
  const totalCacheRead = samples.reduce((sum, s) => sum + s.cacheReadTokens, 0)
  const totalCacheWrite = samples.reduce((sum, s) => sum + s.cacheWriteTokens, 0)
  const totalOutput = samples.reduce((sum, s) => sum + s.outputTokens, 0)
  const ttfts = samples.filter((s) => s.ttftMs !== undefined).map((s) => s.ttftMs as number)
  // A prefix miss: a non-first call in a loop that still paid to write cache and
  // read little of it back — the stable system+tools prefix was not reused.
  const prefixMisses = samples.filter(
    (s) => s.callIndex > 1 && s.cacheWriteTokens > 0 && s.cacheReadTokens < s.systemChars / 4,
  ).length

  return {
    calls: samples.length,
    prefixMisses,
    aggregateHitRate: cacheHitRate(totalInput, totalCacheRead, totalCacheWrite),
    totalCacheWrite,
    totalCacheRead,
    totalInput,
    totalOutput,
    p50TtftMs: percentile(ttfts, 50),
    p90TtftMs: percentile(ttfts, 90),
    totalWallMs: samples.reduce((sum, s) => sum + s.wallMs, 0),
  }
}

/** A dim, terminal-friendly table of every model call this run made. Empty string when there is nothing to show. */
export function renderProfileReport(): string {
  if (samples.length === 0) return ''
  const report = profileReport()

  const row = (cells: [string, string, string, string, string, string, string, string, string, string]): string =>
    '  ' +
    [
      cells[0].padEnd(3),
      cells[1].slice(0, 11).padEnd(11),
      cells[2].padEnd(7),
      cells[3].padEnd(7),
      cells[4].padStart(9),
      cells[5].padStart(9),
      cells[6].padStart(9),
      cells[7].padStart(7),
      cells[8].padStart(6),
      cells[9].padStart(4),
    ].join('  ')

  const header = row(['#', 'actor', 'wall', 'ttft', 'fresh-in', 'cache-r', 'cache-w', 'out', 'tools', 'hit'])
  const rows = samples.map((s) =>
    row([
      String(s.callIndex),
      s.actor,
      ms(s.wallMs),
      ms(s.ttftMs),
      n(s.inputTokens),
      n(s.cacheReadTokens),
      n(s.cacheWriteTokens),
      n(s.outputTokens),
      String(s.toolCalls),
      pct(cacheHitRate(s.inputTokens, s.cacheReadTokens, s.cacheWriteTokens)),
    ]),
  )

  const divider = `  ${'─'.repeat(header.length - 2)}`
  const summary = [
    `  ${report.calls} model calls · ${ms(report.totalWallMs)} total provider wall time`,
    `  cache hit rate ${pct(report.aggregateHitRate)} · cache read ${n(report.totalCacheRead)} · cache write ${n(report.totalCacheWrite)} · fresh input ${n(report.totalInput)}`,
    `  TTFT p50 ${ms(report.p50TtftMs)} · p90 ${ms(report.p90TtftMs)}`,
    report.prefixMisses > 0
      ? `  ${report.prefixMisses} prefix cache miss(es) — the stable system+tools prefix was reprocessed mid-loop (slow turn crossed the cache TTL, or the prefix changed)`
      : `  no prefix cache misses — the stable system+tools prefix was reused on every follow-up call`,
  ].join('\n')

  return ['Turn profile (ELIA_PROFILE)', header, ...rows, divider, summary].join('\n')
}
