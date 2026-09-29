import type { GenerationRecord } from './ledger.ts'

/**
 * A ceiling on what compounding may spend, so that it is never the expensive
 * part of owning elia.
 *
 * The screen and the race make most candidates cheap. This makes sure that
 * "most" is not the only thing standing between a bad day and a large bill: a
 * provider that retries, a suite that has grown, a run left going overnight.
 *
 *   - a daily ceiling on tokens spent measuring, read back from the ledger, so
 *     it holds across processes and restarts;
 *   - a per-generation ceiling, as a multiple of what one full sweep of the
 *     task set costs, because a fixed number is either far too tight for a
 *     large set or far too loose for a small one.
 *
 * A generation is refused *before* it starts if it could not be afforded to the
 * end. Stopping half way would throw away the most expensive thing there is: a
 * provisional winner that never got its confirmation.
 *
 * `ELIA_EVOLVE_BUDGET=off` removes both. Immutable to the loop (sandbox.ts).
 */

/** Tokens per day: about four sweeps of the built-in tasks, or one and a half of the whole suite. */
export const DEFAULT_DAILY_TOKENS = 80_000_000

/**
 * Sweeps one generation may spend. A candidate that loses costs at most one
 * (the race, usually far less); one that wins pays for the race and a
 * confirmation pair — three — and the half is slack for retries.
 */
export const GENERATION_SWEEPS = 3.5

/** Sweeps a generation must be able to afford to start: the winning case. */
export const WORST_CASE_SWEEPS = 3

const DAY_MS = 24 * 60 * 60 * 1000

export interface BudgetPolicy {
  enabled: boolean
  dailyTokens: number
  generationSweeps: number
}

function positive(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function budgetPolicy(env: Record<string, string | undefined> = process.env): BudgetPolicy {
  return {
    enabled: (env.ELIA_EVOLVE_BUDGET ?? '').trim().toLowerCase() !== 'off',
    dailyTokens: positive(env.ELIA_EVOLVE_DAILY_TOKENS) ?? DEFAULT_DAILY_TOKENS,
    generationSweeps: positive(env.ELIA_EVOLVE_GENERATION_SWEEPS) ?? GENERATION_SWEEPS,
  }
}

/** What a generation cost to reach its verdict: the recorded total, or for older records the race alone. */
export function tokensSpent(record: Pick<GenerationRecord, 'costTokens' | 'evidenceCost'>): number {
  return record.costTokens ?? record.evidenceCost?.tokens ?? 0
}

export function spentInLastDay(records: readonly Pick<GenerationRecord, 'at' | 'costTokens' | 'evidenceCost'>[], now = Date.now()): number {
  return records.filter((record) => record.at > now - DAY_MS).reduce((sum, record) => sum + tokensSpent(record), 0)
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: string }

const millions = (tokens: number) => `${(tokens / 1e6).toFixed(1)}M`

/**
 * Whether a generation may start. `sweepTokens` is what one full sweep of the
 * run's task set cost the baseline: the unit the per-generation ceiling is in.
 */
export function mayStart(
  policy: BudgetPolicy,
  records: readonly Pick<GenerationRecord, 'at' | 'costTokens' | 'evidenceCost'>[],
  sweepTokens: number,
  now = Date.now(),
): BudgetVerdict {
  if (!policy.enabled) return { ok: true }
  const spent = spentInLastDay(records, now)
  const remaining = policy.dailyTokens - spent
  const needed = WORST_CASE_SWEEPS * sweepTokens
  if (remaining <= 0) {
    return { ok: false, reason: `the daily budget is spent (${millions(spent)} of ${millions(policy.dailyTokens)} tokens in the last 24 hours) — ELIA_EVOLVE_DAILY_TOKENS raises it, ELIA_EVOLVE_BUDGET=off removes it` }
  }
  if (needed > remaining) {
    return { ok: false, reason: `a generation that wins costs about ${millions(needed)} tokens (${WORST_CASE_SWEEPS} sweeps of ${millions(sweepTokens)}) and ${millions(remaining)} of today's ${millions(policy.dailyTokens)} are left — not started, because a winner that cannot be confirmed is the most expensive thing to lose` }
  }
  return { ok: true }
}

/** Whether a generation that has already spent `spent` tokens has overrun its own ceiling. */
export function overran(policy: BudgetPolicy, spent: number, sweepTokens: number): BudgetVerdict {
  if (!policy.enabled) return { ok: true }
  const ceiling = policy.generationSweeps * sweepTokens
  return spent > ceiling ? { ok: false, reason: `this generation has spent ${millions(spent)} tokens, past its ${millions(ceiling)} ceiling (${policy.generationSweeps} sweeps of ${millions(sweepTokens)})` } : { ok: true }
}
