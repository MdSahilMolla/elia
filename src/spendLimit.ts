import { ZERO_USAGE, formatCostUsd, sessionCost } from './usage.ts'
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
 * A session a person starts is bounded by default: `DEFAULT_SPEND_LIMIT_USD`
 * unless `ELIA_MAX_SPEND_USD` says otherwise (`0`, `off` or `none` lift it),
 * and `/limit` changes it mid-session. Commands that measure or train elia
 * (bench, evolve, …) run to completion and get no default.
 */

/** What a session may spend when nobody said otherwise. */
export const DEFAULT_SPEND_LIMIT_USD = 1

/** Measuring and training commands: they run to completion, so no default ceiling. */
const UNCAPPED_COMMANDS = new Set(['bench', 'bench-latency', 'evolve', 'gap', 'distill', 'compounding', 'jev', 'values'])

/** Gives a session `DEFAULT_SPEND_LIMIT_USD` unless the environment already set a limit (or lifted it). */
export function applyDefaultSpendLimit(subcommand: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (env.ELIA_MAX_SPEND_USD !== undefined) return
  if (subcommand !== undefined && UNCAPPED_COMMANDS.has(subcommand)) return
  env.ELIA_MAX_SPEND_USD = String(DEFAULT_SPEND_LIMIT_USD)
}

/**
 * `/limit` — what the session may spend from here. A number in dollars sets it,
 * `off` lifts it; anything else is refused with the reason.
 */
export function setSpendLimit(raw: string, env: NodeJS.ProcessEnv = process.env): { ok: true; limitUsd?: number } | { ok: false; error: string } {
  const value = raw.trim().replace(/^\$/, '').toLowerCase()
  if (value === 'off' || value === 'none' || value === '0') {
    env.ELIA_MAX_SPEND_USD = '0'
    return { ok: true }
  }
  const usd = Number.parseFloat(value)
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(usd) || usd <= 0) return { ok: false, error: `"${raw.trim()}" is not an amount — try /limit 5 or /limit off` }
  env.ELIA_MAX_SPEND_USD = String(usd)
  return { ok: true, limitUsd: usd }
}

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
          ? `The spending limit is ${formatCostUsd(limitUsd)} but ${models} has no pricing entry, so spend cannot be measured and the limit is not being enforced.`
          : `The spending limit is ${formatCostUsd(limitUsd)} but ${models} has no pricing entry; the limit is enforced only on the priced part (${formatCostUsd(cost.usd)} so far).`,
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
  return `Stopped on the spending limit — about ${formatCostUsd(state.spentUsd)} spent of ${formatCostUsd(state.limitUsd)}. Type /limit 5 to allow more (or /limit off), then send the request again.`
}

/** `/limit [amount|off]`: shows the session's limit, or changes it, and says where spend stands. */
export function limitCommand(arg: string, model: string, env: NodeJS.ProcessEnv = process.env): string {
  const spent = sessionCost({ model, usage: ZERO_USAGE }).usd
  const spentLine = `${formatCostUsd(spent)} spent this session`
  if (arg.trim()) {
    const result = setSpendLimit(arg, env)
    if (!result.ok) return result.error
    return result.limitUsd === undefined
      ? `Spending limit lifted — this session can spend without a ceiling (${spentLine}).`
      : `Spending limit set to ${formatCostUsd(result.limitUsd)} (${spentLine}).`
  }
  const limit = spendCeilingUsd(env)
  return limit === undefined
    ? `No spending limit (${spentLine}). /limit 5 sets one.`
    : `Spending limit ${formatCostUsd(limit)} — ${spentLine}. /limit 5 raises it · /limit off lifts it.`
}
