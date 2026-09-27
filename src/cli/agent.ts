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
import { actionApprovalPrompt, loadRuntimeSkills, requestedAgentMode } from './runtime.ts'

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

  // elia auto is always autonomous: the plan runs as soon as it is made, and
  // only actions that cannot be undone or that reach outside this machine are
  // gated. The supervision switches that used to choose otherwise are gone.
  if (hasFlag('--supervised') || process.env.ELIA_SUPERVISION?.trim()) {
    writeNotice('elia is always autonomous now: --supervised and ELIA_SUPERVISION no longer exist and are ignored.')
  }
  writeNotice(
    process.stdin.isTTY
      ? 'autonomous: the plan runs as soon as it is made; an irreversible or outside-world action asks once, then that kind runs freely for the rest of the run'
      : 'autonomous, no terminal: irreversible or outside-world actions are skipped and reported, never waited on',
  )
  const authorizeRaw = flagValue('--authorize')
  if (authorizeRaw) {
    // "intent" grants a time-windowed intent as before; "intent:N" caps it at
    // N uses regardless of remaining time — "intent:1" is a true one-shot.
    const entries = [...new Set(authorizeRaw.split(',').map((s) => s.trim()).filter(Boolean))]
    const parsed = entries.map((entry) => {
      const [intent, usesRaw] = entry.split(':', 2)
      const maxUses = usesRaw !== undefined && /^[1-9]\d*$/.test(usesRaw) ? Number(usesRaw) : undefined
      return { intent: intent ?? '', maxUses, valid: usesRaw === undefined || maxUses !== undefined }
    })
    if (parsed.length === 0) {
      writeError('--authorize needs at least one intent, e.g. --authorize deployment.production,github.pr_merge:1')
      process.exitCode = 1
      return
    }
    const { currentBranch, grantPreauth } = await import('../autonomy/preauth.ts')
    const branch = await currentBranch(process.cwd())
    const granted: Awaited<ReturnType<typeof grantPreauth>> = []
    for (const entry of parsed) {
      if (!entry.valid) continue
      granted.push(...grantPreauth([entry.intent], process.cwd(), branch, undefined, entry.maxUses))
    }
    if (granted.length > 0) {
      writeNotice(
        `pre-authorized for this run only, on branch "${branch}": ${granted.map((g) => (g.maxUses ? `${g.intent} (${g.maxUses} use${g.maxUses === 1 ? '' : 's'})` : g.intent)).join(', ')} — expires ${new Date(granted[0]!.expiresAt).toLocaleTimeString()}`,
      )
    }
    const rejected = parsed.filter((entry) => !entry.valid || !granted.some((g) => g.intent === entry.intent)).map((entry) => entry.intent)
    if (rejected.length > 0) {
      writeError(`--authorize ignored invalid intent(s) (expected lowercase dotted names like "deployment.production", optionally suffixed ":N" for a use cap): ${rejected.join(', ')}`)
    }
  }

  let approveAction: ActionApproval | undefined

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { runAutonomousTask, autoApprove } = await import('../autonomy/loop.ts')
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  let rl: readline.Interface | undefined
  try {
    // Nobody is asked about routine work. With a terminal present, an action
    // that cannot be undone gets exactly one question — and the answer covers
    // every action of that kind for the rest of the run. With no terminal (CI,
    // the scheduler daemon) there is nobody to ask, so the governor skips it.
    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const terminal = rl
      approveAction = async (assessment, request) => {
        const label = `${actionApprovalPrompt(assessment, request)}\n  Answering here settles every "${assessment.intent}" action for the rest of this run.`
        const result = await confirmOnce(terminal, label)
        return result.action === 'approve'
      }
    }
    const result = await runAutonomousTask({ goal, approve: autoApprove, mode: requestedAgentMode(), variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'unattended', approveAction, signal: controller.signal, maxWallClockMs: maxRunMs, maxActions })
    if (result.outcome !== 'completed') process.exitCode = 1
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}
