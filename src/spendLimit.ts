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

/**
 * What a model says when it needs more money to finish.
 *
 * The run is mid-task: it has a flag to capture, a payload to try, a wordlist
 * left to run. Stopping there to make a person retype the request throws away
 * the context that made the ask sensible, which is why an ask is possible at all.
 */
export function spendIncreasePrompt(state: SpendState, requestedUsd?: number): string {
  const ask = requestedUsd === undefined ? 'more budget' : `a budget of ${formatCostUsd(requestedUsd)}`
  return `[elia] Spending ceiling reached: about ${formatCostUsd(state.spentUsd)} of ${formatCostUsd(state.limitUsd)} is spent. You may call ask_user once to request ${ask} to finish this task. If the operator declines or is not present, stop calling tools and summarise what you completed, what is left, and what you would do next.`
}

/** The question put to the operator. Kept here so the loop and the prompt cannot drift apart. */
export function spendIncreaseQuestion(state: SpendState, requestedUsd?: number): string {
  const spent = state.spentUsd === undefined ? 'an unknown amount' : formatCostUsd(state.spentUsd)
  const suggested = requestedUsd ?? (state.spentUsd === undefined ? 5 : Math.max(5, Math.ceil(state.spentUsd * 4)))
  return `This run hit its spending ceiling (${spent} of ${formatCostUsd(state.limitUsd)}). Raise the ceiling so it can keep going? Enter a new total in dollars, or press enter to allow ${formatCostUsd(suggested)}. Anything else declines.`
}

/**
 * Apply an operator-approved ceiling, refusing the amounts that would not help.
 *
 * Two failures are worth naming rather than setting anyway. A ceiling at or
 * below what is already spent leaves the next `spendState` call reporting
 * `exceeded` again, so the loop would ask the operator the same question and
 * stop again on the very next step — an approval that silently does nothing is
 * worse than a refusal the operator can see. And a non-positive or unparseable
 * amount is not a budget, whatever the operator typed.
 */
export function requestSpendIncrease(
  state: SpendState,
  requestedUsd: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; limitUsd: number } | { ok: false; reason: string } {
  if (requestedUsd === undefined) {
    return { ok: false, reason: 'no new amount was given' }
  }
  if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) {
    return { ok: false, reason: `"${requestedUsd}" is not an amount` }
  }
  const spent = state.spentUsd ?? 0
  if (requestedUsd <= spent) {
    return {
      ok: false,
      reason: `${formatCostUsd(requestedUsd)} is not more than the ${formatCostUsd(spent)} already spent, so the run would stop on the very next step. Ask for a total above what has been spent.`,
    }
  }
  env.ELIA_MAX_SPEND_USD = String(requestedUsd)
  return { ok: true, limitUsd: requestedUsd }
}

/** Read an operator's answer to `spendIncreaseQuestion` into an amount, or undefined to decline. */
export function parseSpendIncreaseAnswer(raw: string, state: SpendState, requestedUsd?: number): number | undefined {
  const value = raw.trim().replace(/^\$/, '')
  if (value === '') return requestedUsd ?? (state.spentUsd === undefined ? 5 : Math.max(5, Math.ceil(state.spentUsd * 4)))
  const usd = Number.parseFloat(value)
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(usd)) return undefined
  return usd
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
