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
  'mercury-2.5': { inputPerM: 0.2, outputPerM: 0.75, cacheReadPerM: 0.02 },
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

// Per-model breakdown. Most call sites don't have the model id handy, so
// `recordUsage` falls back to whatever `setCurrentUsageModel` was last told —
// index.ts sets it at startup and on every `/model` switch. Sub-agents run on
// their own tier and pass their model explicitly.
const usageByModel = new Map<string, Usage>()
let currentModel = 'unknown'

export function setCurrentUsageModel(model: string): void {
  const trimmed = model?.trim()
  if (trimmed) currentModel = trimmed
}

export function recordUsage(usage: Usage, model?: string): void {
  sessionUsage = addUsage(sessionUsage, usage)
  const key = model?.trim() || currentModel
  usageByModel.set(key, addUsage(usageByModel.get(key) ?? ZERO_USAGE, usage))
}

export interface ModelUsage {
  model: string
  usage: Usage
  /** Undefined when the model isn't in the pricing table. */
  costUsd: number | undefined
}

/** This session's token totals grouped by the model that produced them, largest first. */
export function sessionUsageByModel(): ModelUsage[] {
  return [...usageByModel.entries()]
    .map(([model, usage]) => ({ model, usage, costUsd: estimateCostUsd(model, usage) }))
    .sort((a, b) => totalTokens(b.usage) - totalTokens(a.usage))
}

export function recordTopLevelTurn(elapsedMs: number): void {
  sessionTurns += 1
  sessionElapsedMs += elapsedMs
}

export interface SessionUsageSnapshot {
  usage: Usage
  turns: number
  elapsedMs: number
}

/** The running session totals, for a detailed `/cost` breakdown. */
export function sessionUsageSnapshot(): SessionUsageSnapshot {
  return { usage: sessionUsage, turns: sessionTurns, elapsedMs: sessionElapsedMs }
}

/** A compact one-line token/cost tag for the post-turn status line. */
export function formatCompactUsage(model: string): string {
  const cost = estimateCostUsd(model, sessionUsage)
  return `${formatTokenCount(sessionUsage.inputTokens + sessionUsage.cacheReadTokens)} in · ${formatTokenCount(sessionUsage.outputTokens)} out · ${formatCostUsd(cost)}`
}

export function getSessionSummaryLine(model: string): string {
  const cost = estimateCostUsd(model, sessionUsage)
  const tokens = totalTokens(sessionUsage)
  const turnWord = sessionTurns === 1 ? 'turn' : 'turns'
  return `Session: ${sessionTurns} ${turnWord} · ${formatTokenCount(tokens)} tokens · ${formatCostUsd(cost)} · ${formatElapsed(sessionElapsedMs)}`
}

/** A ten-cell block meter for the `/usage` sub-views. */
export function tokenMeter(pct: number): string {
  const clamped = Math.min(100, Math.max(0, pct))
  const filled = Math.round((clamped / 100) * 10)
  return '▓'.repeat(filled) + '░'.repeat(10 - filled)
}

/**
 * The full token-consumption breakdown shown by `/usage` → "Tokens this session".
 * `snapshot` is the cumulative session total (including any usage carried over
 * from a resumed session); the per-model rows only cover the live process.
 */
export function renderUsageBreakdown(snapshot: SessionUsageSnapshot, model: string, costLabel?: string): string {
  const u = snapshot.usage
  const total = totalTokens(u)
  const perTurn = snapshot.turns > 0 ? Math.round(total / snapshot.turns) : 0
  const lines = [
    'Tokens this session',
    '',
    `  input         ${formatTokenCount(u.inputTokens)}`,
    `  output        ${formatTokenCount(u.outputTokens)}`,
    `  cache read    ${formatTokenCount(u.cacheReadTokens)}`,
    `  cache write   ${formatTokenCount(u.cacheWriteTokens)}`,
    `  ───────────`,
    `  total         ${formatTokenCount(total)}`,
    '',
    `  turns         ${snapshot.turns}`,
    `  elapsed       ${formatElapsed(snapshot.elapsedMs)}`,
    `  per turn      ~${formatTokenCount(perTurn)} tokens`,
    `  est. cost     ${costLabel ?? `${formatCostUsd(estimateCostUsd(model, u))}  (${model})`}`,
  ]
  const byModel = sessionUsageByModel()
  if (byModel.length > 1) {
    lines.push('', '  by model')
    for (const entry of byModel) {
      lines.push(`    ${entry.model.padEnd(26)} ${formatTokenCount(totalTokens(entry.usage)).padStart(12)}  ${formatCostUsd(entry.costUsd)}`)
    }
  }
  lines.push(
    '',
    costLabel
      ? '  Token counts are reported by the provider; this plan is not billed per token.'
      : '  Estimated from published per-token rates for orientation — not an\n  authoritative bill. Cache reads are billed well below fresh input.',
  )
  return lines.join('\n')
}
