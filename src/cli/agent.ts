/**
 * The two non-interactive ways to give elia a task: `agent` for a single
 * request, `auto` for a full autonomous run.
 *
 * They are the same job at two levels of ceremony — one turn versus a governed
 * multi-wave pipeline — so they share the argument handling that decides mode,
 * profile and approval posture.
 */
import * as readline from 'node:readline/promises'
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { ZERO_USAGE, recordTopLevelTurn, formatUsageLine } from '../usage.ts'
import { confirmOnce } from '../ui/confirm.ts'
import { MAX_GOVERNED_ACTIONS, type ActionApproval } from '../autonomy/governor.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { flagValue, hasFlag, positionals, strictInteger } from './argv.ts'
import { ensureFirstRunProviderSetup } from './providerSetup.ts'
import { actionApprovalPrompt, createInteractiveApprover, loadRuntimeSkills, requestedAgentMode } from './runtime.ts'

export async function runAgentCommand(): Promise<void> {
  const request = positionals(['--beta']).join(' ').trim()
  if (!request) {
    writeError('Give elia a request: elia agent "write 3 instagram captions for our new product"')
    process.exitCode = 1
    return
  }

  const dryRun = hasFlag('--dry-run')
  const startedAt = Date.now()
  if (dryRun) {
    const { deterministicRoute } = await import('../agents/router.ts')
    const route = deterministicRoute(request)
    const elapsedMs = Date.now() - startedAt
    recordTopLevelTurn(elapsedMs)
    writeUsageLine(`routing plan: ${route.personas.join(' -> ')}${route.rationale ? ` — ${route.rationale}` : ''}`)
    writeNotice('Dry run complete: no specialist tools or side effects were executed.')
    writeUsageLine(formatUsageLine(ZERO_USAGE, elapsedMs, 'dry-run'))
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { runAgentRequest } = await import('../agents/orchestrator.ts')
  const { config } = await import('../config.ts')
  const result = await runAgentRequest(request)
  const elapsedMs = Date.now() - startedAt
  recordTopLevelTurn(elapsedMs)

  writeUsageLine(`agent(s): ${result.personas.join(' -> ')}${result.rationale ? ` — ${result.rationale}` : ''}`)
  writeUsageLine(formatUsageLine(result.usage, elapsedMs, config.model))
}

export async function runAuto(): Promise<void> {
  const goal = positionals(['--variants', '--run-id', '--max-run-ms', '--max-actions', '--beta', '--authorize']).join(' ').trim()
  if (!goal) {
    writeError('Give elia a goal: elia auto "add rate limiting to the API client"')
    process.exitCode = 1
    return
  }

  const profile = hasFlag('--fast') ? 'fast' : hasFlag('--thorough') ? 'thorough' : 'balanced'
  const resumeGraph = hasFlag('--resume')
  const resumeRunId = flagValue('--run-id')
  if (resumeGraph && !resumeRunId) {
    writeError('--resume requires --run-id <run-id> so Elia can locate the durable goal graph')
    process.exitCode = 1
    return
  }
  if (resumeGraph) writeNotice(`resuming durable run: ${resumeRunId}`)
  const maxActionsRaw = flagValue('--max-actions')
  const maxActions = maxActionsRaw === undefined ? undefined : strictInteger(maxActionsRaw)
  if (maxActionsRaw !== undefined && (maxActions === undefined || maxActions < 1 || maxActions > MAX_GOVERNED_ACTIONS)) {
    writeError(`--max-actions must be a positive integer between 1 and ${MAX_GOVERNED_ACTIONS}, got "${maxActionsRaw}"`)
    process.exitCode = 1
    return
  }
  if (maxActions !== undefined) writeNotice(`action budget: ${maxActions} governed tool requests`)
  const maxRunMsRaw = flagValue('--max-run-ms')
  const maxRunMs = maxRunMsRaw === undefined ? undefined : strictInteger(maxRunMsRaw)
  if (maxRunMsRaw !== undefined && (maxRunMs === undefined || maxRunMs < 1)) {
    writeError(`--max-run-ms must be a positive integer in milliseconds, got "${maxRunMsRaw}"`)
    process.exitCode = 1
    return
  }
  if (maxRunMs !== undefined) writeNotice(`wall-clock budget: ${(maxRunMs / 1000).toFixed(1)}s`)
  if (profile !== 'balanced') writeNotice(`autonomy profile: ${profile}`)

  const variantsRaw = flagValue('--variants')
  const variants = variantsRaw === undefined ? undefined : strictInteger(variantsRaw)
  if (variantsRaw !== undefined && (variants === undefined || variants < 1)) {
    writeError(`--variants must be a positive integer, got "${variantsRaw}"`)
    process.exitCode = 1
    return
  }
  if (variants && variants > 1) {
    writeNotice(
      `--variants ${variants}: running ${variants} independent implementation attempts in isolated git worktrees, keeping the one that verifies best.`,
    )
  }

  const supervisionEnv = process.env.ELIA_SUPERVISION?.trim().toLowerCase()
  if (supervisionEnv !== undefined && supervisionEnv !== 'supervised' && supervisionEnv !== 'unattended') {
    writeError('ELIA_SUPERVISION must be either supervised or unattended')
    process.exitCode = 1
    return
  }
  const unattendedFlag = hasFlag('--yolo', '-y', '--autonomous', '--self-supervise', '--unattended')
  const supervisedFlag = hasFlag('--supervised') || supervisionEnv === 'supervised'
  if (supervisedFlag && (unattendedFlag || supervisionEnv === 'unattended')) {
    writeError('Supervision conflict: choose --supervised/ELIA_SUPERVISION=supervised or an unattended flag, not both')
    process.exitCode = 1
    return
  }
  // Unattended is the default: elia plans and does the work without waiting
  // for a plan approval. --supervised (or ELIA_SUPERVISION=supervised) puts
  // the plan in front of you first. The unattended flags stay accepted.
  const yolo = !supervisedFlag
  writeNotice(
    `supervision: ${
      yolo
        ? process.stdin.isTTY
          ? 'unattended (a critical action asks once, then runs freely for the rest of the run)'
          : 'unattended with no terminal (critical actions are refused)'
        : 'supervised (approval required for review and critical actions)'
    }`,
  )
  const authorizeRaw = flagValue('--authorize')
  if (authorizeRaw !== undefined && !yolo) {
    writeError('--authorize only applies to an unattended run (--unattended/--yolo) — supervised mode already asks per action.')
    process.exitCode = 1
    return
  }
  if (authorizeRaw) {
    const intents = [...new Set(authorizeRaw.split(',').map((s) => s.trim()).filter(Boolean))]
    if (intents.length === 0) {
      writeError('--authorize needs at least one intent, e.g. --authorize deployment.production,github.pr_merge')
      process.exitCode = 1
      return
    }
    const { currentBranch, grantPreauth } = await import('../autonomy/preauth.ts')
    const branch = await currentBranch(process.cwd())
    const granted = grantPreauth(intents, process.cwd(), branch)
    if (granted.length > 0) {
      writeNotice(
        `pre-authorized for this run only, on branch "${branch}": ${granted.map((g) => g.intent).join(', ')} — expires ${new Date(granted[0]!.expiresAt).toLocaleTimeString()}`,
      )
    }
    const rejected = intents.filter((intent) => !granted.some((g) => g.intent === intent))
    if (rejected.length > 0) {
      writeError(`--authorize ignored invalid intent(s) (expected lowercase dotted names like "deployment.production"): ${rejected.join(', ')}`)
    }
  }

  let approveAction: ActionApproval | undefined
  if (!yolo && !process.stdin.isTTY) {
    writeError('elia auto --supervised needs a terminal to approve the plan. Drop --supervised to run it unattended.')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { runAutonomousTask, autoApprove } = await import('../autonomy/loop.ts')
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  let rl: readline.Interface | undefined
  try {
    if (yolo) {
      // Unattended means "stop asking me about routine work", not "refuse
      // anything risky and spend the run failing on it". With a terminal
      // present, a critical action gets exactly one question — and the answer
      // then covers every action of that kind for the rest of the run. With no
      // terminal (CI, the scheduler daemon) there is nobody to ask, so the
      // governor refuses as before.
      if (process.stdin.isTTY) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const unattendedRl = rl
        approveAction = async (assessment, request) => {
          const label = `${actionApprovalPrompt(assessment, request)}\n  Answering here settles every "${assessment.intent}" action for the rest of this run.`
          const result = await confirmOnce(unattendedRl, label)
          return result.action === 'approve'
        }
      }
      const result = await runAutonomousTask({ goal, approve: autoApprove, mode: requestedAgentMode(), variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'unattended', approveAction, signal: controller.signal, maxWallClockMs: maxRunMs, maxActions })
      if (result.outcome !== 'completed') process.exitCode = 1
      return
    }

    const interactiveRl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl = interactiveRl
    approveAction = async (assessment, request) => {
      const label = actionApprovalPrompt(assessment, request)
      const result = await confirmOnce(interactiveRl, label)
      return result.action === 'approve'
    }
    const result = await runAutonomousTask({ goal, approve: createInteractiveApprover(interactiveRl), mode: requestedAgentMode(), variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'supervised', approveAction, signal: controller.signal, maxWallClockMs: maxRunMs, maxActions })
    if (result.outcome !== 'completed' && result.outcome !== 'rejected') process.exitCode = 1
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}
