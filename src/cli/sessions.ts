/**
 * Past work: `runs`, `resume` and `fork`.
 *
 * All three read the session and run ledgers and hand you back into something
 * that already happened, which is why they share a module and their listing
 * and lookup conventions.
 */
import * as readline from 'node:readline/promises'
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { confirmOnce } from '../ui/confirm.ts'
import { table } from '../ui/layout.ts'
import { type ActionApproval } from '../autonomy/governor.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { flagValue, hasFlag, positionals, strictInteger } from './argv.ts'
import { ensureFirstRunProviderSetup } from './providerSetup.ts'
import { actionApprovalPrompt, createInteractiveApprover, loadRuntimeSkills } from './runtime.ts'

export async function runRuns(): Promise<void> {
  const { listRuns } = await import('../autonomy/journal.ts')
  const runId = positionals()[0]

  if (runId) {
    const { renderRunTimeline } = await import('../autonomy/rewind.ts')
    const timeline = renderRunTimeline(runId)
    if (machineReadable) emitEvent('run_timeline', { runId, timeline })
    else process.stdout.write(`${timeline}\n`)
    return
  }

  const runs = listRuns()
  if (runs.length === 0) {
    writeNotice('No autonomous runs in this directory yet. Start one with: elia auto "<goal>"')
    return
  }
  for (const line of table(
    [{ header: 'id' }, { header: 'outcome' }, { header: 'checkpoints', align: 'right' }, { header: 'recovered', align: 'right' }, { header: 'task' }, { header: 'goal' }],
    runs.map((run) => [run.runId, run.outcome, String(run.checkpoints), String(run.recoveredNodes ?? 0), run.taskSessionId ?? '—', run.goal.slice(0, 60)]),
  )) {
    writeUsageLine(`  ${line}`)
  }
  const { renderCalibrationLine } = await import('../autonomy/calibration.ts')
  const calibration = renderCalibrationLine()
  if (calibration && !machineReadable) writeNotice(calibration)
  writeNotice('Inspect one with: elia runs <id>')
}

export async function runResume(): Promise<void> {
  const { runDir, readEvents } = await import('../autonomy/journal.ts')
  const runId = positionals()[0]
  if (!runId) {
    writeError('Usage: elia resume <runId> [--yolo]')
    process.exitCode = 1
    return
  }
  const start = readEvents(runId).find((event) => event.kind === 'run-start')
  const goal = typeof start?.data.goal === 'string' ? start.data.goal : undefined
  if (!goal) {
    writeError(`No durable run found for ${runId}`)
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  const { GoalGraphStore } = await import('../autonomy/goalGraph.ts')
  const graph = GoalGraphStore.open({ runId, goal, dir: runDir(runId) })
  const recovery = graph.leaseRecoverySummary()
  if (recovery.nodes || recovery.actions) writeNotice(`Recovered stale execution leases: ${recovery.nodes} node(s), ${recovery.actions} action(s).`)
  const pending = graph.pendingApprovals()
  if (pending.length > 0 && !process.stdin.isTTY && !hasFlag('--yolo', '-y')) {
    writeError(`Run ${runId} has ${pending.length} pending approval(s); resume from a terminal or pass --yolo to keep them blocked.`)
    process.exitCode = 1
    return
  }

  const rl = process.stdin.isTTY && !hasFlag('--yolo', '-y')
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : undefined
  await loadRuntimeSkills()
  const { runAutonomousTask, autoApprove } = await import('../autonomy/loop.ts')
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  try {
    for (const approval of pending) {
      if (!rl) break
      const result = await confirmOnce(rl, `Resume ${approval.kind} approval ${approval.subject}? [y]es / [n]o: `)
      graph.resolveApproval(approval.id, result.action === 'approve', result.action)
    }

    const approveAction: ActionApproval | undefined = rl
      ? async (assessment, request) => {
          const result = await confirmOnce(rl, actionApprovalPrompt(assessment, request))
          return result.action === 'approve'
        }
      : undefined
    const result = await runAutonomousTask({
      goal,
      runId,
      resumeGraph: true,
      approve: rl ? createInteractiveApprover(rl) : autoApprove,
      approveAction,
      governanceMode: rl ? 'supervised' : 'unattended',
      polish: !hasFlag('--no-polish'),
      signal: controller.signal,
    })
    if (result.outcome !== 'completed') process.exitCode = 1
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}

export async function runFork(): Promise<void> {
  const runId = positionals(['--at', '--with']).at(0)
  const at = strictInteger(flagValue('--at'))
  const instruction = flagValue('--with')

  if (!runId || at === undefined || !instruction) {
    writeError('Usage: elia fork <runId> --at <checkpoint> --with "<what to do differently>"')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { forkRun } = await import('../autonomy/rewind.ts')
  const { autoApprove } = await import('../autonomy/loop.ts')
  const rl = process.stdin.isTTY && !hasFlag('--yolo', '-y')
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : undefined
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())

  try {
    const result = await forkRun({
      runId,
      checkpointId: at,
      instruction,
      approve: rl ? createInteractiveApprover(rl) : autoApprove,
      signal: controller.signal,
    })
    if (!result.ok) {
      writeError(result.error)
      process.exitCode = 1
    }
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}
