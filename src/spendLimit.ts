import { formatCostUsd, sessionCost } from './usage.ts'
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
 * `runUsage` is what the current loop has spent so far, and `model` is the
 * model that loop runs on. It is added to the session total because
 * `recordUsage` only lands at the end of a turn — without it, a single long
 * autonomous turn could run past the ceiling unnoticed, which is exactly the
 * case the ceiling exists for.
 *
 * Everything already recorded is priced per model (usage.ts `sessionCost`):
 * a session that ran a deep lead and cheap sub-agents was priced at one rate
 * for all of it (#1245). Usage on a model with no pricing entry cannot be
 * measured; the priced part is still enforced, since it is a floor on the
 * true spend, and the gap is reported rather than hidden.
 */
export function spendState(model: string, runUsage: Usage, env: NodeJS.ProcessEnv = process.env): SpendState {
  const limitUsd = spendCeilingUsd(env)
  const cost = sessionCost({ model, usage: runUsage })
  const known = cost.unpriced.length === 0 || cost.usd > 0
  const spentUsd = known ? cost.usd : undefined
  if (limitUsd === undefined) return { ...(spentUsd === undefined ? {} : { spentUsd }), exceeded: false }
  if (cost.usd >= limitUsd) return { limitUsd, spentUsd: cost.usd, exceeded: true }
  if (cost.unpriced.length > 0) {
    const models = cost.unpriced.join(', ')
    return {
      limitUsd,
      ...(spentUsd === undefined ? {} : { spentUsd }),
      exceeded: false,
      unenforceable:
        cost.usd === 0
          ? `ELIA_MAX_SPEND_USD is set to ${formatCostUsd(limitUsd)} but ${models} has no pricing entry, so spend cannot be measured and the ceiling is not being enforced.`
          : `ELIA_MAX_SPEND_USD is set to ${formatCostUsd(limitUsd)} but ${models} has no pricing entry; the ceiling is enforced only on the priced part (${formatCostUsd(cost.usd)} so far).`,
    }
  }
  return { limitUsd, spentUsd: cost.usd, exceeded: false }
}

/** The message handed to the model when the ceiling is reached, in the same shape as the step-budget wrap-up. */
export function spendStopPrompt(state: SpendState): string {
  return `[elia] Spending ceiling reached: this session has spent about ${formatCostUsd(state.spentUsd)} against the ELIA_MAX_SPEND_USD limit of ${formatCostUsd(state.limitUsd)}. Stop calling tools and summarise what you completed, what is left, and what you would do next.`
}

/** The line shown to the operator when a run stops on spend. */
export function spendStopNotice(state: SpendState): string {
  return `Stopped on the spending ceiling — about ${formatCostUsd(state.spentUsd)} spent against a ${formatCostUsd(state.limitUsd)} limit. Raise or unset ELIA_MAX_SPEND_USD to continue.`
}
