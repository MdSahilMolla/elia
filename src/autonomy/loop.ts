import { SYSTEM_PROMPT, config, tierConfig } from '../config.ts'
import { runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { taskTool } from '../tools/task.ts'
import { allWorkerTools } from '../tools/registry.ts'
import { runSubAgent } from '../subagent.ts'
import { runShell } from '../shell.ts'
import { ZERO_USAGE, addUsage, formatElapsed, recordUsage } from '../usage.ts'
import type { Usage } from '../providers/types.ts'
import { writeText } from '../ui/stream.ts'
import { writeBlock, writeFail, writePass, writePhase, writeSubStep, writeSummary } from '../ui/report.ts'
import { createToolResultCache } from '../speculation/cache.ts'
import { createPrefetcher } from '../speculation/prefetch.ts'
import { createBlackboard, setActiveBlackboard } from './blackboard.ts'
import { createJournal, newRunId, type Journal } from './journal.ts'
import { planWaves, runFleet } from './fleet.ts'
import { createProposalTool, renderProposal } from './proposal.ts'
import { appendLessons, createLessonsTool, renderLessons } from './lessons.ts'
import {
  createVerdictTool,
  describeIssues,
  describeVerification,
  hasBlockingIssues,
  requireCriticVerdict,
  runVerification,
} from './verify.ts'
import type { CriticVerdict, Proposal } from './types.ts'

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
  /** Resume from a checkpoint's message history instead of orienting from scratch. */
  resumeMessages?: ConversationMessage[]
  runId?: string
  signal?: AbortSignal
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
}

const PLANNER_PROMPT = `${SYSTEM_PROMPT}

## Right now you are planning, not building

You are in the orient-and-propose phase of an autonomous run. You must NOT change anything yet — you have no write tools in this phase, by design.

Work like an engineer picking up an unfamiliar ticket:
1. Look at the shape of the project before forming any opinion.
2. Send several scouts out in parallel (call \`task\` with role "scout" multiple times in one turn) to answer the specific questions you need answered. Scouts are fast and cheap; serial investigation is the single biggest waste of wall-clock time available to you, so batch it.
3. Read the handful of files that actually decide the design yourself.
4. Then call \`submit_proposal\` exactly once and stop.

Do not write the plan out in prose first. The proposal is rendered for the user from the tool call itself, so narrating it beforehand just shows them the same plan twice. Investigate, then submit.

What makes a good proposal:
- \`understanding\` names real files, real symbols, real patterns you verified. Not "the codebase appears to use X" — say which file proves it.
- Steps are decomposed for parallelism. Two steps touching disjoint files with no ordering requirement must NOT depend on each other; each unnecessary dependency costs the user wall-clock time.
- Every step's instructions stand alone. The worker executing it sees your instructions and nothing else — not this conversation, not the other steps.
- \`verification\` is real commands from this project that will actually fail if the work is wrong. Look them up in package.json or the docs; do not invent them.
- Assumptions are where you guessed. The user correcting a wrong assumption now costs seconds; discovering it after the work costs the whole run.`

const REPAIR_PROMPT = `${SYSTEM_PROMPT}

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
export async function runAutonomousTask(options: AutonomousRunOptions): Promise<AutonomousRunResult> {
  const { goal, approve, signal } = options
  const maxRepairAttempts = options.maxRepairAttempts ?? 2
  const maxAmendments = options.maxAmendments ?? 3
  const runId = options.runId ?? newRunId()
  const startedAt = Date.now()

  const journal = createJournal(runId, goal)
  const board = createBlackboard(`${journal.dir}/board.json`)
  setActiveBlackboard(board)

  let usage = ZERO_USAGE
  const track = (delta: Usage) => {
    usage = addUsage(usage, delta)
  }

  const done = (
    outcome: RunOutcome,
    extra: Partial<AutonomousRunResult> = {},
  ): AutonomousRunResult => {
    journal.append('run-end', { outcome })
    return {
      runId,
      outcome,
      usage,
      elapsedMs: Date.now() - startedAt,
      lessons: [],
      ...extra,
    }
  }

  // --- Orient & propose -----------------------------------------------------

  writePhase('orient', `run ${runId}`)
  const snapshot = await projectSnapshot()

  const proposalCapture = createProposalTool()
  const planningTools = [
    ...allWorkerTools().filter((tool) => ['read_file', 'list_files', 'grep', 'board_read', 'board_post'].includes(tool.name)),
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

  let proposal: Proposal | undefined
  let amendments = 0

  while (true) {
    if (signal?.aborted) return done('aborted')

    journal.append('phase', { phase: 'propose', attempt: amendments })
    const planning = await runAgentLoop({
      messages,
      systemPrompt: PLANNER_PROMPT,
      tools: planningTools,
      onText: writeText,
      useAnimation: true,
      verbose: true,
      maxSteps: 40,
      signal,
    })
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
    process.stdout.write(renderProposal(proposal))
    journal.checkpoint('after-propose', messages)

    const decision = await approve(proposal)
    journal.append('approval', { action: decision.action })

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

  // --- Execute --------------------------------------------------------------

  const { waves } = planWaves(proposal.steps)
  writePhase('execute', `${proposal.steps.length} steps in ${waves.length} wave${waves.length === 1 ? '' : 's'}`)
  journal.append('phase', { phase: 'execute', waves: waves.length })

  const briefing = `## The goal of this run\n${proposal.goal}\n\n## What we established while planning\n${proposal.understanding}`
  let totalSavedMs = 0

  for (const [index, wave] of waves.entries()) {
    if (signal?.aborted) return done('aborted', { proposal })
    if (waves.length > 1) writeSubStep(`wave ${index + 1} of ${waves.length}`)

    const fleet = await runFleet({
      assignments: wave.map((step) => ({
        id: step.id,
        title: step.title,
        role: step.role,
        instructions: step.instructions,
      })),
      briefing,
      journal,
      signal,
    })
    track(fleet.usage)
    totalSavedMs += fleet.savedMs

    // Each worker's report goes onto the board, so the next wave inherits what
    // this one learned instead of re-deriving it.
    for (const result of fleet.results) {
      board.post(result.name, `step:${result.id}`, `${result.title} — ${result.report}`)
    }
  }

  // --- Verify ---------------------------------------------------------------

  let verdict: CriticVerdict | undefined
  let attempt = 0

  while (true) {
    if (signal?.aborted) return done('aborted', { proposal, verdict })

    writePhase('verify', proposal.verification.length > 0 ? proposal.verification.join(' · ') : 'review only')
    journal.append('phase', { phase: 'verify', attempt })

    const verification = await runVerification(proposal.verification)
    for (const result of verification.results) {
      const label = `$ ${result.command}`
      if (result.exitCode === 0 && !result.timedOut) writePass(label)
      else writeFail(`${label} — ${result.timedOut ? 'timed out' : `exit ${result.exitCode}`}`)
    }
    journal.append('verify', {
      passed: verification.passed,
      results: verification.results.map((result) => ({ command: result.command, exitCode: result.exitCode })),
    })

    // Only spend a critic on a change that already builds. Reviewing code that
    // doesn't compile just rediscovers the compiler's own error, slowly.
    if (verification.passed) {
      writeSubStep('running adversarial review')
      const verdictCapture = createVerdictTool()
      const critic = await runSubAgent({
        role: 'critic',
        name: 'critic#1',
        briefing,
        extraTools: [verdictCapture.tool],
        signal,
        prompt: `Review the work that was just done against what was promised.

## What was promised
${proposal.goal}

Steps that were executed:
${proposal.steps.map((step) => `- ${step.id} (${step.role}): ${step.title} — files: ${step.files.join(', ') || 'unspecified'}`).join('\n')}

## Risks flagged during planning
${proposal.risks.length > 0 ? proposal.risks.map((risk) => `- ${risk}`).join('\n') : '(none flagged)'}

Start with \`git diff\` and \`git status\` to see what actually changed, then read the changed files in full. Check specifically whether each promised step was really done, not just claimed. Finish by calling submit_verdict.`,
      })
      track(critic.usage)
      const submittedVerdict = verdictCapture.taken()
      verdict = requireCriticVerdict(submittedVerdict)

      if (!submittedVerdict) {
        // Prose cannot drive a safety gate. Preserve it for diagnosis, then send
        // the structured fail-closed verdict through the normal repair path.
        writeBlock('Review (unstructured)', critic.report)
      }

      journal.append('verdict', { ...verdict })
      if (!hasBlockingIssues(verdict)) {
        writePass(verdict.summary)
        if (verdict.issues.length > 0) writeBlock('Minor notes', describeIssues(verdict.issues))
        break
      }
      writeFail(verdict.summary)
      writeBlock('Issues found', describeIssues(verdict.issues))
    }

    if (attempt >= maxRepairAttempts) {
      writeSubStep(`Stopping after ${attempt} repair attempt${attempt === 1 ? '' : 's'} — this needs a human.`)
      const lessons = await captureLessons(goal, proposal, 'unresolved', journal, track)
      return done('needs-attention', { proposal, verdict, lessons })
    }

    // --- Reflect & repair ---------------------------------------------------

    attempt += 1
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
    const repair = await runAgentLoop({
      messages: repairMessages,
      systemPrompt: REPAIR_PROMPT,
      tools: repairTools,
      onText: writeText,
      useAnimation: true,
      verbose: true,
      maxSteps: 50,
      cache,
      prefetcher: createPrefetcher({ tools: repairTools, cache }),
      signal,
    })
    track(repair.usage)
    recordUsage(repair.usage)
  }

  // --- Learn ---------------------------------------------------------------

  const lessons = await captureLessons(goal, proposal, 'succeeded', journal, track)

  writeSummary('Run complete', [
    ['run', runId],
    ['goal', proposal.goal],
    ['workers', String(proposal.steps.length)],
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
): Promise<string[]> {
  writePhase('learn')
  journal.append('phase', { phase: 'learn' })

  const capture = createLessonsTool()

  try {
    const result = await runSubAgent({
      role: 'scout',
      name: 'scribe#lessons',
      extraTools: [capture.tool],
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
async function projectSnapshot(): Promise<string> {
  const [tree, status, branch] = await Promise.all([
    runShell(process.platform === 'win32' ? 'dir /b' : 'ls -1', 10_000),
    runShell('git status --porcelain=v1 --branch', 10_000),
    runShell('git log --oneline -5', 10_000),
  ])

  const sections = [
    `Top level:\n${tree.stdout.trim() || '(empty)'}`,
    status.exitCode === 0 ? `Git status:\n${status.stdout.trim() || '(clean)'}` : 'Not a git repository.',
    branch.exitCode === 0 && branch.stdout.trim() ? `Recent commits:\n${branch.stdout.trim()}` : '',
  ]
  return sections.filter(Boolean).join('\n\n')
}
