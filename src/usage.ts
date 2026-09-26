import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Usage } from './providers/types.ts'
import { logSwallowedError } from './diagnostics.ts'

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

export function addUsage(a: Usage, b: Usage): Usage {
  const cacheWrite1hTokens = (a.cacheWrite1hTokens ?? 0) + (b.cacheWrite1hTokens ?? 0)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    // Carried only when something reported it, so a sum of usages from
    // providers that never split cache writes stays the same shape it was.
    ...(cacheWrite1hTokens > 0 ? { cacheWrite1hTokens } : {}),
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
  /** A 5-minute cache write — and any write whose lifetime was not reported. */
  cacheWritePerM?: number
  /** A 1-hour cache write. Falls back to `cacheWritePerM` when absent. */
  cacheWrite1hPerM?: number
}

// Providers change pricing without notice — treat this as a best-effort
// estimate for orientation, not an authoritative bill.
//
// Claude rates: first-party Claude API, checked against
// platform.claude.com/docs/en/about-claude/pricing on 2026-09-15. Cache writes
// are 1.25× input for a 5-minute lifetime and 2× for 1 hour; cache reads are
// 0.1× input — except Fable 5.1, whose reads are 0.025× ($0.25/MTok). Sonnet 5's
// $2/$10 began as introductory pricing; that page states it is now the standard
// price and the scheduled rise to $3/$15 will not happen.
//
// Every model elia can route to should be here. One that is not cannot be
// priced, and ELIA_MAX_SPEND_USD then reports itself unenforceable for it —
// honest, but it means Opus, the costliest tier, ran with no ceiling at all.
const PRICING: Record<string, Pricing> = {
  'claude-fable-5-1': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5, cacheWrite1hPerM: 20 },
  'claude-opus-5': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, cacheWrite1hPerM: 10 },
  'claude-opus-4-8': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, cacheWrite1hPerM: 10 },
  'claude-sonnet-5': { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, cacheWrite1hPerM: 4 },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25, cacheWrite1hPerM: 2 },
  'gpt-4.1': { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  'openai/gpt-oss-120b': { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },
  'openai/gpt-oss-20b': { inputPerM: 0.075, outputPerM: 0.3, cacheReadPerM: 0.0375 },
  'mercury-2': { inputPerM: 0.15, outputPerM: 0.35, cacheReadPerM: 0.025 },
  'mercury-2.5': { inputPerM: 0.2, outputPerM: 0.75, cacheReadPerM: 0.02 },
}

/**
 * A model not in the hardcoded table above (a newer release, a provider this
 * table has no verified rate for) shows "cost unknown" rather than a guessed
 * number — fabricating a price would be worse than not showing one. This is
 * the honest alternative: let the operator supply their own verified rate in
 * `.elia/pricing.json` (shaped `{ "<model>": { "inputPerM": n, "outputPerM": n,
 * "cacheReadPerM"?: n, "cacheWritePerM"?: n, "cacheWrite1hPerM"?: n } }`), which is consulted first —
 * an entry here can also override a built-in rate that has drifted.
 */
let customPricingCache: { path: string; pricing: Record<string, Pricing> } | undefined

function loadCustomPricing(cwd = process.cwd()): Record<string, Pricing> {
  const path = join(cwd, '.elia', 'pricing.json')
  if (customPricingCache?.path === path) return customPricingCache.pricing
  if (!existsSync(path)) {
    customPricingCache = { path, pricing: {} }
    return customPricingCache.pricing
  }
  let pricing: Record<string, Pricing> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') {
      for (const [model, rate] of Object.entries(parsed as Record<string, unknown>)) {
        if (isValidPricing(rate)) pricing[model] = rate
      }
    }
  } catch (err) {
    logSwallowedError('usage.loadCustomPricing', err, { path })
    pricing = {}
  }
  customPricingCache = { path, pricing }
  return pricing
}

function isValidPricing(value: unknown): value is Pricing {
  if (!value || typeof value !== 'object') return false
  const rate = value as Record<string, unknown>
  const numeric = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!numeric(rate.inputPerM) || !numeric(rate.outputPerM)) return false
  if (rate.cacheReadPerM !== undefined && !numeric(rate.cacheReadPerM)) return false
  if (rate.cacheWritePerM !== undefined && !numeric(rate.cacheWritePerM)) return false
  if (rate.cacheWrite1hPerM !== undefined && !numeric(rate.cacheWrite1hPerM)) return false
  return true
}

/** Test seam. */
export function clearCustomPricingCache(): void {
  customPricingCache = undefined
}

/**
 * A provider-reported token count should always be a finite, non-negative
 * integer, but nothing upstream enforces that — a malformed API response or
 * a bad manual Usage value would otherwise propagate straight into a dollar
 * figure (including, for a negative count, a negative cost). Treat anything
 * else as 0 and record it once via diagnostics rather than silently
 * fabricating a number or throwing.
 */
function sanitizeTokenCount(field: keyof Usage, value: number): number {
  if (Number.isFinite(value) && value >= 0) return value
  logSwallowedError('usage.estimateCostUsd.badTokenCount', new Error(`non-finite or negative ${field}`), { field, value })
  return 0
}

/**
 * Models running on the person's own machine (Ollama). They have no API price,
 * so they cost $0 rather than "unknown" — which also keeps a spend ceiling from
 * reporting itself unenforceable for them. A `.elia/pricing.json` entry still wins.
 */
const localModels = new Set<string>()

export function declareLocalModel(model: string): void {
  localModels.add(model)
}

/** Undefined when the model isn't in the pricing table — callers should show "unknown", never a fabricated number. */
export function estimateCostUsd(model: string, usage: Usage, cwd = process.cwd()): number | undefined {
  const pricing = loadCustomPricing(cwd)[model] ?? PRICING[model]
  if (!pricing) return localModels.has(model) ? 0 : undefined

  const inputTokens = sanitizeTokenCount('inputTokens', usage.inputTokens)
  const outputTokens = sanitizeTokenCount('outputTokens', usage.outputTokens)
  const cacheReadTokens = sanitizeTokenCount('cacheReadTokens', usage.cacheReadTokens)
  const cacheWriteTokens = sanitizeTokenCount('cacheWriteTokens', usage.cacheWriteTokens)
  // The 1-hour share of the writes, never more than the writes themselves — a
  // provider reporting an inconsistent split must not be billed twice for it.
  const cacheWrite1hTokens = Math.min(cacheWriteTokens, sanitizeTokenCount('cacheWrite1hTokens', usage.cacheWrite1hTokens ?? 0))
  const cacheWrite5mTokens = cacheWriteTokens - cacheWrite1hTokens
  const write5mRate = pricing.cacheWritePerM ?? pricing.inputPerM

  return (
    (inputTokens / 1_000_000) * pricing.inputPerM +
    (outputTokens / 1_000_000) * pricing.outputPerM +
    (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerM ?? pricing.inputPerM) +
    (cacheWrite5mTokens / 1_000_000) * write5mRate +
    (cacheWrite1hTokens / 1_000_000) * (pricing.cacheWrite1hPerM ?? write5mRate)
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

export interface SessionCost {
  /** What the priced usage cost, each model's tokens at that model's own rate. */
  usd: number
  /** Models with usage but no pricing entry, whose share is not in `usd`. */
  unpriced: string[]
}

/**
 * What this session has cost, summed per model.
 *
 * A session touches several models — the deep lead, fast-tier sub-agents, the
 * brain, reviewers — and pricing the summed tokens at any one of them is wrong
 * in both directions (#1245). `extra` adds usage not recorded yet, such as the
 * loop that is still running, at the model it runs on.
 */
export function sessionCost(extra?: { model: string; usage: Usage }): SessionCost {
  const entries: Array<[string, Usage]> = [...usageByModel.entries()]
  if (extra && totalTokens(extra.usage) > 0) entries.push([extra.model, extra.usage])
  let usd = 0
  const unpriced: string[] = []
  for (const [model, usage] of entries) {
    if (totalTokens(usage) === 0) continue
    const cost = estimateCostUsd(model, usage)
    if (cost === undefined) {
      if (!unpriced.includes(model)) unpriced.push(model)
    } else usd += cost
  }
  return { usd, unpriced }
}

/** The session's cost for display: exact when every model is priced, a floor marked as such when not. */
export function formatSessionCost(cost: SessionCost = sessionCost()): string {
  if (cost.unpriced.length === 0) return formatCostUsd(cost.usd)
  if (cost.usd === 0) return formatCostUsd(undefined)
  return `${formatCostUsd(cost.usd)}+ (${cost.unpriced.join(', ')} unpriced)`
}

/** Session totals are process-wide; tests that record usage clear them so later tests start from zero. */
export function resetSessionUsageForTests(): void {
  sessionUsage = ZERO_USAGE
  sessionTurns = 0
  sessionElapsedMs = 0
  usageByModel.clear()
}

export function recordTopLevelTurn(elapsedMs: number): void {
  sessionTurns += 1
  sessionElapsedMs += elapsedMs
}

// --- Live output, while the turn is still running ---
// The session totals above only move when a whole turn or sub-agent run *ends*,
// which is far too coarse for the working line: a two-minute turn spread over
// six model calls would sit on one number the entire time and then jump at the
// receipt. These events fire as it runs — one per finished model call carrying
// the usage that call really reported, plus an estimate for output that has
// streamed but not been billed yet — so the line counts what elia is producing
// while it produces it. Nothing here records anything; it is display only.

export type LiveOutput =
  /** A model call finished and reported its real output tokens. Replaces the running estimate. */
  | { kind: 'settled'; outputTokens: number }
  /** Characters seen mid-call that no usage has covered yet — streamed tool arguments. */
  | { kind: 'streaming'; chars: number }

const liveListeners = new Set<(event: LiveOutput) => void>()

/** Watch what the running turn produces. Returns the unsubscribe. */
export function onLiveOutput(listener: (event: LiveOutput) => void): () => void {
  liveListeners.add(listener)
  return () => {
    liveListeners.delete(listener)
  }
}

/** Tell every watcher what just landed. A listener that throws must not take the turn down with it. */
export function reportLiveOutput(event: LiveOutput): void {
  if (liveListeners.size === 0) return
  for (const listener of [...liveListeners]) {
    try {
      listener(event)
    } catch (error) {
      logSwallowedError('live output listener', error)
    }
  }
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
export function formatCompactUsage(): string {
  return `${formatTokenCount(sessionUsage.inputTokens + sessionUsage.cacheReadTokens)} in · ${formatTokenCount(sessionUsage.outputTokens)} out · ${formatSessionCost()}`
}

export function getSessionSummaryLine(): string {
  const tokens = totalTokens(sessionUsage)
  const turnWord = sessionTurns === 1 ? 'turn' : 'turns'
  return `Session: ${sessionTurns} ${turnWord} · ${formatTokenCount(tokens)} tokens · ${formatSessionCost()} · ${formatElapsed(sessionElapsedMs)}`
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
