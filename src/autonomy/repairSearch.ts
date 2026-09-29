import { dirname, join, relative } from 'node:path'
import { config } from '../config.ts'
import { paths } from '../statePaths.ts'
import { spendState } from '../spendLimit.ts'
import { ZERO_USAGE, addUsage, totalTokens } from '../usage.ts'
import type { Usage } from '../providers/types.ts'
import { runSubAgent } from '../subagent.ts'
import { MAX_DELEGATION_DEPTH } from '../tools/delegate.ts'
import { toolsForRole } from './roles.ts'
import { withAgentIdentity } from './context.ts'
import { withActionGovernor, type ActionGovernor } from './governor.ts'
import { withoutGoalGraph } from './goalGraph.ts'
import { isSensitivePath } from './sensitivePaths.ts'
import { describeVerification, runVerification, type VerificationOutcome } from './verify.ts'
import { isolatedSearch, type AttemptRunner } from '../reason/attempt.ts'
import { APPROACHES_BY_CLASS, type Harness } from '../reason/harness.ts'
import { libraryPath, readLibrary, recordOutcome } from '../reason/library.ts'
import { metaPath, planHarness, plannerEnabled, recordMeta, worldContext, type WorldContext } from '../reason/plan.ts'
import { successOf } from '../reason/reason.ts'
import { readPriors } from '../world/runtime.ts'
import { solve } from '../reason/select.ts'
import { signatureKey, type TaskFeatures, type TaskSignature } from '../reason/signature.ts'
import type { Verdict, Verifier } from '../reason/verify.ts'

/**
 * The reasoning layer (src/reason/) inside the autonomous pipeline.
 *
 * `reason/` was built for the REPL: `runSearchedTurn` in cli/interactive.ts is a
 * closure that is mutually exclusive with escalating into the pipeline
 * (`!escalation.escalate`), so `elia auto`, the autopilot, the daemon and MCP
 * runs — every unattended path — repaired with one generalist agent, in a
 * straight line, and the harness library never saw them. This is the bridge, and
 * it exists as its own module because four things that are harmless in the REPL
 * are not harmless here:
 *
 * 1. The durable ledger keys an action on (run, node, tool, input) — no working
 *    directory — and replays a completed call instead of running it
 *    (agentLoop.ts). `runSubAgent` inherits the ambient goal graph and puts every
 *    attempt on the root node, so a second attempt issuing a byte-identical
 *    write or install in its own checkout would be answered from the first
 *    attempt's record and never run. The REPL has no graph, which is the only
 *    reason it never happened there. The attempts here run outside the graph.
 * 2. `commandVerifier` calls `runShell` directly. In a supervised REPL that is the
 *    user's own project commands; unattended, every shell command goes through
 *    the governor, and so does the check here (`runVerification`).
 * 3. Merging a winner copies files straight into the tree, past the governor. So
 *    a winner that touched a sensitive path, or one the operator already had
 *    uncommitted edits to, is not merged.
 * 4. A search is judged by a check, and a check that passes for every attempt
 *    launders a guess into a verdict (reason/signature.ts). So this only runs
 *    against a red build, where the failing command is the check; a stall the
 *    reviewers cause, with the build green, stays with the linear repair.
 *
 * What it buys is tokens spent only where the linear repair has already had its
 * say: the caller reaches for it on a wrong-approach stall, in place of asking
 * the same lead a third time. A failure of any kind returns undefined, and the
 * linear repair that would have run anyway runs.
 */

/** Off by default until it has run against a real model: `ELIA_REPAIR_SEARCH=on`. */
export function repairSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ELIA_REPAIR_SEARCH === 'on'
}

/**
 * The line of attack a repair pass is told to start from.
 *
 * Every pass used to be told the same thing — diagnose, then fix — so a run's
 * second and third attempts re-took the first one's route with a failure note.
 * The reasoning layer already knows four genuinely different ways into a
 * failing check (harness.ts); this hands out the next one each time, at no
 * extra cost: the same number of agents, a different first move.
 * `ELIA_REPAIR_APPROACHES=off` restores the old prompt.
 */
export function repairApproachDirective(gateAttempt: number, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ELIA_REPAIR_APPROACHES === 'off') return ''
  const approaches = APPROACHES_BY_CLASS.repair
  if (approaches.length === 0 || !Number.isFinite(gateAttempt) || gateAttempt < 1) return ''
  const approach = approaches[(Math.floor(gateAttempt) - 1) % approaches.length]!
  return `\n\n## Approach for this attempt (${approach.id})\n${approach.instruction}`
}

/**
 * Filed apart from the REPL's `repair/...` keys on purpose. A REPL repair
 * search opens with a first attempt of its own; this one opens only after the
 * linear repair stalled, so what a harness costs and what it wins are different
 * quantities, and mixing them would teach the library the wrong thing.
 */
export function stalledRepairSignature(input: { files: readonly string[]; acceptanceCriteria: number; hasCheck: boolean }): TaskSignature {
  const features: TaskFeatures = {
    hasExecutableCheck: input.hasCheck,
    namesTargets: input.files.length > 0,
    multiFile: input.files.length > 1,
    statesAcceptance: input.acceptanceCriteria > 0,
  }
  return { taskClass: 'repair', features, key: `stalled-${signatureKey('repair', features)}` }
}

/**
 * The shapes a stalled-repair search can take: two lines of attack, or three.
 * One round each (`maxAttempts` is the width) — refining the leader is what the
 * linear repair does next anyway, and every extra round is a full builder.
 *
 * The pool is rotated by the linear passes already spent, so the search opens
 * with approaches nobody has tried on this failure yet.
 */
export function stalledRepairHarnesses(spent: number): Harness[] {
  const pool = APPROACHES_BY_CLASS.repair
  if (pool.length === 0) return []
  const offset = ((Math.max(0, Math.floor(spent)) % pool.length) + pool.length) % pool.length
  const approaches = [...pool.slice(offset), ...pool.slice(0, offset)]
  const shape = (id: string, width: number, subsetOf?: string): Harness => ({
    id,
    width,
    maxAttempts: width,
    approaches,
    verifier: 'project-tests',
    allowUnverifiedStop: false,
    effort: 'medium',
    ...(subsetOf ? { subsetOf } : {}),
  })
  // Two lines of attack are the first two of the three: the trio verifies whenever the duo does.
  return [shape('duo', Math.min(2, approaches.length), 'trio'), shape('trio', Math.min(3, approaches.length))]
}

export interface StalledRepairInput {
  /** The tree the attempts branch from and the winner is merged back into. */
  workspaceRoot: string
  runId: string
  /** The repair brief the linear pass would have had: what failed, what is still owed, the change of tack. */
  problem: string
  /** The run's own briefing — its goal and what planning established. */
  briefing: string
  verification: string[]
  verificationRoot: string
  governor: ActionGovernor
  signal?: AbortSignal
  /** Linear repair passes already spent on the build gate; the search opens with approaches after those. */
  spent: number
  files: readonly string[]
  acceptanceCriteria: number
  /** Repo-relative paths the run must never change — the operator's own uncommitted work. */
  protectedPaths: readonly string[]
  libraryFile?: string
  /** Runs one attempt in its own checkout. Defaults to a builder sub-agent; injected by tests. */
  run?: AttemptRunner
  /** Runs the governed check in a checkout. Defaults to `runVerification`; injected by tests. */
  check?: typeof runVerification
  onNote?: (text: string) => void
}

export interface StalledRepairResult {
  /** Paths merged into the workspace, relative to its root. */
  merged: string[]
  /** The winning attempt's own report. */
  report: string
  usage: Usage
  harnessId: string
  attempts: number
  tokens: number
  /** What passed, in the check's words. */
  detail: string
}

const BOARD_TOOLS = new Set(['board_post', 'board_read'])
const MAX_EVIDENCE_CHARS = 4_000

function clip(text: string): string {
  if (text.length <= MAX_EVIDENCE_CHARS) return text
  return `${text.slice(0, Math.floor(MAX_EVIDENCE_CHARS * 0.6))}\n…\n${text.slice(-Math.floor(MAX_EVIDENCE_CHARS * 0.4))}`
}

/**
 * A governed run of the project's checks, as a verdict. A check the governor
 * refused, or one that ran no tests, proves nothing — neither is a pass.
 */
function verdictOf(outcome: VerificationOutcome, declared: number, elapsedMs: number): Verdict {
  const ran = outcome.results.filter((result) => !result.command.startsWith('[skipped]'))
  const passedCount = ran.filter((result) => result.exitCode === 0 && !result.timedOut).length
  const passed = outcome.passed && !outcome.blocked && !outcome.inconclusive && ran.length > 0
  const detail = passed
    ? `${passedCount} check(s) passed`
    : outcome.blocked
      ? 'a check was refused by the governor'
      : outcome.inconclusive
        ? `inconclusive — ${outcome.inconclusive}`
        : `verification failed (${passedCount}/${declared} check(s) passed)`
  return {
    passed,
    strength: 'executed',
    detail,
    evidence: passed ? '' : clip(describeVerification(outcome)),
    ...(declared > 0 ? { progress: passedCount / declared } : {}),
    elapsedMs,
  }
}

/**
 * Opens a few genuinely different attempts at a red build, each in its own git
 * worktree, and merges the first one the governed checks pass.
 *
 * Undefined means "nothing was merged, carry on with the linear repair": no
 * attempt passed, the winner touched something a run may not change, the
 * spending ceiling is reached, or anything at all went wrong.
 */
export async function runStalledRepairSearch(input: StalledRepairInput): Promise<StalledRepairResult | undefined> {
  const say = input.onNote ?? (() => undefined)
  if (input.signal?.aborted || input.verification.length === 0) return undefined
  if (spendState(config.model, ZERO_USAGE).exceeded) {
    say('repair search skipped — the spending ceiling is reached')
    return undefined
  }

  const signature = stalledRepairSignature({ files: input.files, acceptanceCriteria: input.acceptanceCriteria, hasCheck: true })
  const harnesses = stalledRepairHarnesses(input.spent)
  if (harnesses.length === 0) return undefined
  // `paths.state`, not `libraryPath()`'s default: that one is built from the
  // `stateDir` constant, which the test preload does not redirect, so a run
  // driven by a test would file its outcome in the developer's real library.
  const file = input.libraryFile ?? libraryPath(join(paths.state, 'reason'))
  let context: WorldContext | undefined
  try {
    context = worldContext(readPriors())
  } catch {
    // A world record that cannot be read is no reason not to repair.
  }
  const choice = planHarness({
    signature: signature.key,
    candidates: harnesses.map((candidate) => ({ id: candidate.id, maxAttempts: candidate.maxAttempts, ...(candidate.subsetOf ? { subsetOf: candidate.subsetOf } : {}) })),
    library: readLibrary(file),
    ...(context ? { context } : {}),
    enabled: plannerEnabled(),
  })
  const harness = harnesses.find((candidate) => candidate.id === choice.harnessId) ?? harnesses[0]!
  say(`repair search (${harness.id}): ${choice.reason}`)

  // The first attempt whose check passes stops the others mid-work: the losers'
  // remaining steps are the largest cost a search has, and buy nothing once a
  // check has already been passed.
  const siblings = new AbortController()
  const verdicts = new Map<string, Verdict>()
  let usage: Usage = ZERO_USAGE
  // Counted where each attempt finishes, not from `solve`'s result: `solve`
  // returns the moment the first candidate proves out and never sees the cost of
  // a sibling that was stopped, which is spend the receipt and the library must
  // still carry.
  let attemptsRun = 0
  let tokensSpent = 0
  const check = input.check ?? runVerification
  const stopped = (): Verdict => ({ passed: false, strength: 'executed', detail: 'stopped — another attempt had already passed', evidence: '', elapsedMs: 0 })

  const checkTree = async (cwd: string): Promise<Verdict> => {
    const started = Date.now()
    const inside = relative(input.workspaceRoot, input.verificationRoot)
    const root = inside && !inside.startsWith('..') ? join(cwd, inside) : cwd
    const outcome = await check(input.verification, root, input.signal, input.governor)
    return verdictOf(outcome, input.verification.length, Date.now() - started)
  }

  // Judged where each attempt finished, then handed to `solve` from the cache,
  // so a passing attempt's tests run once and a stopped sibling's not at all.
  const verifier: Verifier = {
    id: 'project checks (governed)',
    strength: 'executed',
    costHint: 'dear',
    async run(candidate) {
      if (!candidate.cwd) return { passed: false, strength: 'executed', detail: 'no working tree to check', evidence: '', elapsedMs: 0 }
      const known = verdicts.get(candidate.cwd)
      if (known) return known
      if (siblings.signal.aborted) return stopped()
      const verdict = await checkTree(candidate.cwd)
      verdicts.set(candidate.cwd, verdict)
      return verdict
    },
  }

  // No blackboard (attempts must not leak findings to each other) and no
  // delegation (a builder opening its own fleet would multiply the bill).
  const tools = toolsForRole('builder').filter((tool) => !BOARD_TOOLS.has(tool.name))
  const attempt: AttemptRunner =
    input.run ??
    (async ({ cwd, approach, briefing, signal }) => {
      const result = await runSubAgent({
        prompt: input.problem,
        briefing: `${input.briefing}\n\n${briefing}`,
        role: 'builder',
        name: `repair/${approach.id}`,
        runId: input.runId,
        governor: input.governor,
        tools,
        cwd,
        signal,
        delegationDepth: MAX_DELEGATION_DEPTH,
      })
      usage = addUsage(usage, result.usage)
      return { text: result.report, cost: totalTokens(result.usage) }
    })

  const search = isolatedSearch({
    // Its own namespace: `--variants` names its worktrees and branches after the run id too.
    runId: `${input.runId}-repair`,
    sourceRoot: input.workspaceRoot,
    async run(args) {
      const signal = input.signal ? AbortSignal.any([input.signal, siblings.signal]) : siblings.signal
      const outcome = await attempt({ ...args, signal })
      attemptsRun += 1
      tokensSpent += outcome.cost ?? 0
      if (!signal.aborted) {
        const verdict = await checkTree(args.cwd)
        verdicts.set(args.cwd, verdict)
        if (verdict.passed) siblings.abort()
      }
      return outcome
    },
  })

  try {
    const result = await withAgentIdentity({ name: 'lead', role: 'lead', runId: input.runId, cwd: input.workspaceRoot, signal: input.signal }, () =>
      withActionGovernor(input.governor, () =>
        withoutGoalGraph(() =>
          solve({
            approaches: harness.approaches,
            produce: search.produce,
            verifier,
            budget: { attempts: Math.min(harness.maxAttempts, choice.maxAttempts ?? harness.maxAttempts) },
            width: harness.width,
            signal: input.signal,
          }),
        ),
      ),
    )

    // An aborted search is the operator changing their mind, not evidence about
    // the harness.
    if (result.stopped !== 'aborted') {
      recordOutcome(
        {
          signature: signature.key,
          harnessId: harness.id,
          verified: result.verified,
          attemptsUsed: attemptsRun,
          cost: tokensSpent,
          elapsedMs: result.elapsedMs,
          at: Date.now(),
          ...successOf(result),
          ...(context ? { context: context.flags } : {}),
        },
        file,
      )
      if (choice.prediction) recordMeta(choice.prediction, result.verified, choice.differed ?? false, metaPath(dirname(file)))
    }
    if (!result.verified || !result.best) {
      say(`repair search: none of ${attemptsRun} attempt(s) passed the checks — continuing with the linear repair`)
      return undefined
    }

    const changed = await search.changedBy(result.best)
    const refused = changed.filter((path) => isSensitivePath(path) || input.protectedPaths.includes(path))
    if (refused.length > 0) {
      say(`repair search: the passing attempt changed ${refused.slice(0, 3).join(', ')}, which this run may not change — nothing was merged`)
      return undefined
    }

    const merged = await search.settle(result.best)
    return {
      merged,
      report: result.best.text,
      usage,
      harnessId: harness.id,
      attempts: attemptsRun,
      tokens: tokensSpent,
      detail: result.bestVerdict?.detail ?? '',
    }
  } finally {
    // A search that threw, was refused, or found nothing must leave no worktree
    // behind holding the branch namespace. Safe after a settle that merged.
    await search.settle(undefined).catch(() => {})
  }
}
