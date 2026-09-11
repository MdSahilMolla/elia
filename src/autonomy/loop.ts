import { join } from 'node:path'
import { config, paths, systemPromptForMode, tierConfig, turnContextPrompt } from '../config.ts'
import { withFileLockAsync } from '../fileLock.ts'
import { lastAssistantText, runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { taskTool } from '../tools/task.ts'
import { allWorkerTools } from '../tools/registry.ts'
import { environmentTool } from '../tools/environment.ts'
import { runSubAgent } from '../subagent.ts'
import { runShell, clampOutput } from '../shell.ts'
import { ZERO_USAGE, addUsage, formatElapsed, recordUsage } from '../usage.ts'
import type { Usage } from '../providers/types.ts'
import { writeText } from '../ui/stream.ts'
import { reportSinkActive, writeBlock, writeFail, writePass, writePhase, writeSubStep, writeSummary } from '../ui/report.ts'

// When a report sink is installed (the Ink REPL escalated into this pipeline),
// the raw planner/repair token stream would have to be shredded into hundreds of
// transcript items — the phase reports and the rendered proposal carry the
// signal there instead. `elia auto` (no sink) still streams to stdout.
const streamOnText = (): ((delta: string) => void) | undefined => (reportSinkActive() ? undefined : writeText)
import { createToolResultCache } from '../speculation/cache.ts'
import { createPrefetcher } from '../speculation/prefetch.ts'
import { createBlackboard, setActiveBlackboard } from './blackboard.ts'
import { createTodoList, setActiveTodoList } from './todoList.ts'
import { withAgentIdentity } from './context.ts'
import { activeMode, withActiveMode, type AgentMode } from './mode.ts'
import { loadDevelopmentToolHooks, withToolHooks } from './devHooks.ts'
import { createJournal, newRunId, runDir, type Journal } from './journal.ts'
import { captureTreeSnapshot, discardTreeSnapshot, dirtyPaths, restoreTreeSnapshot, type TreeSnapshot } from './treeSnapshot.ts'
import { planWaves, runFleet } from './fleet.ts'
import { runVariants } from './variants.ts'
import { createProposalTool, renderProposal, renderProposalSummary } from './proposal.ts'
import { savePlanArtifact } from './artifacts.ts'
import { commitAll, scaffoldProject } from './scaffold.ts'
import { publishProject } from './publish.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { redactText } from '../ui/redact.ts'
import { appendLessons, consumeInjectedLessonKeys, createLessonsTool, renderLessons } from './lessons.ts'
import { recordLessonExposure } from './lessonEfficacy.ts'
import {
  createVerdictTool,
  describeIssues,
  describeVerification,
  hasBlockingIssues,
  mergeVerdicts,
  requireCriticVerdict,
  runVerification,
} from './verify.ts'
import { assessProgress, failureFingerprints, repeatedFailureLesson, type AttemptSnapshot } from './progress.ts'
import { filesFromGitStatus, hygieneVerdict, scanProjectFiles, type HygieneInput } from './hygiene.ts'
import { acceptanceVerdict, createAcceptanceTool } from './acceptance.ts'
import { applyPlanRevisions, createPlanRevisionTool, MAX_PLAN_REVISIONS } from './replan.ts'
import { assumptionOutcome, auditPlanFeasibility, createAssumptionTool } from './assumptions.ts'
import { isSensitivePath } from './sensitivePaths.ts'
import { classifyStuck, type StuckRecovery } from './stuck.ts'
import { checkRoot, classifyRegime, detectChecks, type VerificationRegime } from './detectChecks.ts'
import { detectContradictions, recordCompletion } from './calibration.ts'
import { deriveReward, recordTrajectory, refSystemPrompt } from '../trajectory/record.ts'
import { ELIA_ROOT } from '../statePaths.ts'
import { reliabilitySignal } from './reliability.ts'
import type { CriticVerdict, Proposal } from './types.ts'
import { appendActionAudit, readActionLedger, writeRunReceipt } from './audit.ts'
import { buildReviewDiffSection } from './reviewContext.ts'
import { blockedInUnattendedMode, createActionGovernor, withActionGovernor, type ActionApproval, type ActionGovernor, type ActionGovernorStats, type GovernanceMode } from './governor.ts'
import { GoalGraphStore, withGoalGraph, type GoalGraphStore as GoalGraphStoreType } from './goalGraph.ts'
import { assessCompletion, type CompletionAssessment } from './outcome.ts'
import { inferTaskKind, taskSessions } from '../taskSessions.ts'
import { clearRunControl, readRunControl, type SupervisorControlRequest } from './control.ts'

export type ApprovalDecision =
  | { action: 'approve' }
  | { action: 'reject' }
  | { action: 'amend'; feedback: string }

export type Approver = (proposal: Proposal) => Promise<ApprovalDecision>

export const autoApprove: Approver = async () => ({ action: 'approve' })

export interface AutonomousRunOptions {
  goal: string
  approve: Approver
  /** Operating mode inherited by planning, workers, repair, and reports. */
  mode?: AgentMode
  /** How many repair cycles to attempt when verification or review fails (default 2). */
  maxRepairAttempts?: number
  /** How many times the user may send the plan back for changes (default 3). */
  maxAmendments?: number
  /**
   * Run this many independent implementation attempts of the approved plan in
   * parallel, each in its own isolated git worktree, and let verification —
   * not another LLM's opinion — pick the winner (default 1: today's single-
   * attempt behavior, unchanged). See variants.ts.
   */
  variants?: number
  /** Resume from a checkpoint's message history instead of orienting from scratch. */
  resumeMessages?: ConversationMessage[]
  /** Continue an existing durable goal graph from its persisted node states. */
  resumeGraph?: boolean
  /** Run a bounded final quality pass before verification; enabled by default. */
  polish?: boolean
  /** Maximum final polish passes; bounded to prevent autonomous thrashing. */
  maxPolishPasses?: number
  /** Maximum governed tool requests for the entire run; 0 means no additional action-count limit. */
  maxActions?: number
  runId?: string
  signal?: AbortSignal
  /** Optional approval callback for critical side effects during this run. */
  approveAction?: ActionApproval
  /** Defaults to unattended: safe work flows, irreversible work pauses or blocks. */
  governanceMode?: GovernanceMode
  /** Fast skips optional quality loops; thorough adds bounded review and repair depth. */
  profile?: AutonomyProfile
  /** Capture cross-run lessons after completion; defaults from the selected profile. */
  learn?: boolean
  /** Optional hard wall-clock budget for the entire run; 0 means no additional deadline. */
  maxWallClockMs?: number
  /**
   * Repo-relative paths the run must never stage or commit — the operator's
   * unrelated uncommitted work. The loop also auto-detects this from the working
   * tree at start; this is for callers that want to be explicit (e.g. a REPL
   * turn escalating into the pipeline mid-edit).
   */
  protectedPaths?: readonly string[]
}

export type AutonomyProfile = 'fast' | 'balanced' | 'thorough'

export function autonomyProfileDefaults(profile: AutonomyProfile): {
  maxRepairAttempts: number
  maxAmendments: number
  polish: boolean
  maxPolishPasses: number
  reviewerCount: number
  learn: boolean
  plannerSteps: number
  maxActions: number
} {
  if (profile === 'fast') {
    return { maxRepairAttempts: 1, maxAmendments: 1, polish: false, maxPolishPasses: 0, reviewerCount: 1, learn: false, plannerSteps: 24, maxActions: 120 }
  }
  if (profile === 'thorough') {
    return { maxRepairAttempts: 3, maxAmendments: 4, polish: true, maxPolishPasses: 2, reviewerCount: 3, learn: true, plannerSteps: 50, maxActions: 600 }
  }
  return { maxRepairAttempts: 2, maxAmendments: 3, polish: true, maxPolishPasses: 1, reviewerCount: 3, learn: true, plannerSteps: 40, maxActions: 300 }
}

export type RunOutcome = 'completed' | 'needs-attention' | 'rejected' | 'no-proposal' | 'aborted'

export interface AutonomousRunResult {
  runId: string
  outcome: RunOutcome
  proposal?: Proposal
  verdict?: CriticVerdict
  usage: Usage
  elapsedMs: number
  lessons: string[]
  completion: CompletionAssessment
  taskSessionId?: string
  actionBudget: ActionGovernorStats
}

const plannerPromptForMode = (mode: AgentMode) => `${systemPromptForMode(mode)}

${turnContextPrompt()}

## Right now you are planning, not building

You are in the orient-and-propose phase of an autonomous run. You must NOT change anything yet — you have no write tools in this phase, by design.

Work like an engineer picking up an unfamiliar ticket:
1. Look at the shape of the project and call environment before forming any opinion; verify runtimes, credentials presence, browser transport presence, git state, and the detected project shape. If \`environmentReadiness\` reports blockers (a lockfile with no installed dependencies, a missing toolchain, a compose service the app needs), make the first step of the plan a call to \`provision_environment\` — a run that discovers a broken environment mid-build wastes its whole budget on failures that have nothing to do with the change.
2. Send several scouts out in parallel (call \`task\` with role "scout" multiple times in one turn) to answer the specific questions you need answered. Scouts are fast and cheap; serial investigation is the single biggest waste of wall-clock time available to you, so batch it.
3. Read the handful of files that actually decide the design yourself.
4. Then call \`submit_proposal\` exactly once and stop.

Do not write the plan out in prose first. The proposal is rendered for the user from the tool call itself, so narrating it beforehand just shows them the same plan twice. Investigate, then submit.

What makes a good proposal:
- \`understanding\` names real files, real symbols, real patterns you verified. Not "the codebase appears to use X" — say which file proves it.
- Steps are decomposed for parallelism. Two steps touching disjoint files with no ordering requirement must NOT depend on each other; each unnecessary dependency costs the user wall-clock time.
- Pick the specific role for each step, not just "builder": use \`frontend\` for UI/component/styling/client-side work and \`backend\` for API/business-logic/data work — a change that touches both should be two independent steps (one per role) so they execute in parallel instead of one generalist doing both serially.
- Every step's instructions stand alone. The worker executing it sees your instructions and nothing else — not this conversation, not the other steps.
- \`verification\` is real commands from this project that will actually fail if the work is wrong. Look them up in package.json or the docs; do not invent them. Each command must be a single, plain, foreground invocation — no \`&\`, \`&&\`, \`|\`, \`;\`, redirects, or command substitution. Elia's action governor requires exact approval for any shell composition, which is never available in an unattended run — a verification command that needs it can never pass and will strand the run needing a human for something the code may already do correctly. If you want the behavior a manual "start the server, then curl it" check would show, write that scenario into the test suite itself (e.g. spawn the server in a setup hook, fetch from the test, assert, stop it in teardown) and verify with the plain test command instead.
- Assumptions are where you guessed. The user correcting a wrong assumption now costs seconds; discovering it after the work costs the whole run.
- Identify the capability domains involved (business, finance, data, research, cybersecurity, automation, communications, AI/ML, marketing, or software) and assign the right specialist role to each step.
- Define an acceptance contract for the final result: artifact or action delivered, evidence required, domain-specific quality checks, unresolved uncertainty, and what the user must approve.
- List every external side effect separately. Drafting is not sending; analysis is not execution; authorized security assessment is not permission to attack. Any consequential action must have an exact approval boundary and a postcondition check.
- Define recovery: which steps are idempotent, which completed actions must never be repeated, what can be retried, and what user input is needed if credentials, scope, or approval is missing.`

/** An assumption is checked by looking: read the tree, run a read-only probe. */
const ASSUMPTION_TOOL_NAMES = new Set(['read_file', 'list_files', 'grep', 'run_command', 'environment', 'web_search'])

const REVIEWER_TOOL_NAMES = new Set(['read_file', 'list_files', 'grep', 'board_read', 'recall', 'environment'])

const repairPromptForMode = (mode: AgentMode) => `${systemPromptForMode(mode)}

${turnContextPrompt()}

## Right now you are fixing your own work

Verification or review has come back negative on work that was just done. You have the full tool set.

Diagnose before you edit. Read the actual error and the actual code; do not guess at a fix from the error message alone. Fix the cause, not the symptom, and do not "fix" things by weakening the check that caught the problem — deleting a failing assertion, loosening a type to \`any\`, or skipping a test is a failure, not a repair.
Fix everything listed. When you are done, re-run the verification commands yourself and report their real output.`

/**
 * Runs one goal end to end, the way a person works a ticket: get your bearings,
 * say what you intend to do, do it (delegating what can run in parallel), check
 * your own work, fix what you broke, and write down what you learned.
 *
 * The phases are separate on purpose. Each one has a different tool set and a
 * different prompt, so the model is never simultaneously trying to explore and
 * commit; and each boundary writes a checkpoint, so any of them can be re-entered
 * later with a different decision.
 */
/**
 * Autonomous runs are exclusive, and the guard lives here rather than in the UI.
 *
 * One prompt once started three runs in sixty seconds: the first got as far as
 * its first step and was killed, and the next two aborted at "propose" with "the
 * execution plan does not have an approved durable approval record"
 * (2026-09-10 runs 67gt-raec, 719a-wty5, 7fsb-rta8). Overlapping runs share
 * `.elia/runs/`, the goal graph, and the journal, so the second one corrupts the
 * first's durable state rather than merely wasting tokens.
 *
 * The REPL's own re-entrancy guard is the fast path, but it only covers one
 * process and one front-end. This covers a second `elia auto`, a second
 * terminal, and any future caller.
 */
let runningInThisProcess = false

/** A long-running plan must not have its lock stolen; a crashed one must not hold it. */
const RUN_LOCK_TTL_MS = 6 * 60 * 60 * 1000

export function runAutonomousTask(options: AutonomousRunOptions): Promise<AutonomousRunResult> {
  const mode = options.mode ?? activeMode()
  const hooks = mode === 'dev' ? loadDevelopmentToolHooks() : []
  return withActiveMode(mode, () => withToolHooks(hooks, () => withRunLock(() => runAutonomousTaskInternal(options))))
}

async function withRunLock<T>(fn: () => Promise<T>): Promise<T> {
  if (runningInThisProcess) {
    throw new Error('An autonomous run is already in progress in this session. Wait for it to finish, or stop it first.')
  }
  runningInThisProcess = true
  try {
    return await withFileLockAsync(join(paths.runs, '.run.lock'), fn, {
      ttlMs: RUN_LOCK_TTL_MS,
      // Refuse immediately rather than queueing behind a run that may take an
      // hour — the operator needs to know now, not after a silent wait.
      timeoutMs: 0,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/is busy; another elia process is holding it/.test(message)) {
      throw new Error('Another elia autonomous run is already using this project. Wait for it to finish, or stop it first.')
    }
    throw error
  } finally {
    runningInThisProcess = false
  }
}

async function runAutonomousTaskInternal(options: AutonomousRunOptions): Promise<AutonomousRunResult> {
  const { goal, approve, signal } = options
  const profile = options.profile ?? 'balanced'
  const configuredWallClockMs = options.maxWallClockMs ?? (Number.parseInt(process.env.ELIA_MAX_RUN_MS ?? '0', 10) || 0)
  const maxWallClockMs = Math.max(0, Math.min(configuredWallClockMs, 24 * 60 * 60_000))
  const runController = new AbortController()
  const runSignal = runController.signal
  let deadlineTriggered = false
  const forwardAbort = () => runController.abort()
  if (signal) {
    if (signal.aborted) forwardAbort()
    else signal.addEventListener('abort', forwardAbort, { once: true })
  }
  const budgetTimer = maxWallClockMs > 0 ? setTimeout(() => {
    deadlineTriggered = true
    runController.abort()
  }, maxWallClockMs) : undefined
  const defaults = autonomyProfileDefaults(profile)
  // Past runs in this project that claimed more than they delivered → extra
  // adversarial review this run (reliability.ts, fed by the calibration ledger).
  const reliability = reliabilitySignal(process.cwd())
  const maxRepairAttempts = options.maxRepairAttempts ?? defaults.maxRepairAttempts
  const maxAmendments = options.maxAmendments ?? defaults.maxAmendments
  const runPolish = options.polish ?? defaults.polish
  const maxPolishPasses = Math.max(0, Math.min(options.maxPolishPasses ?? defaults.maxPolishPasses, 3))
  const captureLearning = options.learn ?? defaults.learn
  const runId = options.runId ?? newRunId()
  clearRunControl(runId)
  const startedAt = Date.now()
  // Whatever was already uncommitted in this repo before the run — the scaffold
  // and per-wave commits must never sweep the operator's unrelated work into
  // elia's history. Captured once, here, before anything is written.
  const protectedPaths = [...new Set([
    ...(options.protectedPaths ?? []),
    ...(await dirtyPaths(process.cwd()).catch(() => [])),
  ])]
  const parentTask = taskSessions.create(inferTaskKind(goal, goal), `Autonomous: ${goal}`, 'Queued autonomous execution', { role: 'lead' })
  taskSessions.update(parentTask.id, { status: 'running', action: 'Orienting', detail: 'Inspecting the environment and preparing a durable plan' })
  const unregisterParentControls = taskSessions.registerControls(parentTask.id, {
    cancel: () => {
      taskSessions.update(parentTask.id, { status: 'paused', action: 'Stopping', detail: 'Cancellation requested by operator', nextAction: 'Resume the durable run after reviewing its receipt.' })
      runController.abort()
    },
    pause: () => {
      taskSessions.update(parentTask.id, { status: 'paused', action: 'Pausing', detail: 'Pause requested by operator', nextAction: 'Resume the durable run after reviewing its receipt.' })
      runController.abort()
    },
  })
  const maxActions = options.maxActions ?? defaults.maxActions
  const governor = createActionGovernor({ mode: options.governanceMode ?? 'unattended', approve: options.approveAction, maxActions })

  let supervisorTimer: ReturnType<typeof setInterval> | undefined
  let supervisorRequest: SupervisorControlRequest | undefined
  const journal = createJournal(runId, goal)
  supervisorTimer = setInterval(() => {
    const request = readRunControl(runId)
    if (!request || supervisorRequest) return
    supervisorRequest = request
    journal.append('phase', { phase: 'supervisor-control', action: request.action, requestedAt: request.requestedAt })
    taskSessions.update(parentTask.id, {
      status: 'paused',
      action: request.action === 'stop' ? 'Stopping' : 'Pausing',
      detail: `Supervisor requested ${request.action}; active work is being stopped safely.`,
      nextAction: 'Inspect the run receipt and resume only after reviewing the stopped work.',
    })
    runController.abort()
  }, 250)
  const graph = GoalGraphStore.open({ runId, goal, dir: journal.dir })
  const board = createBlackboard(`${journal.dir}/board.json`)
  // Per run, like the blackboard: a resumed run should not inherit a stale plan.
  setActiveTodoList(createTodoList(`${journal.dir}/todo.json`))
  setActiveBlackboard(board)

  let usage = ZERO_USAGE
  let planApproved = false
  let verificationPassed = false
  let reviewPassed = false
  // How much this run's verification is worth (mechanical > empirical > judgment).
  // Defaults to the safe floor so an early abort never claims more; the verify
  // phase sets the real value once the changed files are known.
  let verificationRegime: VerificationRegime = 'judgment'
  // The last verified-good tree state, for a wrong-approach rewind. Assigned once
  // the verify phase begins; declared here so `done()` can always clean it up.
  let greenSnapshot: TreeSnapshot | undefined
  let rewoundOnce = false
  const track = (delta: Usage) => {
    usage = addUsage(usage, delta)
  }

  /**
   * Ends the run as aborted, recording *where* it stopped and *why*.
   *
   * A bare `done('aborted')` produced a receipt that said only "0 of 1 planned
   * work node(s) completed" — true, but it never named the cause, so every
   * aborted run in completion-calibration.ndjson carries `confidence: "low"`
   * and an empty `contradictions` array. Run 2026-09-10-6sl5-x7m6 journalled
   * `phase: execute` and `run-end: aborted` 23ms apart with nothing in between
   * to explain it.
   */
  const abortedAt = (phase: string, extra: Partial<AutonomousRunResult> = {}): AutonomousRunResult => {
    journal.append('phase', {
      phase: 'aborted',
      during: phase,
      reason: deadlineTriggered
        ? `wall-clock budget of ${maxWallClockMs}ms exhausted`
        : signal?.aborted
          ? 'stopped by the operator'
          : 'the run signal was aborted by its caller',
    })
    return done('aborted', extra)
  }

  const done = (
    outcome: RunOutcome,
    extra: Partial<AutonomousRunResult> = {},
  ): AutonomousRunResult => {
    if (budgetTimer) clearTimeout(budgetTimer)
    if (supervisorTimer) clearInterval(supervisorTimer)
    if (outcome === 'aborted' && deadlineTriggered && !signal?.aborted) {
      journal.append('phase', { phase: 'budget', maxWallClockMs })
    }

    const actionBudget = governor.stats()
    if (actionBudget.blockedByBudget > 0) {
      journal.append('phase', { phase: 'action-budget-exhausted', maxActions: actionBudget.maxActions, consumed: actionBudget.consumed, blockedRequests: actionBudget.blockedByBudget })
    }

    let finalOutcome = outcome
    if (actionBudget.blockedByBudget > 0 && !['rejected', 'aborted'].includes(finalOutcome)) finalOutcome = 'needs-attention'
    if (outcome === 'completed') {
      try {
        graph.completeGoal()
      } catch (error) {
        finalOutcome = 'needs-attention'
        journal.append('phase', { phase: 'completion-blocked', reason: error instanceof Error ? error.message : String(error) })
      }
    }
    if (finalOutcome === 'needs-attention' || finalOutcome === 'aborted') graph.failRun(finalOutcome)

    const completion = assessCompletion({ outcome: finalOutcome, graph: graph.state(), verificationPassed, reviewPassed, planApproved, actionBudget })
    unregisterParentControls()
    signal?.removeEventListener('abort', forwardAbort)
    const taskStatus = completion.state === 'verified'
      ? 'done'
      : finalOutcome === 'aborted'
        ? 'paused'
        : completion.pendingApprovals > 0
          ? 'waiting-approval'
          : completion.state === 'blocked' || finalOutcome === 'needs-attention'
            ? 'needs-review'
            : 'failed'
    taskSessions.update(parentTask.id, {
      status: taskStatus,
      action: completion.state === 'verified' ? 'Verified' : finalOutcome === 'aborted' ? supervisorRequest?.action === 'stop' ? 'Stopped' : 'Paused' : 'Needs attention',
      detail: supervisorRequest ? `${completion.summary} Supervisor request: ${supervisorRequest.action}.` : completion.summary,
      progress: completion.totalSteps > 0 ? completion.completedSteps / completion.totalSteps : completion.state === 'verified' ? 1 : 0,
      stepsCompleted: completion.completedSteps,
      stepsTotal: completion.totalSteps || undefined,
      nextAction: completion.nextActions[0],
      blockedReason: completion.blockers[0],
      error: completion.state === 'verified' ? undefined : completion.blockers.join('; ') || undefined,
    })
    journal.append('run-end', { outcome: finalOutcome, completion, taskSessionId: parentTask.id, graph: graph.state().nodes.map((node) => ({ id: node.id, status: node.status })) })
    writeRunReceipt({ runId, goal, outcome: finalOutcome, taskSessionId: parentTask.id, proposal: extra.proposal, verdict: extra.verdict, lessons: extra.lessons, completion, events: journal.events(), graph: graph.state(), usage, elapsedMs: Date.now() - startedAt, maxWallClockMs: maxWallClockMs || undefined, actionBudget })
    const completionFacts = {
      verificationPassed,
      reviewPassed,
      completedSteps: completion.completedSteps,
      totalSteps: completion.totalSteps,
      unresolvedActions: graph.state().actions.filter((action) => action.state !== 'completed').length,
      pendingApprovals: completion.pendingApprovals,
      blockedByBudget: actionBudget.blockedByBudget,
      regime: verificationRegime,
    }
    recordCompletion(runId, completion, completionFacts)
    const contradictions = detectContradictions(completion.state, completion.confidence, completionFacts)
    recordLessonExposure(runId, consumeInjectedLessonKeys(), {
      verify: verificationPassed ? 'pass' : 'fail',
      regime: verificationRegime,
      clean: verificationPassed && contradictions.length === 0,
    })
    if (contradictions.length > 0) {
      journal.append('phase', { phase: 'learn', note: `completion contradiction: ${contradictions.join('; ')}` })
      writeSubStep(`⚠ completion verdict "${completion.state}/${completion.confidence}" doesn't match the facts: ${contradictions.join('; ')}`)
    }
    try {
      // One trajectory row per run: the per-wave commits already hold the diff,
      // so this row carries the goal, the tool sequence, and the graded outcome
      // — the training signal a git checkout alone doesn't.
      const ledger = readActionLedger(runId)
      recordTrajectory({
        corr: runId,
        kind: 'autonomous',
        prompt: goal,
        systemPromptRef: refSystemPrompt(activeMode()),
        tools: ledger.map((record) => ({ name: record.tool, ok: !record.isError })),
        touched: [],
        verify: verificationPassed ? 'pass' : 'fail',
        regime: verificationRegime,
        contradictions,
        cwdIsEliaRoot: process.cwd() === ELIA_ROOT,
        reward: deriveReward({
          toolErrors: ledger.filter((record) => record.isError).length,
          editRetries: 0,
          verify: verificationPassed ? 'pass' : 'fail',
          repairAttempts: 0,
          aborted: finalOutcome === 'aborted',
          completionState: completion.state,
          regime: verificationRegime,
          contradictions: contradictions.length,
        }),
      })
    } catch {
      // best-effort; recordTrajectory guards itself too
    }
    if (greenSnapshot) void discardTreeSnapshot(greenSnapshot)
    emitEvent('run_finished', { runId, goal: redactText(goal, 2000), outcome: finalOutcome, taskSessionId: parentTask.id, completion, elapsedMs: Date.now() - startedAt, usage, graph: graph.state() })
    return {
      runId,
      outcome: finalOutcome,
      usage,
      elapsedMs: Date.now() - startedAt,
      lessons: [],
      completion,
      taskSessionId: parentTask.id,
      actionBudget,
      ...extra,
    }
  }

  // --- Orient & propose -----------------------------------------------------

  writePhase('orient', `run ${runId}`)
  const snapshot = options.resumeGraph ? '(resuming from the durable goal graph; inspect only files needed for unfinished nodes)' : await projectSnapshot(runId, runSignal)

  const proposalCapture = createProposalTool()
  const basePlannerPrompt = plannerPromptForMode(activeMode())
  const plannerPrompt = profile === 'fast'
    ? `${basePlannerPrompt}\n\n## Fast bounded mode\nThis is a time-sensitive task. Prefer 3–6 high-value steps, combine edits that share a coherent UI or subsystem, and keep independent steps in the same wave. Do not create separate steps for trivial assets, documentation, or cosmetic micro-edits. The goal is a complete verified result, not an exhaustive project plan.`
    : basePlannerPrompt
  const planningTools = [
    ...allWorkerTools().filter((tool) => ['read_file', 'list_files', 'grep', 'web_search', 'web_fetch', 'browser', 'board_read', 'board_post', 'environment'].includes(tool.name)),
    taskTool,
    proposalCapture.tool,
  ]

  const messages: ConversationMessage[] = options.resumeMessages ?? [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `## Goal\n${goal}\n\n## Project snapshot\n${snapshot}${renderLessons()}\n\nOrient yourself, then submit a proposal.`,
        },
      ],
    },
  ]

  journal.checkpoint('before-orient', messages)

  let proposal: Proposal | undefined = options.resumeGraph ? graph.state().proposal : undefined
  let amendments = 0

  if (proposal) {
    writeSubStep(`resuming durable goal graph ${runId} from persisted node state`)
  } else while (true) {
    if (runSignal?.aborted) return abortedAt('orient')

    journal.append('phase', { phase: 'propose', attempt: amendments })
    // Orienting is almost entirely read_file/grep/list_files, and those reads
    // chain as predictably here as anywhere else (grep a symbol, open the hits;
    // open a module, open its imports). Give the planner the same speculative
    // cache and heuristic prefetch every sub-agent already gets, so the reads
    // run while the model is still generating instead of after it.
    const planningCache = createToolResultCache()
    const planning = await withAgentIdentity({ name: 'lead', role: 'lead', runId, cwd: process.cwd(), signal: runSignal }, () => withActionGovernor(governor, () => withGoalGraph(graph, () => runAgentLoop({
      messages,
      systemPrompt: plannerPrompt,
      tools: planningTools,
      onText: streamOnText(),
      useAnimation: true,
      verbose: true,
      maxSteps: defaults.plannerSteps,
      cache: planningCache,
      prefetcher: createPrefetcher({ tools: planningTools, cache: planningCache }),
      signal: runSignal,
      onTool: (event) => appendActionAudit(event, runId),
    }))))
    track(planning.usage)
    recordUsage(planning.usage)

    proposal = proposalCapture.taken()
    if (!proposal) {
      // The model talked instead of proposing. One explicit nudge, then give up
      // rather than looping on the same failure.
      if (amendments >= 1) return done('no-proposal')
      amendments += 1
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You did not call submit_proposal. Do it now, with the plan you just described. Do not begin the work.',
          },
        ],
      })
      continue
    }

    journal.append('proposal', { proposal })
    // The full proposal is durable output: write it as an artifact the moment
    // it is valid — before the approval gate — so a rejected or amended plan
    // still leaves a record. It is re-written with the outcome once decided.
    const planArtifactPath = runId ? `.elia/runs/${runId}/plan.md` : '.elia/artifacts/plan.md'
    try {
      savePlanArtifact(proposal, runId, process.cwd(), 'draft')
    } catch {
      // Non-fatal — the plan still streams to the terminal and the journal.
    }
    if (machineReadable) emitEvent('proposal_ready', { proposal })
    else if (reportSinkActive()) writeBlock('Plan · awaiting approval', renderProposalSummary(proposal, planArtifactPath).join('\n'))
    else process.stdout.write(renderProposal(proposal))
    journal.checkpoint('after-propose', messages)

    graph.seedProposal(proposal)
    const durableApproval = graph.requestApproval('plan', 'proposal', { goal: proposal.goal }, 'The approved proposal authorizes the run to execute its planned steps.')
    const decision = durableApproval.status === 'approved' ? ({ action: 'approve' } as const) : await approve(proposal)
    if (durableApproval.status === 'pending') graph.resolveApproval(durableApproval.id, decision.action === 'approve', decision.action === 'amend' ? decision.feedback : decision.action)
    planApproved = decision.action === 'approve'
    journal.append('approval', { action: decision.action, approvalId: durableApproval.id })
    emitEvent('approval_decision', { runId, approvalId: durableApproval.id, kind: 'plan', decision: decision.action })

    if (decision.action === 'approve') break
    if (decision.action === 'reject') {
      try { savePlanArtifact(proposal, runId, process.cwd(), 'rejected') } catch { /* non-fatal */ }
      writeSubStep(`Plan rejected — nothing was changed. Full proposal kept at ${planArtifactPath}`)
      return done('rejected', { proposal })
    }

    if (amendments >= maxAmendments) {
      try { savePlanArtifact(proposal, runId, process.cwd(), 'amended') } catch { /* non-fatal */ }
      writeSubStep(`Reached the ${maxAmendments}-revision limit — stopping without making changes.`)
      return done('rejected', { proposal })
    }
    amendments += 1
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `The plan needs changes before I approve it:\n\n${decision.feedback}\n\nRevise and call submit_proposal again.`,
        },
      ],
    })
  }

  if (proposal && options.resumeGraph) {
    const durableApproval = graph.state().approvals.find((approval) => approval.kind === 'plan')
    planApproved = durableApproval?.status === 'approved'
    if (durableApproval?.status !== 'approved') {
      const decision = await approve(proposal)
      if (durableApproval) graph.resolveApproval(durableApproval.id, decision.action === 'approve', decision.action === 'amend' ? decision.feedback : decision.action)
      if (decision.action !== 'approve') return done(decision.action === 'reject' ? 'rejected' : 'needs-attention', { proposal })
      planApproved = true
    }
  }

  // A verification command the unattended governor will always refuse — a
  // backgrounded server, a shell chain, anything that needs an exact approval
  // boundary — makes the run's gate unwinnable: it cannot go green, so every
  // repair attempt is spent on a command that was never going to run. Seen
  // live on a plan whose only check was
  // `bun run src/server.ts & sleep 2 && curl ...`, which returned exit 126 on
  // every attempt. Drop those and fall back to the project's own inferred
  // checks, which are the same ones the interactive loop uses.
  // Only in unattended mode: a supervised run puts the same command in front of
  // the user for an approval decision instead of refusing it outright.
  // Some plans are impossible before anything runs, and elia can tell from its
  // own policy. A step scheduled to write a credential path will be refused
  // every time it is attempted; a plan that assumes it *can* be written is
  // resting on something already known to be false. One run declared exactly
  // that assumption, planned around it, and then spent its budget discovering
  // the wall it had described in advance.
  if (planApproved) {
    const infeasible = auditPlanFeasibility(proposal, process.cwd())
    for (const issue of infeasible) writeSubStep(`⚠ plan cannot work as written — ${issue.detail}`)
    if (infeasible.length > 0) {
      journal.append('phase', { phase: 'propose', note: 'plan feasibility', issues: infeasible })
      // Strip the impossible targets rather than letting each step fail on them.
      // The work itself still stands; only the unreachable file does not.
      proposal = {
        ...proposal,
        steps: proposal.steps.map((step) => ({ ...step, files: step.files.filter((file) => !isSensitivePath(file)) })),
      }
    }
  }

  if (planApproved && proposal.verification.length > 0 && (options.governanceMode ?? 'unattended') === 'unattended') {
    const refused = proposal.verification.filter((command) => blockedInUnattendedMode(command))
    if (refused.length > 0) {
      const usable = proposal.verification.filter((command) => !refused.includes(command))
      const replacement = usable.length > 0 ? usable : detectChecks(process.cwd())
      proposal = { ...proposal, verification: replacement }
      writeSubStep(
        `${refused.length} planned verification command(s) can never run unattended (${refused.map((command) => command.slice(0, 60)).join('; ')}) — ` +
          (replacement.length > 0 ? `verifying with ${replacement.join(' · ')} instead` : 'no runnable check remains, so review alone decides this run'),
      )
      journal.append('phase', { phase: 'propose', note: `verification rewritten: refused ${JSON.stringify(refused)}, using ${JSON.stringify(replacement)}` })
    }
  }

  if (planApproved && proposal) {
    try {
      // Re-write the draft artifact with the final (possibly verification-
      // rewritten) proposal, now marked approved.
      savePlanArtifact(proposal, runId, process.cwd(), 'approved')
    } catch {
      // The plan already streamed to the terminal and the journal; a failure to
      // also mirror it to .elia/artifacts must not block an approved run.
    }
  }

  // --- Scaffold -------------------------------------------------------------

  // An approved plan needs somewhere to live before the first worker touches
  // anything: a repository (so there is a rollback point and a reviewable
  // history at all), ignore rules (so the first commit is not node_modules and
  // an .env full of live keys), and the project's own documents. Runs used to
  // produce a folder of files with no history and no way back — the tree-rewind
  // recovery silently did nothing in a non-git directory, because it needs git.
  //
  // Publishing itself does NOT happen here. It used to — right after this
  // block, before a single wave had run — so the pushed repository only ever
  // held `.gitignore` and the generated docs: every real implementation commit
  // (one per wave, via `commitAll` in Execute below) landed locally afterwards
  // and was never pushed, while the run still reported "created and pushed"
  // and could finish `verified`. The repository and its initial commit are
  // still created here (a rollback point has to exist before workers start),
  // but the actual `publishProject` push now runs after Execute, once the
  // wave commits that carry the delivered work actually exist — see below.
  let hasLocalHistory = false
  if (planApproved) {
    writePhase('scaffold', 'repository, ignore rules, and project documents')
    const scaffold = await scaffoldProject({ cwd: process.cwd(), goal, proposal, signal: runSignal, protect: protectedPaths })
    if (scaffold.initialized) writeSubStep('initialised a git repository for this project')
    if (scaffold.documents.length > 0) writeSubStep(`wrote ${scaffold.documents.join(', ')}`)
    for (const commit of scaffold.commits) writeSubStep(`committed: ${commit}`)
    for (const warning of scaffold.warnings) writeSubStep(`⚠ ${warning}`)
    journal.append('phase', { phase: 'scaffold', initialized: scaffold.initialized, documents: scaffold.documents, commits: scaffold.commits.length, warnings: scaffold.warnings })
    hasLocalHistory = scaffold.commits.length > 0
  }

  // --- Execute --------------------------------------------------------------

  taskSessions.update(parentTask.id, {
    status: 'running',
    action: 'Executing approved plan',
    detail: `Running ${proposal.steps.length} planned step(s) with verification and recovery enabled`,
    stepsTotal: proposal.steps.length,
    acceptanceCriteria: proposal.acceptanceCriteria,
    verificationCommands: proposal.verification,
  })
  // Check what the plan believes before building on it.
  //
  // `assumptions` was the planner's own list of what it had not verified, and
  // nothing ever read it back — the highest-leverage field in the whole plan sat
  // inert while every worker built on top of it. A falsified assumption is not a
  // failure here; it is the most valuable thing a run can learn, and learning it
  // before the first edit is the entire point.
  let assumptionBriefing = ''
  if (planApproved && proposal.assumptions.length > 0) {
    writePhase('scaffold', `checking ${proposal.assumptions.length} assumption(s) the plan rests on`)
    const capture = createAssumptionTool(proposal.assumptions)
    const checker = await runSubAgent({
      role: 'scout',
      name: 'assumptions#1',
      runId,
      governor,
      graph,
      nodeId: 'check:assumptions',
      tools: [...allWorkerTools().filter((tool) => ASSUMPTION_TOOL_NAMES.has(tool.name)), capture.tool],
      signal: runSignal,
      prompt: `The plan for this run rests on assumptions nobody has verified:

${proposal.assumptions.map((assumption, index) => `${index + 1}. ${assumption}`).join('\n')}

Goal: ${proposal.goal}

The work has NOT been done yet — that is the point of checking now. So do not look for evidence that an assumption has already been carried out; the project is empty or unfinished by design, and "no source file does this yet" is never an answer.

Ask the right question for each kind:

- An assumption about **the world** ("bcryptjs is compatible with Bun", "the .env file can be created by the builder", "port 3000 is free") is a claim you can settle now. Settle it: install it and import it, run the read-only command, check the version, try the write in a scratch path, read the policy. Report holds or false.
- An assumption that states an **intention** ("validation will use zod", "tests will use bun:test", "the server will use Bun.serve") is a decision, not a belief. Judge whether the decision is *workable here* — is the package installable and compatible, does the runtime support it, does anything in this environment prevent it? Workable is holds; a decision that cannot work here is false, and that is the most valuable thing you can find.

Only report unverifiable when the answer genuinely depends on the user's preference and no amount of looking would settle it. "I could not find it in the code" is not unverifiable.

Finding that an assumption is FALSE is worth more than a confident guess on every other one. Finish by calling submit_assumptions with one entry per assumption.`,
    })
    track(checker.usage)
    const outcome = assumptionOutcome(proposal.assumptions, capture.taken())
    assumptionBriefing = outcome.briefing
    writeSubStep(outcome.summary)
    for (const wrong of outcome.falsified) writeSubStep(`✗ WRONG: ${wrong.assumption} — ${wrong.evidence}`)
    for (const open of outcome.unverifiable) writeSubStep(`? open: ${open.assumption} — ${open.evidence}`)
    journal.append('phase', { phase: 'scaffold', note: 'assumptions checked', summary: outcome.summary, falsified: outcome.falsified, unverifiable: outcome.unverifiable })
  }

  const briefing = `## The goal of this run\n${proposal.goal}\n\n## What we established while planning\n${proposal.understanding}${assumptionBriefing ? `\n\n${assumptionBriefing}` : ''}`
  let totalSavedMs = 0
  const variantCount = options.variants ?? 1

  if (variantCount > 1) {
    writePhase('execute', `${variantCount} parallel implementation attempts`)
    journal.append('phase', { phase: 'execute', variants: variantCount })

    if (runSignal?.aborted) return abortedAt('execute (variants)', { proposal })
    const result = await runVariants({ proposal, briefing, count: variantCount, runId, journal, governor, signal: runSignal })
    track(result.usage)
    for (const step of proposal.steps) {
      const node = graph.node(`step:${step.id}`)
      if (node?.status !== 'completed') {
        if (node?.status === 'pending' || node?.status === 'ready' || node?.status === 'waiting-retry') graph.startNode(`step:${step.id}`)
        graph.finishNode(`step:${step.id}`, { ok: true, report: `verified variant ${result.chosen.index + 1} selected` })
      }
    }
    board.post('variants', 'execute', `chose attempt ${result.chosen.index + 1}/${variantCount} (${result.chosen.verificationSummary}); merged ${result.mergedFiles.length} file(s)`)
    taskSessions.update(parentTask.id, {
      status: 'running',
      action: 'Variant selected',
      detail: `Selected verified attempt ${result.chosen.index + 1}/${variantCount} and merged ${result.mergedFiles.length} file(s)`,
      stepsCompleted: proposal.steps.length,
      stepsTotal: proposal.steps.length,
      progress: proposal.steps.length > 0 ? 1 : 0,
    })
  } else {
    // The plan is no longer frozen at approval. Workers can report that it is
    // wrong — work nobody planned, a step that has to happen first, a step that
    // cannot be done as written — and it is amended between waves. Every one of
    // those was seen: three dependent steps scheduled in one parallel wave, a
    // step told to write a policy-protected file, and a whole goal left to the
    // repair phase because the plan's first step collapsed. Repairing code
    // could not fix any of them, because the code was never the problem.
    // Bound once here as a definitely-present value: re-planning reassigns it
    // below, and a reassignment inside a loop would otherwise widen it back to
    // `Proposal | undefined` for the whole block.
    let plan: Proposal = proposal
    let waves = planWaves(plan.steps).waves
    const planRevisions = createPlanRevisionTool()
    let revisionsApplied = 0
    writePhase('execute', `${plan.steps.length} steps in ${waves.length} wave${waves.length === 1 ? '' : 's'}`)
    journal.append('phase', { phase: 'execute', waves: waves.length })

    let waveCursor = 0
    while (waveCursor < waves.length) {
      const index = waveCursor
      const wave = waves[index]!
      waveCursor += 1
      if (runSignal?.aborted) return abortedAt('execute (waves)', { proposal })
      if (waves.length > 1) writeSubStep(`wave ${index + 1} of ${waves.length}`)
      taskSessions.update(parentTask.id, {
        status: 'running',
        action: `Executing wave ${index + 1} of ${waves.length}`,
        detail: `${wave.length} worker assignment(s) are running in this dependency wave`,
      })

      const pendingWave = wave.filter((step) => {
        const nodeId = `step:${step.id}`
        return graph.node(nodeId)?.status !== 'completed' || graph.needsResumption(nodeId)
      })
      if (pendingWave.length === 0) continue

      // A step whose dependency didn't actually complete (it failed, or is
      // blocked pending human review) can never legally start — startNode()
      // throws "dependencies are incomplete" for it, which used to propagate
      // all the way to an uncaught top-level error and take the whole run
      // down. Skip it here instead, mark it blocked with a clear reason, and
      // let independent steps in the same or later waves still run rather
      // than one failed step silently aborting the entire plan.
      const runnable = pendingWave.filter((step) => {
        const nodeId = `step:${step.id}`
        const unmetDependency = step.dependsOn.find((depId) => graph.node(`step:${depId}`)?.status !== 'completed')
        if (!unmetDependency) return true
        const reason = `blocked: dependency step "${unmetDependency}" did not complete`
        board.post('scheduler', nodeId, `${step.title} — ${reason}`)
        journal.append('step-end', { id: step.id, worker: 'scheduler', ok: false, steps: 0, elapsedMs: 0, report: reason })
        graph.finishNode(nodeId, { ok: false, report: reason, error: reason })
        return false
      })
      if (runnable.length === 0) continue
      for (const step of runnable) graph.startNode(`step:${step.id}`)

      // The project's verification commands only mean anything once the project
      // exists. Applying them to every step made early steps fail by
      // construction — a step whose whole job is to write package.json cannot
      // pass `bun test`, because there are no tests yet — and each false failure
      // then blocked every step behind it. Seen live: a run where step 1 did its
      // work correctly, was marked failed twice by a premature `bun test`, and
      // took the other three steps down with it. The verify phase owns this gate,
      // where it runs against a finished project and has repair attached.
      const fleet = await runFleet({
        assignments: runnable.map((step) => ({
          id: step.id,
          title: step.title,
          role: step.role,
          instructions: step.instructions,
          acceptanceCriteria: plan.acceptanceCriteria,
          sideEffects: plan.sideEffects,
        })),
        extraTools: [planRevisions.tool],
        briefing,
        journal,
        runId,
        governor,
        graph,
        signal: runSignal,
        wave: index + 1,
      })
      track(fleet.usage)
      totalSavedMs += fleet.savedMs

      // Each worker's report goes onto the board, so the next wave inherits what
      // this one learned instead of re-deriving it.
      for (const result of fleet.results) {
        board.post(result.name, `step:${result.id}`, `${result.title} — ${result.report}`)
        graph.finishNode(`step:${result.id}`, {
          ok: result.ok,
          report: result.report,
          // The worker's own prose report, not a thrown exception or a
          // mechanical exit code — leave `error` unset so finishNode falls
          // back to its lenient `source: 'report'` classification instead of
          // reading verdict weight into words like "manual" or "unauthorized"
          // that a free-text report happens to use.
          error: undefined,
          evidence: [{
            id: `evidence:step:${result.id}:${graph.node(`step:${result.id}`)?.attemptCount ?? 0}`,
            nodeId: `step:${result.id}`,
            kind: 'action',
            passed: result.ok,
            summary: result.ok ? `${result.title} completed by ${result.name}` : `${result.title} failed in ${result.name}`,
            data: { worker: result.name, steps: result.steps, report: result.report },
            at: Date.now(),
          }],
        })
      }
      // A failed step takes the rest of the plan down with it: every dependent
      // is blocked, and the run can reach verification with none of its planned
      // work done — leaving the repair loop to rebuild the whole goal by itself
      // in the couple of attempts it has. Both end-to-end runs this was
      // observed on collapsed exactly that way, on their very first step. Give
      // a failed step one more shot with the failure in front of it before the
      // cascade starts.
      const retryable = fleet.results.filter((result) => !result.ok && graph.reopenNode(`step:${result.id}`, result.report))
      if (retryable.length > 0 && !runSignal.aborted) {
        const stepById = new Map(runnable.map((step) => [step.id, step]))
        const retries = retryable.flatMap((result) => {
          const step = stepById.get(result.id)
          return step ? [{ step, report: result.report }] : []
        })
        // Some failures are a statement about the next few seconds rather than
        // about the request — a rate limit above all. Retrying those instantly
        // spends the one retry each step gets on a wall that has not moved yet,
        // so honour the delay the failure classification already worked out.
        const backoffMs = Math.min(
          60_000,
          Math.max(0, ...retries.map(({ step }) => graph.node(`step:${step.id}`)?.lastError?.retryAfter ?? 0)),
        )
        if (backoffMs > 0) {
          writeSubStep(`waiting ${Math.round(backoffMs / 1000)}s before retrying — the failure will not clear any sooner`)
          await delay(backoffMs, runSignal)
        }
        if (runSignal.aborted) break

        writeSubStep(`retrying ${retries.length} failed step(s) once, with the failure report in hand`)
        journal.append('phase', { phase: 'execute', note: `retrying ${retries.map(({ step }) => step.id).join(', ')}`, backoffMs })
        for (const { step } of retries) graph.startNode(`step:${step.id}`)

        const retryFleet = await runFleet({
          assignments: retries.map(({ step, report }) => ({
            id: step.id,
            title: step.title,
            role: step.role,
            instructions: `${step.instructions}

## This assignment already failed once
${clampOutput(report, 2000)}

Do not repeat whatever failed. If a file is protected, a path is refused, or a command is blocked, route around it: use a different path, a different mechanism, or leave that one piece out and finish everything else in the assignment. Coming back with the rest of the work done beats coming back with nothing.`,
            acceptanceCriteria: plan.acceptanceCriteria,
            sideEffects: plan.sideEffects,
          })),
          extraTools: [planRevisions.tool],
          briefing,
          journal,
          runId,
          governor,
          graph,
          signal: runSignal,
          wave: index + 1,
        })
        track(retryFleet.usage)
        totalSavedMs += retryFleet.savedMs

        for (const result of retryFleet.results) {
          board.post(result.name, `step:${result.id}`, `${result.title} (retry) — ${result.report}`)
          graph.finishNode(`step:${result.id}`, {
            ok: result.ok,
            report: result.report,
            // Same reasoning as the first-attempt wave above: a worker's own
            // prose report is not a machine-verdict error, so leave `error`
            // unset and let finishNode classify it leniently via `report`.
            error: undefined,
            evidence: [{
              id: `evidence:step:${result.id}:${graph.node(`step:${result.id}`)?.attemptCount ?? 0}`,
              nodeId: `step:${result.id}`,
              kind: 'action',
              passed: result.ok,
              summary: result.ok ? `${result.title} completed by ${result.name} on retry` : `${result.title} failed again in ${result.name}`,
              data: { worker: result.name, steps: result.steps, report: result.report, retry: true },
              at: Date.now(),
            }],
          })
        }
      }

      // A checkpoint per wave, not per step: everything inside a wave runs
      // concurrently against the same tree, so their edits genuinely cannot be
      // separated into one commit each. The wave is the real increment
      // boundary, and committing it gives both a rollback point and a history
      // the user can actually read afterwards.
      const landed = wave
        .filter((step) => graph.node(`step:${step.id}`)?.status === 'completed')
        .map((step) => `${step.id}: ${step.title}`)
      if (landed.length > 0) {
        const commit = await commitAll(
          process.cwd(),
          `Wave ${index + 1}: ${landed.length === 1 ? landed[0] : `${landed.length} steps`}\n\n${landed.map((entry) => `- ${entry}`).join('\n')}`,
          runSignal,
          protectedPaths,
          wave.flatMap((step) => step.files),
        )
        if (commit.committed) writeSubStep(`committed wave ${index + 1} (${landed.length} step(s))`)
        if (commit.excluded.length > 0) writeSubStep(`⚠ kept out of the commit because they hold secrets: ${commit.excluded.join(', ')}`)
        if (commit.warning) writeSubStep(`⚠ ${commit.warning}`)
        if (commit.committed) hasLocalHistory = true
      }

      // Amend the plan before scheduling anything else, so a missing step is
      // built in the right order rather than bolted on at the end.
      const requested = planRevisions.taken()
      if (requested.length > 0 && revisionsApplied < MAX_PLAN_REVISIONS) {
        const completedIds = new Set(
          graph.state().nodes.filter((node) => node.kind === 'step' && node.status === 'completed').map((node) => node.id.replace(/^step:/, '')),
        )
        const revision = applyPlanRevisions(plan, requested, completedIds, MAX_PLAN_REVISIONS - revisionsApplied)
        for (const change of revision.applied) writeSubStep(`plan revised — ${change}`)
        for (const refusal of revision.rejected) writeSubStep(`⚠ plan revision refused — ${refusal}`)
        journal.append('phase', { phase: 'execute', note: 'plan revised', applied: revision.applied, rejected: revision.rejected })
        if (revision.applied.length > 0) {
          revisionsApplied += revision.applied.length
          plan = revision.proposal
          proposal = plan
          graph.seedProposal(plan)
          // Re-schedule from the top: completed steps fall out as empty waves,
          // and a newly added step lands wherever its dependencies put it
          // rather than always at the end.
          waves = planWaves(plan.steps).waves
          waveCursor = 0
          taskSessions.update(parentTask.id, { stepsTotal: plan.steps.length })
        }
      }

      const completedSteps = graph.state().nodes.filter((node) => node.kind === 'step' && node.status === 'completed').length
      taskSessions.update(parentTask.id, {
        status: 'running',
        action: 'Wave finished',
        detail: `${completedSteps}/${plan.steps.length} planned step(s) have completed; continuing with remaining work or verification`,
        stepsCompleted: completedSteps,
        progress: plan.steps.length > 0 ? completedSteps / plan.steps.length : 0,
      })
    }
  }

  // --- Publish ----------------------------------------------------------

  // The one outward-facing act in the whole run, so it goes through the
  // governor: one question, once, and never a guess. This runs after Execute,
  // not right after Scaffold, so the repository that gets created/pushed
  // actually contains the wave commits that carry the delivered work — not
  // just the initial commit of `.gitignore` and generated docs. Everything
  // above already happened locally, so a run that cannot or may not publish
  // still has its full history and documents.
  if (planApproved && hasLocalHistory) {
    writePhase('publish', 'pushing the completed work to GitHub')
    const published = await publishProject({ cwd: process.cwd(), proposal, governor, signal: runSignal })
    if (published.status === 'created') writeSubStep(`created and pushed ${published.url ?? 'the GitHub repository'}`)
    else if (published.status === 'pushed') writeSubStep(`pushed to ${published.url ?? 'origin'}`)
    else if (published.reason) writeSubStep(`not published — ${published.reason}`)
    if (published.issues > 0) writeSubStep(`tracked the plan as ${published.issues} issue(s) across ${published.milestones} milestone(s)`)
    for (const warning of published.warnings) writeSubStep(`⚠ ${warning}`)
    journal.append('phase', { phase: 'publish', published: published.status, url: published.url, issues: published.issues, milestones: published.milestones, reason: published.reason })
  }

  // --- Polish ---------------------------------------------------------------

  // Polishing happens before the normal verification/review gate, so any useful
  // improvement is judged by the same objective checks and adversarial reviewers
  // as the implementation itself. The pass is bounded and may legitimately make
  // no changes; "more" is not automatically "better".
  if (runPolish && maxPolishPasses > 0) {
    taskSessions.update(parentTask.id, { status: 'running', action: 'Polishing', detail: 'Running the bounded final quality pass before verification' })
    writePhase('polish', `${maxPolishPasses} bounded final quality pass${maxPolishPasses === 1 ? '' : 'es'}`)
    for (let polishAttempt = 1; polishAttempt <= maxPolishPasses; polishAttempt++) {
      if (runSignal?.aborted) return abortedAt('polish', { proposal })
      journal.append('phase', { phase: 'polish', attempt: polishAttempt })

      const diff = await runShell('git diff HEAD', 30_000, undefined, runSignal)
      const diffText = diff.stdout.trim() ? clampOutput(diff.stdout.trim(), 8000) : '(no diff yet — inspect the completed work and the goal)'
      const polish = await runSubAgent({
        role: 'polisher',
        name: `polisher#${polishAttempt}`,
        runId,
        governor,
        briefing,
        signal: runSignal,
        prompt: `The implementation phase is complete. Perform one final, conservative quality pass before the verification gate.

Goal:
${proposal.goal}

Current diff:
${diffText}

Read the changed files in full context. Improve only concrete issues directly related to the goal: incomplete edge cases, unclear behavior, missing focused tests, stale documentation, duplicated logic, or rough user-facing output. Do not add speculative features, change unrelated files, weaken checks, or rewrite working code for style alone. If the result is already strong, make no changes and say so. Finish by reporting exactly what changed and what still needs verification.`,
      })
      track(polish.usage)
      recordUsage(polish.usage)
      writeSubStep(polish.report)

      // A second pass is useful only when the first pass actually changed the
      // tree; otherwise stop early rather than rewarding autonomous churn.
      const after = await runShell('git diff HEAD', 30_000, undefined, runSignal)
      if (after.stdout === diff.stdout) break
    }
  }

  // --- Verify ---------------------------------------------------------------

  let verdict: CriticVerdict | undefined
  let attempt = 0
  // Getting a broken build green and fixing what the reviewers then find are two
  // different jobs, and the review only ever runs on a change that already
  // builds. Sharing one counter meant a run that spent its repairs reaching a
  // green build arrived at its first review with no budget left to act on it —
  // stopping at the exact point where the most is known about the change. Each
  // gate therefore gets its own allowance of `maxRepairAttempts`.
  let buildRepairs = 0
  let reviewRepairs = 0
  // Per-gate budgets bound the common path, but a change that flips verification
  // red↔green across review repairs can draw on both gates in a way that adds up.
  // This is the absolute ceiling on model repair passes for the whole run — once
  // hit, the run hands off regardless of which gate is open.
  const MAX_TOTAL_REPAIRS = maxRepairAttempts * 2 + 1
  let totalRepairs = 0
  // Fingerprints of what was still failing after each verify+review pass, oldest
  // first — the input to the deterministic "are repairs actually converging?"
  // check that stops a thrashing run early instead of at the budget.
  const progressHistory: AttemptSnapshot[] = []
  // Each stall-recovery move (reconsider the approach, fix the environment) is
  // allowed once — after that a repeat stall is a genuine handoff, not another
  // lap.
  const escalationsUsed = new Set<StuckRecovery>()
  let lastRepairReport = ''
  let pendingApproachChange: string | undefined
  const verificationRoot = checkRoot(proposal.steps.flatMap((step) => step.files), process.cwd())
  // How much a "looks fine" verdict on this run is actually worth. A
  // `judgment`-regime run has nothing but self-critique behind it, so its
  // conclusions stay in this session and never become durable lessons.
  verificationRegime = classifyRegime(
    proposal.steps.flatMap((step) => step.files),
    proposal.verification,
    process.cwd(),
  )
  // Baseline: the post-execute state. Each passing verification refreshes this
  // to the current state; a wrong-approach stall rewinds the working tree here.
  greenSnapshot = await captureTreeSnapshot(process.cwd(), runDir(runId))

  while (true) {
    if (runSignal?.aborted) return abortedAt('verify', { proposal, verdict })

    taskSessions.update(parentTask.id, { status: 'running', action: 'Verifying', detail: proposal.verification.length > 0 ? `Running ${proposal.verification.length} verification command(s)` : 'Running structured review without declared commands' })
    writePhase('verify', proposal.verification.length > 0 ? proposal.verification.join(' · ') : 'review only')
    journal.append('phase', { phase: 'verify', attempt })

    const verification = await runVerification(proposal.verification, verificationRoot, runSignal, governor)
    for (const result of verification.results) {
      const label = `$ ${result.command}`
      if (result.exitCode === 0 && !result.timedOut) writePass(label)
      else writeFail(`${label} — ${result.timedOut ? 'timed out' : `exit ${result.exitCode}`}`)
    }
    verificationPassed = verification.passed
    // A fresh green: this is now the state a "wrong approach" rewind returns to.
    // captureTreeSnapshot overwrites the single per-run snapshot slot.
    if (verification.passed && !rewoundOnce) {
      greenSnapshot = (await captureTreeSnapshot(process.cwd(), runDir(runId))) ?? greenSnapshot
    }
    const verificationData = {
      passed: verification.passed,
      results: verification.results.map((result) => ({
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        elapsedMs: result.elapsedMs,
        stdout: redactText(clampOutput(result.stdout, 1200), 1200),
        stderr: redactText(clampOutput(result.stderr, 1200), 1200),
      })),
    }
    journal.append('verify', verificationData)
    graph.recordVerification(verification.passed, verificationData)

    // Only spend a critic on a change that already builds. Reviewing code that
    // doesn't compile just rediscovers the compiler's own error, slowly.
    if (verification.passed) {
      // Fetched once and handed to every reviewer directly, instead of each of
      // them independently spending a tool round-trip (reasoning + tool_use +
      // tool_result, all billed) to ask git the same question. Three reviewers
      // asking separately used to cost 3x this round-trip for identical output.
      const [diff, numstat, status] = await Promise.all([
        runShell('git diff HEAD', 30_000, undefined, runSignal),
        // The file inventory comes from --numstat rather than from the clamped
        // diff text, so it stays complete even when the diff itself is cut.
        runShell('git diff --numstat HEAD', 30_000, undefined, runSignal),
        runShell('git status --porcelain=v1', 30_000, undefined, runSignal),
      ])
      const diffSection = buildReviewDiffSection({ diff: diff.stdout, numstat: numstat.stdout })
      const changedFiles = diffSection.files.map((file) => file.path)
      // A diff that only touches prose has no exploit surface and no logic to
      // break, so paying for a security and a bug-hunt pass on it is waste —
      // skip straight to the one reviewer whose job (was this actually done?)
      // still applies to docs.
      const docsOnly = changedFiles.length > 0 && changedFiles.every((file) => /\.(md|mdx|txt)$/i.test(file))

      writeSubStep(
        docsOnly
          ? 'running review — docs-only diff, skipping security/bug-hunt passes'
          : 'running adversarial review — correctness, security, and bugs in parallel',
      )

      const reviewContext = `## What was promised
${proposal.goal}

Steps that were executed:
${proposal.steps.map((step) => `- ${step.id} (${step.role}): ${step.title} — files: ${step.files.join(', ') || 'unspecified'}`).join('\n')}

## Risks flagged during planning
${proposal.risks.length > 0 ? proposal.risks.map((risk) => `- ${risk}`).join('\n') : '(none flagged)'}

${diffSection.text}

## git status
${status.stdout.trim() || '(clean)'}

Read the changed files in full for context beyond the diff above — a diff hides the sibling code that makes a snippet correct or broken.`

      // Multiple specialists look at the same diff from different angles at
      // once, rather than one generalist critic trying to hold correctness,
      // security, and functional-bug-hunting in mind simultaneously. Each gets
      // its own verdict tool instance since they run concurrently and must not
      // share captured state.
      const reviewers: { role: 'critic' | 'security' | 'bughunter'; name: string; focus: string }[] = docsOnly || defaults.reviewerCount === 1
        ? [{ role: 'critic', name: 'critic#1', focus: 'Check specifically whether each promised step was really done, not just claimed, and catch concrete correctness or UX defects.' }]
        : [
            { role: 'critic', name: 'critic#1', focus: 'Check specifically whether each promised step was really done, not just claimed.' },
            { role: 'security', name: 'security#1', focus: 'Focus only on exploitable security weaknesses in what changed.' },
            { role: 'bughunter', name: 'bughunter#1', focus: 'Focus only on functional/logic bugs in what changed.' },
          ]

      // This project has a track record of over-claiming completion — add
      // reviewers whose whole job is to check "done" against the actual diff.
      if (!docsOnly && reliability.extraReviewers > 0) {
        reviewers.push({ role: 'bughunter', name: 'bughunter#2', focus: `${reliability.note} Verify every claimed step against the real diff; find where the work is incomplete or the claim is wrong.` })
        if (reliability.extraReviewers >= 2) {
          reviewers.push({ role: 'critic', name: 'critic#2', focus: 'Assume this run over-claims. Name every step it said it did that it did not fully do.' })
        }
      }

      const reviewResults = await Promise.all(
        reviewers.map(async (reviewer) => {
          const verdictCapture = createVerdictTool()
          const reviewerTools = allWorkerTools().filter((tool) => REVIEWER_TOOL_NAMES.has(tool.name))
          const result = await runSubAgent({
            role: reviewer.role,
            name: reviewer.name,
            runId,
            governor,
            graph,
            nodeId: `review:${reviewer.name}`,
            briefing,
            tools: [...reviewerTools, verdictCapture.tool],
            signal: runSignal,

            prompt: `${reviewContext}

This reviewer session is intentionally read-only. The current diff, status, and verification evidence are already supplied above. Do not run shell commands, use network tools, modify files, delegate work, or treat a claimed result as stronger than the supplied evidence. Read only the files needed to validate the claims, then ${reviewer.focus} Finish by calling submit_verdict.`,
          })

          const submittedVerdict = verdictCapture.taken()
          if (!submittedVerdict) {
            // Prose cannot drive a safety gate. Preserve it for diagnosis, then send
            // the structured fail-closed verdict through the normal repair path.
            writeBlock(`Review (unstructured) — ${reviewer.name}`, result.report)
          }
          return { reviewer: reviewer.name, usage: result.usage, verdict: requireCriticVerdict(submittedVerdict, reviewer.name) }
        }),
      )

      for (const result of reviewResults) track(result.usage)

      // The run wrote down what "done" means; this is the only thing that reads
      // it back. Every other gate judges process — steps completed, exit codes,
      // open-ended review — and none of them knows what was promised, so a run
      // could pass all of them while quietly not doing the thing it said it
      // would. Narrower than the other reviewers on purpose: a fixed list of
      // questions the run set itself, which is what makes the answers checkable.
      const criteria = proposal.acceptanceCriteria ?? []
      let acceptance: CriticVerdict = acceptanceVerdict([], undefined)
      if (criteria.length > 0) {
        const acceptanceCapture = createAcceptanceTool(criteria)
        const acceptanceResult = await runSubAgent({
          role: 'critic',
          name: 'acceptance#1',
          runId,
          governor,
          graph,
          nodeId: 'review:acceptance',
          briefing,
          tools: [...allWorkerTools().filter((tool) => REVIEWER_TOOL_NAMES.has(tool.name)), acceptanceCapture.tool],
          signal: runSignal,
          prompt: `${reviewContext}

## The acceptance criteria this run declared

${criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}

Read the delivered code and tests and decide, for each criterion above, whether the work actually meets it. This session is read-only: do not run commands, modify files, or delegate.

Judge what is there, not what the code looks like it would probably do. A criterion about behaviour is met when a test exercises that behaviour and passes, or when the code path plainly implements it — not when a function with a matching name exists. Say what the evidence is, and when a criterion is not met, say exactly what is missing. Finish by calling submit_acceptance with one entry per criterion.`,
        })
        track(acceptanceResult.usage)
        const reported = acceptanceCapture.taken()
        if (!reported) writeBlock('Acceptance check (unstructured)', acceptanceResult.report)
        acceptance = acceptanceVerdict(criteria, reported)
        writeSubStep(acceptance.summary)
        journal.append('verdict', { reviewer: 'acceptance', criteria, reported: reported ?? null })
      }

      // A deterministic reviewer alongside the model ones. It catches the two
      // defects a green test suite structurally cannot — a package imported but
      // never declared (Bun auto-installs it, so the tests pass and the project
      // is broken for everyone else) and scratch files left in the deliverable —
      // and it votes through the same merge, so the repair loop treats its
      // findings exactly like a critic's.
      const hygiene = hygieneVerdict(deliverableFiles(status.stdout, changedFiles, startedAt))
      verdict = mergeVerdicts([
        ...reviewResults.map(({ reviewer, verdict }) => ({ reviewer, verdict })),
        { reviewer: 'acceptance', verdict: acceptance },
        { reviewer: 'hygiene', verdict: hygiene },
      ])

      journal.append('verdict', { ...verdict })
      reviewPassed = !hasBlockingIssues(verdict)
      graph.recordReview(reviewPassed, { verdict })
      if (reviewPassed) {
        writePass(verdict.summary)
        if (verdict.issues.length > 0) writeBlock('Minor notes', describeIssues(verdict.issues))
        break
      }
      writeFail(verdict.summary)
      writeBlock('Issues found', describeIssues(verdict.issues))
    }

    // Record this pass's failure fingerprints and check the trajectory. A run
    // that reproduces the same failures attempt after attempt, or regresses, is
    // told to stop now with a precise diagnosis rather than spending the rest of
    // its budget rediscovering the same wall.
    progressHistory.push({ attempt, failures: failureFingerprints(verification, verification.passed ? verdict : undefined) })
    const progress = assessProgress(progressHistory)
    pendingApproachChange = undefined
    // Which allowance this pass draws on: the build gate while verification is
    // red, the review gate once it is green.
    const gate = verification.passed ? 'review' : 'build'
    const repairsSpent = verification.passed ? reviewRepairs : buildRepairs
    // Show the repair trajectory so a long repair phase reads as progress, not a hang.
    if (progressHistory.length > 1 && progress.trend !== 'resolved') {
      const counts = progressHistory.map((snap) => snap.failures.length).join(' → ')
      writeSubStep(`repair ${gate} ${repairsSpent}/${maxRepairAttempts} · failures ${counts} · ${progress.trend}`)
    }
    if (progress.recommendation === 'stop' && (progress.trend === 'stalled' || progress.trend === 'diverging')) {
      // Command output and review prose are kept apart on purpose: a security
      // reviewer writing "an attacker gains unauthorized access" is describing a
      // defect, not reporting that elia is blocked on a credential.
      const failureText = verification.passed ? '' : describeVerification(verification)
      const reviewText = describeIssues(verdict?.issues ?? [])
      const stuck = classifyStuck({ failureText, reviewText, agentReport: lastRepairReport, trend: progress.trend })
      const canEscalate =
        repairsSpent < maxRepairAttempts &&
        (stuck.recovery === 'replan' || stuck.recovery === 'fix-environment') &&
        !escalationsUsed.has(stuck.recovery)

      if (canEscalate) {
        // One genuine attempt at the different move the diagnosis points to —
        // reconsider the approach, or fix the environment first — before giving up.
        escalationsUsed.add(stuck.recovery)

        // For a wrong-approach stall, rewind the working tree to the last
        // verified-good state so the re-plan starts from a clean slate instead
        // of on top of a pile of failed edits. One rewind per run.
        let rewindNote = ''
        if (stuck.recovery === 'replan' && greenSnapshot && !rewoundOnce) {
          const { reverted, warnings } = await restoreTreeSnapshot(greenSnapshot)
          rewoundOnce = true
          const base = greenSnapshot.clean ? 'the pristine starting state (verification never passed)' : 'the last state that passed verification'
          rewindNote = `\n\nThe working tree has been reset to ${base}: ${reverted.length} file(s) from the failed attempts were discarded.${warnings.length > 0 ? ` (Could not fully restore: ${warnings.join('; ')}.)` : ''} Do not try to re-apply what was there — start the new approach from what is on disk now.`
          writeSubStep(`Rewound the working tree to the last green checkpoint (${reverted.length} file(s) discarded) before re-planning.`)
          journal.append('phase', { phase: 'reflect', attempt, note: `tree rewound to last green: ${reverted.length} file(s) discarded${warnings.length ? `; warnings: ${warnings.join('; ')}` : ''}` })
        }

        pendingApproachChange = (stuck.recovery === 'replan'
          ? `The last ${attempt} repair attempts kept hitting the same wall. Stop patching the current approach. Step back: re-read the relevant code, reconsider whether the chosen approach can work at all, and implement a genuinely different solution to the goal.`
          : `The failure is an environment problem, not a defect in the change: ${stuck.reason} Fix the environment first (install the missing dependency, create the missing file, free the port), then re-run verification.`) + rewindNote
        writeSubStep(`Not converging (${progress.trend}) — ${stuck.category}: trying a ${stuck.recovery === 'replan' ? 'different approach' : 'environment fix'} once before handing off.`)
        journal.append('phase', { phase: 'reflect', attempt, note: `stall escalation: ${stuck.category} -> ${stuck.recovery}` })
      } else {
        writeSubStep(`Stopping repair — ${stuck.category}: ${stuck.reason}`)
        if (stuck.question) writeBlock('Needs a decision from you', stuck.question)
        journal.append('phase', { phase: 'reflect', attempt, note: `stopped (${progress.trend} / ${stuck.category}): ${stuck.reason}${stuck.question ? ` Question: ${stuck.question}` : ''}` })
        const auto = repeatedFailureLesson({ goal, gate, repeated: progress.repeated, attempts: attempt })
        const lessons = await captureLessons(goal, proposal, 'unresolved', journal, track, governor, graph, verificationRegime, runSignal, auto ? [auto] : [])
        return done('needs-attention', { proposal, verdict, lessons })
      }
    }

    if (repairsSpent >= maxRepairAttempts || totalRepairs >= MAX_TOTAL_REPAIRS) {
      const why = repairsSpent >= maxRepairAttempts ? `${gate} gate exhausted` : `repair ceiling reached (${totalRepairs})`
      writeSubStep(`Stopping after ${attempt} repair attempt${attempt === 1 ? '' : 's'} (${why}) — this needs a human.`)
      // Only draw the lesson when the trajectory actually stalled/regressed — a
      // run that was still converging when the budget ran out has no dead
      // approach to warn a future run about.
      const recurred = progress.trend === 'stalled' || progress.trend === 'diverging' ? progress.repeated : []
      const auto = repeatedFailureLesson({ goal, gate, repeated: recurred, attempts: attempt })
      const lessons = await captureLessons(goal, proposal, 'unresolved', journal, track, governor, graph, verificationRegime, runSignal, auto ? [auto] : [])
      return done('needs-attention', { proposal, verdict, lessons })
    }

    // --- Reflect & repair ---------------------------------------------------

    attempt += 1
    totalRepairs += 1
    if (verification.passed) reviewRepairs += 1
    else buildRepairs += 1
    const gateAttempt = verification.passed ? reviewRepairs : buildRepairs
    taskSessions.update(parentTask.id, { status: 'running', action: 'Repairing', detail: `Addressing ${gate} failures (${gate} attempt ${gateAttempt} of ${maxRepairAttempts})` })
    writePhase('reflect', `${gate} attempt ${gateAttempt} of ${maxRepairAttempts}`)
    journal.append('phase', { phase: 'reflect', attempt, gate, gateAttempt })

    const problem = verification.passed
      ? `Adversarial review found blocking problems:\n\n${describeIssues(verdict?.issues ?? [])}`
      : `Verification failed:\n\n${describeVerification(verification)}`

    // When the plan collapsed — a step failed and every step behind it was
    // blocked — the repair agent otherwise sees only a red or green gate and
    // has no idea most of the goal was never attempted. Name the missing work
    // so the repair delivers it instead of only patching what the gate said.
    const unfinished = graph.state().nodes.filter((node) => node.kind === 'step' && node.status !== 'completed')
    const planGap = unfinished.length > 0
      ? `\n\n## ${unfinished.length} of ${proposal.steps.length} planned step(s) never completed — this work is still owed and is part of this repair\n${unfinished
          .map((node) => `- ${node.title} (${node.status})${node.lastError ? `: ${node.lastError.message.slice(0, 200)}` : ''}`)
          .join('\n')}`
      : ''

    // When earlier repair passes have not shifted a particular failure, tell the
    // repair agent explicitly so it stops re-applying the same fix and tries a
    // genuinely different approach on the parts that are stuck.
    const persisted = progress.trend === 'converging' && progress.repeated.length > 0
      ? `\n\n## These specific failures have persisted through ${attempt - 1} earlier repair attempt(s) — a different approach is needed on them, not the same fix again:\n${progress.repeated.map((f) => `- ${f.replace(/^(verify|review):/, '')}`).join('\n')}`
      : ''

    // A stall the classifier flagged for a specific recovery move overrides the
    // ordinary "fix what went wrong" framing for this one attempt.
    const directive = pendingApproachChange ? `\n\n## Change of tack\n${pendingApproachChange}` : ''

    const repairMessages: ConversationMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${briefing}\n\n## What went wrong\n${problem}${planGap}${persisted}${directive}\n\nFix all of it, then re-run: ${proposal.verification.join(' && ') || '(no verification commands were defined)'}`,
          },
        ],
      },
    ]
    journal.checkpoint(`before-repair-${attempt}`, repairMessages)

    const cache = createToolResultCache()
    const repairTools = [...allWorkerTools(), taskTool]
    const repair = await withAgentIdentity({ name: 'lead', role: 'lead', runId, cwd: process.cwd(), signal: runSignal }, () => withActionGovernor(governor, () => withGoalGraph(graph, () => runAgentLoop({
      messages: repairMessages,
      systemPrompt: repairPromptForMode(activeMode()),
      tools: repairTools,
      onText: streamOnText(),
      useAnimation: true,
      verbose: true,
      maxSteps: 50,
      cache,
      prefetcher: createPrefetcher({ tools: repairTools, cache }),
      signal: runSignal,
      onTool: (event) => appendActionAudit(event, runId),
    }))))
    track(repair.usage)
    recordUsage(repair.usage)
    // Kept so the next stall check can read the repair agent's own account of
    // what it could or couldn't do — the signal behind the missing-information
    // and wrong-approach classifications.
    lastRepairReport = lastAssistantText(repairMessages, '')
  }

  // --- Learn ---------------------------------------------------------------

  taskSessions.update(parentTask.id, { status: 'running', action: 'Learning', detail: 'Capturing durable lessons for future runs' })
  const lessons = captureLearning ? await captureLessons(goal, proposal, 'succeeded', journal, track, governor, graph, verificationRegime, runSignal) : []

  writeSummary('Run complete', [
    ['run', runId],
    ['goal', proposal.goal],
    ['workers', String(proposal.steps.length)],
    ...(variantCount > 1 ? ([['variants', `${variantCount} attempts run, best verified one kept`]] as [string, string][]) : []),
    ['parallel saving', formatElapsed(totalSavedMs)],
    ['repairs', String(attempt)],
    ['review', verdict ? verdict.summary : 'not available'],
    ['lessons kept', String(lessons.length)],
    ['elapsed', formatElapsed(Date.now() - startedAt)],
    ['models', config.cascadeEnabled ? `${config.tiers.deep.label} + ${config.tiers.fast.label}` : config.tiers.deep.label],
  ])

  return done('completed', { proposal, verdict, lessons })
}

/**
 * Ends the run by writing down what a future run should know. Deliberately on the
 * fast tier: it's a short summarisation job over material that is already in hand,
 * and the deep model adds nothing but latency at the end of a long run.
 */
async function captureLessons(
  goal: string,
  proposal: Proposal,
  status: 'succeeded' | 'unresolved',
  journal: Journal,
  track: (usage: Usage) => void,
  governor: ActionGovernor,
  graph: GoalGraphStoreType,
  /** How much this run's verification was actually worth — `judgment` runs record nothing durable. */
  regime: VerificationRegime,
  signal?: AbortSignal,
  /** Deterministic lessons the loop already knows to record (e.g. a repeated repair failure). */
  deterministic: string[] = [],
): Promise<string[]> {
  writePhase('learn')
  journal.append('phase', { phase: 'learn', regime })

  // Nothing outside elia's own opinion checked this run. A "lesson" drawn from a
  // review-only pass is exactly the closed-loop signal that lets a reasoner
  // entrench its own mistakes across runs, so it is kept out of the durable
  // store — the run's findings still live in this session's transcript.
  if (regime === 'judgment') {
    writeSubStep('verification was judgement-only (no mechanical or empirical check) — not recording cross-run lessons from this run')
    journal.append('lesson', { lessons: [], source: 'skipped:judgment-regime' })
    return []
  }

  // Recorded first and unconditionally: the model-driven pass below can decide
  // there is "nothing durable", but a repair loop that gave up against the same
  // failure twice has already produced a fact worth carrying forward.
  if (deterministic.length > 0) {
    appendLessons(deterministic.map((text) => ({ text, source: 'auto-deterministic', confidence: 0.95 })))
    journal.append('lesson', { lessons: deterministic, source: 'deterministic' })
    for (const lesson of deterministic) writeSubStep(`learned: ${lesson}`)
  }

  const capture = createLessonsTool()

  try {
    const result = await runSubAgent({
      role: 'scout',
      name: 'scribe#lessons',
      runId: journal.runId,
      governor,
      graph,
      nodeId: 'learn:lessons',
      extraTools: [capture.tool],
      signal,
      prompt: `An autonomous run just ${status === 'succeeded' ? 'completed' : 'stopped without fully succeeding'}.

Goal: ${goal}
Plan understanding: ${proposal.understanding}
Verification commands used: ${proposal.verification.join(', ') || '(none)'}

Read the shared blackboard with \`board_read\` to see what the workers actually found and hit. Then call submit_lessons with anything a *future* run in this project would want to know before starting — and nothing else. Do not investigate further; work only from the board. Run notes live at ${journal.dir}.`,
    })
    track(result.usage)
  } catch {
    return [] // Learning is a bonus; never let it fail a finished run.
  }

  const lessons = capture.taken()
  if (lessons.length > 0) {
    appendLessons(lessons)
    journal.append('lesson', { lessons })
    for (const lesson of lessons) writeSubStep(`learned: ${lesson}`)
  } else if (deterministic.length === 0) {
    writeSubStep('nothing durable worth keeping from this run')
  }
  return [...deterministic, ...lessons]
}

/**
 * The glance a person takes before touching an unfamiliar repo. Gathered up front
 * with real commands so the planner starts from facts instead of spending its
 * first three tool calls asking what kind of project this is.
 */
/** A wait that a cancelled run does not have to sit through. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * What the hygiene audit should look at. Git is the precise answer whenever the
 * deliverable lives in a repo. A run that scaffolded a project from nothing into
 * an empty directory has no git at all, and there every file present is one the
 * run created — which is exactly the case the audit exists for, so falling back
 * to a tree scan keeps it covered instead of silently checking nothing.
 */
function deliverableFiles(statusOutput: string, diffChanged: string[], runStartedAt: number): HygieneInput {
  const cwd = process.cwd()
  const fromGit = filesFromGitStatus(statusOutput)
  const changedFiles = [...new Set([...fromGit.changed, ...diffChanged])].filter(Boolean)
  if (changedFiles.length > 0) return { cwd, addedFiles: fromGit.added, changedFiles }
  // Without git, only the run's own mtimes distinguish what it created from what
  // was already sitting in the directory — and a scratch-looking file the user
  // already had is not this run's to delete.
  return { cwd, addedFiles: scanProjectFiles(cwd, { modifiedSince: runStartedAt }), changedFiles: scanProjectFiles(cwd) }
}

async function projectSnapshot(runId: string, signal?: AbortSignal): Promise<string> {
  const environment = await withAgentIdentity({ name: 'lead', role: 'lead', runId, cwd: process.cwd(), signal }, () => environmentTool.execute({}))
  const [tree, status, branch] = await Promise.all([
    runShell(process.platform === 'win32' ? 'dir /b' : 'ls -1', 10_000, process.cwd(), signal),
    runShell('git status --porcelain=v1 --branch', 10_000, process.cwd(), signal),
    runShell('git log --oneline -5', 10_000, process.cwd(), signal),
  ])

  const sections = [
    `Environment preflight:\n${environment}`,
    `Top level:\n${tree.stdout.trim() || '(empty)'}`,
    status.exitCode === 0 ? `Git status:\n${status.stdout.trim() || '(clean)'}` : 'Not a git repository.',
    branch.exitCode === 0 && branch.stdout.trim() ? `Recent commits:\n${branch.stdout.trim()}` : '',
  ]
  return sections.filter(Boolean).join('\n\n')
}
