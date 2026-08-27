import { DEV_SYSTEM_PROMPT, config, tierConfig } from '../config.ts'
import { runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { taskTool } from '../tools/task.ts'
import { allWorkerTools } from '../tools/registry.ts'
import { environmentTool } from '../tools/environment.ts'
import { runSubAgent } from '../subagent.ts'
import { runShell, clampOutput } from '../shell.ts'
import { ZERO_USAGE, addUsage, formatElapsed, recordUsage } from '../usage.ts'
import type { Usage } from '../providers/types.ts'
import { writeText } from '../ui/stream.ts'
import { writeBlock, writeFail, writePass, writePhase, writeSubStep, writeSummary } from '../ui/report.ts'
import { createToolResultCache } from '../speculation/cache.ts'
import { createPrefetcher } from '../speculation/prefetch.ts'
import { createBlackboard, setActiveBlackboard } from './blackboard.ts'
import { createTodoList, setActiveTodoList } from './todoList.ts'
import { withAgentIdentity } from './context.ts'
import { activeMode } from './mode.ts'
import { loadDevelopmentToolHooks, withToolHooks } from './devHooks.ts'
import { createJournal, newRunId, type Journal } from './journal.ts'
import { planWaves, runFleet } from './fleet.ts'
import { runVariants } from './variants.ts'
import { createProposalTool, renderProposal } from './proposal.ts'
import { savePlanArtifact } from './artifacts.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { redactText } from '../ui/redact.ts'
import { appendLessons, createLessonsTool, renderLessons } from './lessons.ts'
import {
  createVerdictTool,
  describeIssues,
  describeVerification,
  hasBlockingIssues,
  mergeVerdicts,
  requireCriticVerdict,
  runVerification,
} from './verify.ts'
import type { CriticVerdict, Proposal } from './types.ts'
import { appendActionAudit, writeRunReceipt } from './audit.ts'
import { createActionGovernor, withActionGovernor, type ActionApproval, type ActionGovernor, type ActionGovernorStats, type GovernanceMode } from './governor.ts'
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

const PLANNER_PROMPT = `${DEV_SYSTEM_PROMPT}

## Right now you are planning, not building

You are in the orient-and-propose phase of an autonomous run. You must NOT change anything yet — you have no write tools in this phase, by design.

Work like an engineer picking up an unfamiliar ticket:
1. Look at the shape of the project and call environment before forming any opinion; verify runtimes, credentials presence, browser transport presence, git state, and the detected project shape.
2. Send several scouts out in parallel (call \`task\` with role "scout" multiple times in one turn) to answer the specific questions you need answered. Scouts are fast and cheap; serial investigation is the single biggest waste of wall-clock time available to you, so batch it.
3. Read the handful of files that actually decide the design yourself.
4. Then call \`submit_proposal\` exactly once and stop.

Do not write the plan out in prose first. The proposal is rendered for the user from the tool call itself, so narrating it beforehand just shows them the same plan twice. Investigate, then submit.

What makes a good proposal:
- \`understanding\` names real files, real symbols, real patterns you verified. Not "the codebase appears to use X" — say which file proves it.
- Steps are decomposed for parallelism. Two steps touching disjoint files with no ordering requirement must NOT depend on each other; each unnecessary dependency costs the user wall-clock time.
- Pick the specific role for each step, not just "builder": use \`frontend\` for UI/component/styling/client-side work and \`backend\` for API/business-logic/data work — a change that touches both should be two independent steps (one per role) so they execute in parallel instead of one generalist doing both serially.
- Every step's instructions stand alone. The worker executing it sees your instructions and nothing else — not this conversation, not the other steps.
- \`verification\` is real commands from this project that will actually fail if the work is wrong. Look them up in package.json or the docs; do not invent them.
- Assumptions are where you guessed. The user correcting a wrong assumption now costs seconds; discovering it after the work costs the whole run.
- Identify the capability domains involved (business, finance, data, research, cybersecurity, automation, communications, AI/ML, marketing, or software) and assign the right specialist role to each step.
- Define an acceptance contract for the final result: artifact or action delivered, evidence required, domain-specific quality checks, unresolved uncertainty, and what the user must approve.
- List every external side effect separately. Drafting is not sending; analysis is not execution; authorized security assessment is not permission to attack. Any consequential action must have an exact approval boundary and a postcondition check.
- Define recovery: which steps are idempotent, which completed actions must never be repeated, what can be retried, and what user input is needed if credentials, scope, or approval is missing.`

const REVIEWER_TOOL_NAMES = new Set(['read_file', 'list_files', 'grep', 'board_read', 'recall', 'environment'])

const REPAIR_PROMPT = `${DEV_SYSTEM_PROMPT}

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
export function runAutonomousTask(options: AutonomousRunOptions): Promise<AutonomousRunResult> {
  const hooks = activeMode() === 'dev' ? loadDevelopmentToolHooks() : []
  return withToolHooks(hooks, () => runAutonomousTaskInternal(options))
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
  const maxRepairAttempts = options.maxRepairAttempts ?? defaults.maxRepairAttempts
  const maxAmendments = options.maxAmendments ?? defaults.maxAmendments
  const runPolish = options.polish ?? defaults.polish
  const maxPolishPasses = Math.max(0, Math.min(options.maxPolishPasses ?? defaults.maxPolishPasses, 3))
  const captureLearning = options.learn ?? defaults.learn
  const runId = options.runId ?? newRunId()
  clearRunControl(runId)
  const startedAt = Date.now()
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
  const track = (delta: Usage) => {
    usage = addUsage(usage, delta)
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
  const plannerPrompt = profile === 'fast'
    ? `${PLANNER_PROMPT}\n\n## Fast bounded mode\nThis is a time-sensitive task. Prefer 3–6 high-value steps, combine edits that share a coherent UI or subsystem, and keep independent steps in the same wave. Do not create separate steps for trivial assets, documentation, or cosmetic micro-edits. The goal is a complete verified result, not an exhaustive project plan.`
    : PLANNER_PROMPT
  const planningTools = [
    ...allWorkerTools().filter((tool) => ['read_file', 'list_files', 'grep', 'board_read', 'board_post', 'environment'].includes(tool.name)),
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
    if (runSignal?.aborted) return done('aborted')

    journal.append('phase', { phase: 'propose', attempt: amendments })
    const planning = await withAgentIdentity({ name: 'lead', role: 'lead', runId, cwd: process.cwd(), signal: runSignal }, () => withActionGovernor(governor, () => withGoalGraph(graph, () => runAgentLoop({
      messages,
      systemPrompt: plannerPrompt,
      tools: planningTools,
      onText: writeText,
      useAnimation: true,
      verbose: true,
      maxSteps: defaults.plannerSteps,
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
    if (machineReadable) emitEvent('proposal_ready', { proposal })
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
      writeSubStep('Plan rejected — nothing was changed.')
      return done('rejected', { proposal })
    }

    if (amendments >= maxAmendments) {
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

  if (planApproved && proposal) {
    try {
      savePlanArtifact(proposal, runId, process.cwd())
    } catch {
      // The plan already streamed to the terminal and the journal; a failure to
      // also mirror it to .elia/artifacts must not block an approved run.
    }
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
  const briefing = `## The goal of this run\n${proposal.goal}\n\n## What we established while planning\n${proposal.understanding}`
  let totalSavedMs = 0
  const variantCount = options.variants ?? 1

  if (variantCount > 1) {
    writePhase('execute', `${variantCount} parallel implementation attempts`)
    journal.append('phase', { phase: 'execute', variants: variantCount })

    if (runSignal?.aborted) return done('aborted', { proposal })
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
    const { waves } = planWaves(proposal.steps)
    writePhase('execute', `${proposal.steps.length} steps in ${waves.length} wave${waves.length === 1 ? '' : 's'}`)
    journal.append('phase', { phase: 'execute', waves: waves.length })

    for (const [index, wave] of waves.entries()) {
      if (runSignal?.aborted) return done('aborted', { proposal })
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

      const fleet = await runFleet({
        assignments: runnable.map((step) => ({
          id: step.id,
          title: step.title,
          role: step.role,
          instructions: step.instructions,
          acceptanceCriteria: proposal.acceptanceCriteria,
          verificationCommands: proposal.verification,
          sideEffects: proposal.sideEffects,
        })),
        briefing,
        journal,
        runId,
        governor,
        graph,
        signal: runSignal,
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
          error: result.ok ? undefined : result.report,
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
      const completedSteps = graph.state().nodes.filter((node) => node.kind === 'step' && node.status === 'completed').length
      taskSessions.update(parentTask.id, {
        status: 'running',
        action: 'Wave finished',
        detail: `${completedSteps}/${proposal.steps.length} planned step(s) have completed; continuing with remaining work or verification`,
        stepsCompleted: completedSteps,
        progress: proposal.steps.length > 0 ? completedSteps / proposal.steps.length : 0,
      })
    }
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
      if (runSignal?.aborted) return done('aborted', { proposal })
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

  while (true) {
    if (runSignal?.aborted) return done('aborted', { proposal, verdict })

    taskSessions.update(parentTask.id, { status: 'running', action: 'Verifying', detail: proposal.verification.length > 0 ? `Running ${proposal.verification.length} verification command(s)` : 'Running structured review without declared commands' })
    writePhase('verify', proposal.verification.length > 0 ? proposal.verification.join(' · ') : 'review only')
    journal.append('phase', { phase: 'verify', attempt })

    const verification = await runVerification(proposal.verification, undefined, runSignal, governor)
    for (const result of verification.results) {
      const label = `$ ${result.command}`
      if (result.exitCode === 0 && !result.timedOut) writePass(label)
      else writeFail(`${label} — ${result.timedOut ? 'timed out' : `exit ${result.exitCode}`}`)
    }
    verificationPassed = verification.passed
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
      const [diff, status] = await Promise.all([runShell('git diff HEAD', 30_000, undefined, runSignal), runShell('git status --porcelain=v1', 30_000, undefined, runSignal)])
      const diffText = diff.stdout.trim() ? clampOutput(diff.stdout.trim(), 8000) : '(no diff against HEAD — check git status below)'
      const changedFiles = [...diff.stdout.matchAll(/^diff --git a\/(.+) b\/.+$/gm)].map((match) => match[1] ?? '')
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

## What actually changed (git diff HEAD)
${diffText}

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
      verdict = mergeVerdicts(reviewResults.map(({ reviewer, verdict }) => ({ reviewer, verdict })))

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

    if (attempt >= maxRepairAttempts) {
      writeSubStep(`Stopping after ${attempt} repair attempt${attempt === 1 ? '' : 's'} — this needs a human.`)
      const lessons = await captureLessons(goal, proposal, 'unresolved', journal, track, governor, graph, runSignal)
      return done('needs-attention', { proposal, verdict, lessons })
    }

    // --- Reflect & repair ---------------------------------------------------

    attempt += 1
    taskSessions.update(parentTask.id, { status: 'running', action: 'Repairing', detail: `Addressing verification or review failures (attempt ${attempt} of ${maxRepairAttempts})` })
    writePhase('reflect', `attempt ${attempt} of ${maxRepairAttempts}`)
    journal.append('phase', { phase: 'reflect', attempt })

    const problem = verification.passed
      ? `Adversarial review found blocking problems:\n\n${describeIssues(verdict?.issues ?? [])}`
      : `Verification failed:\n\n${describeVerification(verification)}`

    const repairMessages: ConversationMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${briefing}\n\n## What went wrong\n${problem}\n\nFix all of it, then re-run: ${proposal.verification.join(' && ') || '(no verification commands were defined)'}`,
          },
        ],
      },
    ]
    journal.checkpoint(`before-repair-${attempt}`, repairMessages)

    const cache = createToolResultCache()
    const repairTools = [...allWorkerTools(), taskTool]
    const repair = await withAgentIdentity({ name: 'lead', role: 'lead', runId, cwd: process.cwd(), signal: runSignal }, () => withActionGovernor(governor, () => withGoalGraph(graph, () => runAgentLoop({
      messages: repairMessages,
      systemPrompt: REPAIR_PROMPT,
      tools: repairTools,
      onText: writeText,
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
  }

  // --- Learn ---------------------------------------------------------------

  taskSessions.update(parentTask.id, { status: 'running', action: 'Learning', detail: 'Capturing durable lessons for future runs' })
  const lessons = captureLearning ? await captureLessons(goal, proposal, 'succeeded', journal, track, governor, graph, runSignal) : []

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
  signal?: AbortSignal,
): Promise<string[]> {
  writePhase('learn')
  journal.append('phase', { phase: 'learn' })

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
  } else {
    writeSubStep('nothing durable worth keeping from this run')
  }
  return lessons
}

/**
 * The glance a person takes before touching an unfamiliar repo. Gathered up front
 * with real commands so the planner starts from facts instead of spending its
 * first three tool calls asking what kind of project this is.
 */
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
