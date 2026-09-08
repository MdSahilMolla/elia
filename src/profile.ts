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

/** One tool execution within the loop — recorded alongside the model calls it sits between. */
export interface ToolCallSample {
  /** Tool name, e.g. "read_file". */
  name: string
  /** "top" for the lead loop, or a sub-agent label. */
  actor: string
  /** Wall-clock time the tool took (0 when served from the speculative cache). */
  wallMs: number
  /** Characters of result text handed back to the model. */
  bytesOut: number
  /** True when the result came from the speculative cache instead of a real run. */
  cached: boolean
  /** True when the tool errored. */
  isError: boolean
}

let enabled = readEnabled()
let samples: ModelCallSample[] = []
let toolSamples: ToolCallSample[] = []

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

export function recordToolCall(sample: ToolCallSample): void {
  if (!profilingEnabled()) return
  toolSamples.push(sample)
}

export function profileSampleCount(): number {
  return samples.length
}

export function resetProfilerForTests(): void {
  samples = []
  toolSamples = []
  enabled = readEnabled()
}

export interface ToolProfileRow {
  name: string
  calls: number
  cachedCalls: number
  errorCalls: number
  totalWallMs: number
  p50WallMs: number
  p90WallMs: number
  totalBytesOut: number
}

/** Per-tool aggregates, busiest first (by call count). */
export function toolProfileReport(): ToolProfileRow[] {
  const byName = new Map<string, ToolCallSample[]>()
  for (const sample of toolSamples) {
    const bucket = byName.get(sample.name)
    if (bucket) bucket.push(sample)
    else byName.set(sample.name, [sample])
  }

  const rows = [...byName.entries()].map(([name, entries]): ToolProfileRow => {
    const wall = entries.map((entry) => entry.wallMs)
    return {
      name,
      calls: entries.length,
      cachedCalls: entries.filter((entry) => entry.cached).length,
      errorCalls: entries.filter((entry) => entry.isError).length,
      totalWallMs: wall.reduce((sum, value) => sum + value, 0),
      p50WallMs: percentile(wall, 50) ?? 0,
      p90WallMs: percentile(wall, 90) ?? 0,
      totalBytesOut: entries.reduce((sum, entry) => sum + entry.bytesOut, 0),
    }
  })

  return rows.sort((a, b) => b.calls - a.calls)
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
  if (samples.length === 0 && toolSamples.length === 0) return ''
  if (samples.length === 0) return renderToolProfile()
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

  const toolProfile = renderToolProfile()
  return ['Turn profile (ELIA_PROFILE)', header, ...rows, divider, summary, ...(toolProfile ? ['', toolProfile] : [])].join('\n')
}

/** A per-tool table: where the loop's tool phase actually spent its time. Empty string when no tools ran. */
export function renderToolProfile(): string {
  const rows = toolProfileReport()
  if (rows.length === 0) return ''

  const line = (cells: [string, string, string, string, string, string, string]): string =>
    '  ' +
    [
      cells[0].slice(0, 16).padEnd(16),
      cells[1].padStart(5),
      cells[2].padStart(7),
      cells[3].padStart(7),
      cells[4].padStart(8),
      cells[5].padStart(7),
      cells[6].padStart(7),
    ].join('  ')

  const header = line(['tool', 'calls', 'cached', 'errors', 'total', 'p50', 'p90'])
  const body = rows.map((r) =>
    line([r.name, String(r.calls), String(r.cachedCalls), String(r.errorCalls), ms(r.totalWallMs), ms(r.p50WallMs), ms(r.p90WallMs)]),
  )
  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0)
  const totalCached = rows.reduce((sum, r) => sum + r.cachedCalls, 0)
  const totalWall = rows.reduce((sum, r) => sum + r.totalWallMs, 0)
  const divider = `  ${'─'.repeat(header.length - 2)}`
  const summary = `  ${totalCalls} tool calls · ${ms(totalWall)} total tool wall time · ${pct(totalCalls === 0 ? 0 : totalCached / totalCalls)} served from speculative cache`

  return ['Tool profile', header, ...body, divider, summary].join('\n')
}
