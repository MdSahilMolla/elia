import type { Usage } from './providers/types.ts'

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

interface Pricing {
  /** All rates are $ per million tokens. */
  inputPerM: number
  outputPerM: number
  cacheReadPerM?: number
  cacheWritePerM?: number
}

// Verified against provider pricing pages/aggregators as of 2026-08-18.
// Providers change pricing without notice — treat this as a best-effort
// estimate for orientation, not an authoritative bill.
const PRICING: Record<string, Pricing> = {
  'claude-sonnet-5': { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
  'gpt-4.1': { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  'openai/gpt-oss-120b': { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },
  'openai/gpt-oss-20b': { inputPerM: 0.075, outputPerM: 0.3, cacheReadPerM: 0.0375 },
  'mercury-2': { inputPerM: 0.15, outputPerM: 0.35, cacheReadPerM: 0.025 },
}

/** Undefined when the model isn't in the pricing table — callers should show "unknown", never a fabricated number. */
export function estimateCostUsd(model: string, usage: Usage): number | undefined {
  const pricing = PRICING[model]
  if (!pricing) return undefined

  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerM +
    (usage.outputTokens / 1_000_000) * pricing.outputPerM +
    (usage.cacheReadTokens / 1_000_000) * (pricing.cacheReadPerM ?? pricing.inputPerM) +
    (usage.cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerM ?? pricing.inputPerM)
  )
}

export function formatCostUsd(cost: number | undefined): string {
  if (cost === undefined) return 'cost unknown'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

export function formatTokenCount(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainderSeconds = Math.round(seconds % 60)
  return `${minutes}m${remainderSeconds.toString().padStart(2, '0')}s`
}

export function formatUsageLine(usage: Usage, elapsedMs: number, model: string): string {
  const cost = estimateCostUsd(model, usage)
  const tokens = totalTokens(usage)
  return `${formatElapsed(elapsedMs)} · ${formatTokenCount(tokens)} tokens · ${formatCostUsd(cost)}`
}

// --- Session-wide running totals ---
// recordUsage is called once per top-level turn AND once per sub-agent run (each
// contributes its own real usage exactly once). recordTopLevelTurn is only called
// for top-level turns — sub-agent time is already inside the top-level turn's own
// wall-clock measurement (and parallel sub-agents don't sum linearly to real time),
// so adding it again here would double-count elapsed time.
let sessionUsage: Usage = ZERO_USAGE
let sessionTurns = 0
let sessionElapsedMs = 0

export function recordUsage(usage: Usage): void {
  sessionUsage = addUsage(sessionUsage, usage)
}

export function recordTopLevelTurn(elapsedMs: number): void {
  sessionTurns += 1
  sessionElapsedMs += elapsedMs
}

export function getSessionSummaryLine(model: string): string {
  const cost = estimateCostUsd(model, sessionUsage)
  const tokens = totalTokens(sessionUsage)
  const turnWord = sessionTurns === 1 ? 'turn' : 'turns'
  return `Session: ${sessionTurns} ${turnWord} · ${formatTokenCount(tokens)} tokens · ${formatCostUsd(cost)} · ${formatElapsed(sessionElapsedMs)}`
}
