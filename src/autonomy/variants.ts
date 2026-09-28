import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { planWaves, runFleet } from './fleet.ts'
import { runVerification } from './verify.ts'
import { createWorktree, diffChurn, mergeWorktreeIntoCwd, removeWorktree, type Worktree } from './worktree.ts'
import { ZERO_USAGE, addUsage, totalTokens } from '../usage.ts'
import { writeFail, writePass, writeSubStep } from '../ui/report.ts'
import { paths } from '../config.ts'
import type { Usage } from '../providers/types.ts'
import type { Journal } from './journal.ts'
import type { ActionGovernor } from './governor.ts'
import type { GoalGraphStore } from './goalGraph.ts'
import type { Proposal, ProposalStep } from './types.ts'

export interface VariantOutcome {
  index: number
  worktree: Worktree
  passed: boolean
  usage: Usage
  elapsedMs: number
  verificationSummary: string
  /** How many verification commands failed or timed out — 0 for a passing variant. */
  failedCount: number
  /** Lines changed against HEAD (tracked diff + untracked file contents). undefined if it could not be measured. */
  diffChurn?: number
}

export interface VariantsResult {
  chosen: VariantOutcome
  all: VariantOutcome[]
  usage: Usage
  /** Files copied from the chosen variant's worktree into the real working tree. */
  mergedFiles: string[]
}

export interface RunVariantsOptions {
  proposal: Proposal
  briefing: string
  count: number
  runId: string
  journal?: Journal
  governor?: ActionGovernor
  graph?: GoalGraphStore
  signal?: AbortSignal
}

/**
 * Runs the proposal's execute phase `count` times, each in its own isolated
 * git worktree, then lets verification — an objective, cheap, non-LLM oracle
 * — pick the winner: a variant that fails typecheck/tests/build can never
 * beat one that passes, no matter how confident either implementation's own
 * report sounds. Only the winner's files are copied into the real working
 * tree; every worktree, winner included, is discarded afterward.
 *
 * Among variants that pass equally, the smaller diff against HEAD wins before
 * cost does — cost alone used to decide (fewest tokens, then fastest), which
 * meant a needlessly sprawling but cheap-to-generate change could beat a
 * tighter, more surgical one with no signal for that at all. If every variant
 * fails, the fallback is no longer always variant 1: it ranks by how many
 * verification commands actually failed, so the attempt closest to passing
 * feeds the repair loop instead of an arbitrary one.
 *
 * Deliberately does NOT run the critic/security/bughunter review panel per
 * variant — that would multiply an already N-times-more-expensive phase by
 * another 3x for N-1 attempts that get thrown away regardless. Verification
 * (plus diff size as a tiebreaker) alone picks the winner; the caller's
 * normal verify-phase loop still reviews the merged result afterward exactly
 * as it would for a single-plan run.
 */
export async function runVariants(options: RunVariantsOptions): Promise<VariantsResult> {
  const { proposal, briefing, count, runId, journal, governor, graph, signal } = options
  const { waves } = planWaves(proposal.steps)

  writeSubStep(`running ${count} independent implementation attempts in parallel, each in its own isolated worktree`)
  journal?.append('variants', { phase: 'start', count })

  const outcomes = await Promise.all(
    Array.from({ length: count }, (_, index) => runOneVariant(index, waves, proposal, briefing, runId, governor, graph, signal)),
  )

  const usage = outcomes.reduce((total, outcome) => addUsage(total, outcome.usage), ZERO_USAGE)

  const chosen = rankVariants(outcomes)[0]!

  for (const outcome of outcomes) {
    const label = `variant ${outcome.index + 1}/${count}`
    if (outcome === chosen) writePass(`${label} — chosen (${outcome.verificationSummary})`)
    else if (outcome.passed) writeSubStep(`${label} — passed but not chosen (${outcome.verificationSummary})`)
    else writeFail(`${label} — discarded (${outcome.verificationSummary})`)
  }

  const mergedFiles = await mergeWorktreeIntoCwd(chosen.worktree)
  await Promise.all(outcomes.map((outcome) => removeWorktree(outcome.worktree)))
  // Each removeWorktree only takes its own leaf dir with it; clean up the now-empty
  // per-run parent so `.elia/worktrees/` doesn't accumulate one empty dir per run.
  await rm(join(paths.state, 'worktrees', runId), { recursive: true, force: true }).catch(() => {})

  journal?.append('variants', {
    phase: 'done',
    chosen: chosen.index,
    outcomes: outcomes.map((outcome) => ({ index: outcome.index, passed: outcome.passed, elapsedMs: outcome.elapsedMs, failedCount: outcome.failedCount, diffChurn: outcome.diffChurn })),
    mergedFiles,
  })

  return { chosen, all: outcomes, usage, mergedFiles }
}

/**
 * Ranks variants best-first: pass/fail beats everything (a variant that
 * fails typecheck/tests/build can never outrank one that passes), then among
 * ties the smaller diff against HEAD, then the cheaper token cost, then the
 * faster wall-clock time. If every variant failed, ranks the whole set by
 * how many verification commands each one actually failed instead of falling
 * back to an arbitrary one — the fewest-failures attempt is the one closest
 * to passing and the best input to the repair loop that runs next.
 */
export function rankVariants(outcomes: VariantOutcome[]): VariantOutcome[] {
  const passing = outcomes.filter((outcome) => outcome.passed)
  const ranked = [...(passing.length > 0 ? passing : outcomes)]
  ranked.sort((a, b) =>
    a.failedCount - b.failedCount
    || diffChurnOrInfinity(a) - diffChurnOrInfinity(b)
    || totalTokens(a.usage) - totalTokens(b.usage)
    || a.elapsedMs - b.elapsedMs,
  )
  return ranked
}

async function runOneVariant(
  index: number,
  waves: ProposalStep[][],
  proposal: Proposal,
  briefing: string,
  runId: string,
  governor: ActionGovernor | undefined,
  graph: GoalGraphStore | undefined,
  signal: AbortSignal | undefined,
): Promise<VariantOutcome> {
  const startedAt = Date.now()
  const worktree = await createWorktree(runId, index)
  let usage = ZERO_USAGE

  const variantBriefing = `${briefing}\n\n## You are implementation attempt ${index + 1} of a best-of-N run\nOther independent attempts at this exact same goal are running in parallel in their own isolated copies of the repo right now. Work in yours as if it were the only one — implement your best, most direct solution to the goal and the verification commands. You don't need to hedge or match what another attempt might choose.`

  try {
    for (const [waveIndex, wave] of waves.entries()) {
      if (signal?.aborted) break
      const fleet = await runFleet({
        assignments: wave.map((step) => ({ id: step.id, title: step.title, role: step.role, instructions: step.instructions })),
        briefing: variantBriefing,
        showBoard: false,
        cwd: worktree.path,
        stripBoardTools: true,
        runId,
        governor,
        graph,
        signal,
        wave: waveIndex + 1,
      })
      usage = addUsage(usage, fleet.usage)
    }

    const verification = await runVerification(proposal.verification, worktree.path, signal, governor)
    const failedCount = verification.results.filter((result) => result.exitCode !== 0 || result.timedOut).length
    const verificationSummary = verification.passed
      ? 'verification passed'
      : `verification failed (${failedCount}/${verification.results.length} command${verification.results.length === 1 ? '' : 's'})`
    const churn = await diffChurn(worktree).catch(() => undefined)

    return { index, worktree, passed: verification.passed, usage, elapsedMs: Date.now() - startedAt, verificationSummary, failedCount, diffChurn: churn }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The attempt never reached (or never finished) verification, so there is
    // no real failedCount to report — scored as having failed everything, so
    // it never outranks an attempt that at least ran and failed only some
    // commands in the all-fail fallback ranking above.
    return { index, worktree, passed: false, usage, elapsedMs: Date.now() - startedAt, verificationSummary: `attempt failed: ${message}`, failedCount: Math.max(1, proposal.verification.length) }
  }
}

/** `diffChurn` sorts ascending, so a variant whose churn could not be measured must rank last, not first. */
function diffChurnOrInfinity(outcome: VariantOutcome): number {
  return outcome.diffChurn ?? Number.POSITIVE_INFINITY
}
