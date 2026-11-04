/**
 * Past work: `sessions`, `runs`, `resume` and `fork`.
 *
 * All of these read the session and run ledgers and hand you back into
 * something that already happened, which is why they share a module and their
 * listing and lookup conventions.
 *
 * Two different things are called "resume" here, and they stay distinct:
 * `elia resume <runId>` continues an autonomous *run* from its goal graph,
 * while `elia --resume <sessionId>` reopens a *conversation*. The run keeps the
 * subcommand because it restarts work on its own; the conversation is a flag
 * because it only decides which history the session you are about to start
 * begins from.
 */
import * as readline from 'node:readline/promises'
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { confirmOnce } from '../ui/confirm.ts'
import { table } from '../ui/layout.ts'
import { type ActionApproval } from '../autonomy/governor.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { flagValue, hasFlag, args, positionals, strictInteger } from './argv.ts'
import { ensureFirstRunProviderSetup } from './providerSetup.ts'
import { actionApprovalPrompt, createInteractiveApprover, loadRuntimeSkills } from './runtime.ts'

/**
 * `elia sessions` — the conversations saved in this directory, newest first,
 * each with the prompt that started it so you can tell them apart, and marked
 * when another elia still has it open.
 */
export async function runSessionsList(): Promise<void> {
  const nested = positionals(['--name', '--limit', '--payload', '--from', '--session'])[0]
  if (nested && ['new', 'list', 'attach', 'kill', 'prune', 'sync', 'drop', 'subscribe', 'status'].includes(nested)) {
    const { runParallelSessions } = await import('./parallelSessions.ts')
    await runParallelSessions(args)
    return
  }
  const { DEFAULT_CATALOG_LIMIT, describeSession, listSessionSummaries, relativeTime } = await import('../sessionCatalog.ts')
  const limit = hasFlag('--all') ? 0 : strictInteger(flagValue('--limit')) ?? DEFAULT_CATALOG_LIMIT
  const sessions = await listSessionSummaries({ limit })

  if (machineReadable) {
    emitEvent('sessions', { sessions })
    return
  }
  if (sessions.length === 0) {
    writeNotice('No saved conversations in this directory yet. Start one with: elia')
    return
  }

  // Four columns, not six: the table shrinks every column proportionally to fit
  // the terminal, and the whole point of this listing is an id you can copy —
  // one that wrapped across two lines would defeat it. Model and live detail
  // are in `elia --resume`'s picker, where there is room for them.
  for (const line of table(
    [{ header: 'id' }, { header: 'when' }, { header: 'turns', align: 'right' }, { header: 'started with' }],
    sessions.map((session) => [
      session.id,
      session.heldByLiveProcess ? 'open now' : relativeTime(session.updatedAt),
      String(session.turns),
      describeSession(session, 40),
    ]),
  )) {
    writeUsageLine(`  ${line}`)
  }
  writeNotice('Reopen one with: elia --resume <id> · or pick from the list with: elia --resume · continue the newest with: elia -c')
}

/** What `--resume`/`--continue` settled on, and whether something else is already in there. */
export interface ResumeTarget {
  id: string
  /** Another live elia has this conversation open; writing to it from here would overwrite its turns. */
  heldByPid?: number
}

/**
 * Turns `--resume [id]` into a session to open.
 *
 * With an id (or an unambiguous prefix of one) it resolves that; with nothing
 * it offers the list, because the ids are timestamp-random and nobody types
 * one from memory. Where no picker can be drawn — a pipe, `--plain`, a script
 * — it prints the candidates and fails rather than silently starting a fresh
 * session the caller did not ask for.
 *
 * Runs before any provider is initialized: choosing which history to open has
 * nothing to do with having an API key.
 */
export async function chooseSessionToResume(query: string | undefined): Promise<ResumeTarget | undefined> {
  const { DEFAULT_CATALOG_LIMIT, describeSession, listSessionIds, listSessionSummaries, resolveSessionId, sessionDetail, sessionHolder } =
    await import('../sessionCatalog.ts')
  const asked = query?.trim() ?? ''

  if (asked) {
    const lookup = resolveSessionId(asked, listSessionIds())
    if (lookup.kind === 'found') return { id: lookup.id, heldByPid: sessionHolder(lookup.id)?.pid }
    if (lookup.kind === 'ambiguous') {
      writeError(`"${asked}" matches ${lookup.ids.length} sessions: ${lookup.ids.slice(0, 6).join(', ')}${lookup.ids.length > 6 ? ', …' : ''}. Use more of the id.`)
      return undefined
    }
    writeError(`No saved conversation with id "${asked}" in this directory. See them with: elia sessions`)
    return undefined
  }

  const sessions = await listSessionSummaries({ limit: DEFAULT_CATALOG_LIMIT })
  if (sessions.length === 0) {
    writeError('--resume requires a session id, and this directory has no saved conversations yet.')
    return undefined
  }

  const { pick } = await import('../ui/picker.ts')
  const chosen = await pick(
    'Resume a conversation',
    sessions.map((session) => ({ label: describeSession(session, 64), detail: sessionDetail(session), value: session.id })),
    0,
    { searchable: true },
  )

  if (chosen.type === 'select') return { id: chosen.value, heldByPid: sessionHolder(chosen.value)?.pid }
  if (chosen.type === 'cancel') {
    writeNotice('Cancelled.')
    return undefined
  }

  // No terminal to draw a picker in. Say what is available so the caller can
  // name one, and keep the message the scripted form has always failed with.
  writeError('--resume requires a session id here (no interactive terminal to choose from). Recent sessions:')
  for (const session of sessions.slice(0, 10)) {
    writeError(`  ${session.id}  ${sessionDetail(session)}  ${describeSession(session, 48)}`)
  }
  return undefined
}

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
  const { renderGroundTruthLines } = await import('../autonomy/groundTruth.ts')
  if (!machineReadable) for (const line of renderGroundTruthLines()) writeNotice(line)
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
  if (graph.openTornSnapshot) writeNotice(`Run ${runId}'s goal graph was unreadable, so completed steps are not remembered and the run starts over from its goal. The old file is kept at ${graph.openTornSnapshot.path}.`)
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
