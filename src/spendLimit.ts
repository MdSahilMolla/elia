import { addUsage, estimateCostUsd, formatCostUsd, sessionUsageSnapshot } from './usage.ts'
import type { Usage } from './providers/types.ts'

/**
 * A hard ceiling on what one session may spend.
 *
 * Every budget elia enforced was a proxy: a step ceiling (80 model calls), an
 * action budget, a wall clock. None of them is money, and the cost of a "step"
 * varies by two orders of magnitude with context size and model — so an
 * unattended run had no bound on spend at all. `estimateCostUsd` existed and was
 * accurate, but every one of its call sites was a formatter: `/usage`, the
 * status line, the session summary. Nothing ever read it back to decide
 * anything.
 *
 * Set `ELIA_MAX_SPEND_USD` to bound it. Unset, nothing changes.
 */

export interface SpendState {
  /** Configured ceiling in USD, or undefined when none is set. */
  limitUsd?: number
  /** Best estimate of what this session has spent so far, or undefined when the model has no pricing entry. */
  spentUsd?: number
  /** True only when a ceiling is set, spend is known, and it has been reached. */
  exceeded: boolean
  /**
   * Set when a ceiling is configured but cannot be enforced, because the model
   * in use has no pricing entry. Enforcement that silently does nothing is worse
   * than no enforcement — the operator believes they are covered — so this is
   * surfaced rather than swallowed.
   */
  unenforceable?: string
}

/** The configured ceiling, or undefined. Invalid values are ignored rather than failing a run. */
export function spendCeilingUsd(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.ELIA_MAX_SPEND_USD?.trim()
  if (!raw) return undefined
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Where this session stands against its ceiling.
 *
 * `runUsage` is what the current loop has spent so far. It is added to the
 * session total because `recordUsage` only lands at the end of a turn — without
 * it, a single long autonomous turn could run past the ceiling unnoticed,
 * which is exactly the case the ceiling exists for.
 */
export function spendState(model: string, runUsage: Usage, env: NodeJS.ProcessEnv = process.env): SpendState {
  const limitUsd = spendCeilingUsd(env)
  const spentUsd = estimateCostUsd(model, addUsage(sessionUsageSnapshot().usage, runUsage))
  if (limitUsd === undefined) return { spentUsd, exceeded: false }
  if (spentUsd === undefined) {
    return {
      limitUsd,
      exceeded: false,
      unenforceable: `ELIA_MAX_SPEND_USD is set to ${formatCostUsd(limitUsd)} but ${model} has no pricing entry, so spend cannot be measured and the ceiling is not being enforced.`,
    }
  }
  return { limitUsd, spentUsd, exceeded: spentUsd >= limitUsd }
}

/** The message handed to the model when the ceiling is reached, in the same shape as the step-budget wrap-up. */
export function spendStopPrompt(state: SpendState): string {
  return `[elia] Spending ceiling reached: this session has spent about ${formatCostUsd(state.spentUsd)} against the ELIA_MAX_SPEND_USD limit of ${formatCostUsd(state.limitUsd)}. Stop calling tools and summarise what you completed, what is left, and what you would do next.`
}

/** The line shown to the operator when a run stops on spend. */
export function spendStopNotice(state: SpendState): string {
  return `Stopped on the spending ceiling — about ${formatCostUsd(state.spentUsd)} spent against a ${formatCostUsd(state.limitUsd)} limit. Raise or unset ELIA_MAX_SPEND_USD to continue.`
}
