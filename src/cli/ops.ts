/**
 * Operating elia as a running system: `schedule`, `daemon` and `doctor`.
 *
 * These three are about the process and its environment — what is scheduled,
 * what is resident, and whether the native and provider pieces are actually
 * wired up — rather than about any one task.
 */
import type { AgentMode } from '../agent.ts'
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { table } from '../ui/layout.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { flagValue, hasFlag, positionals, strictInteger } from './argv.ts'
import { loadRuntimeSkills } from './runtime.ts'

export async function runSchedule(): Promise<void> {
  const { MAX_SCHEDULE_ACTIONS, ScheduleStore, formatScheduleInterval, parseScheduleInterval } = await import('../autonomy/scheduler.ts')
  const action = positionals(['--every', '--title', '--profile', '--mode', '--max-run-ms', '--max-actions'])[0] ?? 'list'
  const store = ScheduleStore.open()

  // A schedules.json shipped inside the project is not something the user
  // approved: nothing in it is listed or run until `elia trust` covers it.
  // `add` is the exception — it writes the person's own file (keeping a copy of the old one).
  if (store.untrusted && action !== 'add') {
    writeError('The schedules in .elia/schedules.json have not been trusted (or the file changed since), so none are loaded. Inspect the file, then run `elia trust` — or `elia schedule add` to start a fresh schedule of your own.')
    process.exitCode = 1
    return
  }

  if (action === 'list') {
    const records = store.list()
    if (records.length === 0) {
      writeNotice('No scheduled goals. Add one with: elia schedule add --every 1h "<goal>"')
      return
    }
    for (const line of table(
      [{ header: 'id' }, { header: 'title' }, { header: 'mode' }, { header: 'status' }, { header: 'every' }, { header: 'actions' }, { header: 'next run' }, { header: 'runs', align: 'right' }, { header: 'last outcome' }, { header: 'goal' }],
      records.map((record) => [record.id, record.title, record.mode, record.status, formatScheduleInterval(record.intervalMs), record.maxActions ? String(record.maxActions) : 'profile default', new Date(record.nextRunAt).toISOString(), String(record.runCount), record.lastOutcome ?? '—', record.goal.slice(0, 60)]),
    )) writeUsageLine(`  ${line}`)
    return
  }

  const id = positionals()[1]
  if (action === 'pause' || action === 'resume' || action === 'remove') {
    if (!id) {
      writeError(`Usage: elia schedule ${action} <id>`)
      process.exitCode = 1
      return
    }
    if (action === 'remove') {
      store.remove(id)
      writeNotice(`Removed scheduled goal ${id}.`)
    } else {
      const record = action === 'pause' ? store.pause(id) : store.resume(id)
      writeNotice(`${action === 'pause' ? 'Paused' : 'Resumed'} ${record.title} (${record.id}).`)
    }
    return
  }

  if (action === 'run') {
    if (!id) {
      writeError('Usage: elia schedule run <id>')
      process.exitCode = 1
      return
    }
    store.resume(id, Date.now())
    await loadRuntimeSkills()
    const { runScheduledDaemon } = await import('../autonomy/daemon.ts')
    await runScheduledDaemon({ once: true })
    return
  }

  if (action !== 'add') {
    writeError(`Unknown schedule action "${action}". Use: add, list, pause, resume, remove, or run.`)
    process.exitCode = 1
    return
  }

  const goal = positionals(['--every', '--title', '--profile', '--mode', '--max-run-ms', '--max-actions']).slice(1).join(' ').trim()
  const every = flagValue('--every')
  if (!goal || !every) {
    writeError('Usage: elia schedule add --every 1h [--mode battmann|datascience|sysintel] [--title "Short title"] [--max-actions N] "<goal>"')
    process.exitCode = 1
    return
  }
  let intervalMs: number
  try {
    intervalMs = parseScheduleInterval(every)
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  const profileValue = flagValue('--profile')
  const profile = profileValue === 'fast' || profileValue === 'thorough' ? profileValue : 'balanced'
  if (profileValue !== undefined && !['fast', 'balanced', 'thorough'].includes(profileValue)) {
    writeError('--profile must be fast, balanced, or thorough')
    process.exitCode = 1
    return
  }
  const modeValue = flagValue('--mode') ?? 'dev'
  if (!['dev', 'cyber', 'sports', 'fitness', 'battmann', 'datascience', 'sysintel'].includes(modeValue)) {
    writeError('--mode must be dev, cyber, sports, fitness, battmann, datascience, or sysintel')
    process.exitCode = 1
    return
  }
  const maxRunMsRaw = flagValue('--max-run-ms')
  const maxRunMs = maxRunMsRaw === undefined ? undefined : strictInteger(maxRunMsRaw)
  if (maxRunMsRaw !== undefined && (maxRunMs === undefined || maxRunMs < 1)) {
    writeError('--max-run-ms must be a positive integer in milliseconds')
    process.exitCode = 1
    return
  }
  const maxActionsRaw = flagValue('--max-actions')
  const maxActions = maxActionsRaw === undefined ? undefined : strictInteger(maxActionsRaw)
  if (maxActionsRaw !== undefined && (maxActions === undefined || maxActions < 1 || maxActions > MAX_SCHEDULE_ACTIONS)) {
    writeError(`--max-actions must be an integer between 1 and ${MAX_SCHEDULE_ACTIONS}`)
    process.exitCode = 1
    return
  }
  const title = flagValue('--title') || goal.slice(0, 80)
  const record = store.create({ title, goal, intervalMs, profile, mode: modeValue as AgentMode, maxRunMs, maxActions })
  writeNotice(`Scheduled ${record.title} every ${formatScheduleInterval(record.intervalMs)}. id=${record.id}`)
  writeNotice('Run it with: elia daemon --once')
}

export async function runDaemon(): Promise<void> {
  const pollMsRaw = flagValue('--poll-ms')
  const pollMs = pollMsRaw === undefined ? undefined : strictInteger(pollMsRaw)
  if (pollMsRaw !== undefined && (pollMs === undefined || pollMs < 1_000)) {
    writeError('--poll-ms must be an integer of at least 1000 milliseconds')
    process.exitCode = 1
    return
  }
  await loadRuntimeSkills()
  const { runScheduledDaemon } = await import('../autonomy/daemon.ts')
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  try {
    if (!hasFlag('--once')) writeNotice(`Background daemon active; polling every ${(pollMs ?? 30_000) / 1000}s. Ctrl+C stops it.`)
    await runScheduledDaemon({ pollMs, once: hasFlag('--once'), signal: controller.signal })
  } finally {
    unregisterShutdown()
  }
}

/**
 * `elia doctor` — one screen answering "is the native stack actually working?".
 * Prints the daemon mode, the resolved `eliad` binary and whether it runs, live
 * socket reachability, the Java bridge jar + `java` on PATH, and the reason the
 * last structural pre-flight (if any) did nothing.
 */
export async function runDoctor(): Promise<void> {
  // `elia doctor --repair [signature]` hands a recorded bug in elia's own source
  // to a repair run on a branch of its own (recovery/selfRepair.ts).
  if (hasFlag('--repair')) return runSelfRepairCommand()
  const { daemonMode, resolveEliadPath, resolveJvmBridgeJar, daemonClient, DaemonUnavailable, socketPath } = await import('../daemon/client.ts')
  const { lastPreflightSkipReason, lastStructuralBackend } = await import('../native/parseCheck.ts')
  const { nativeAvailable, nativeUnavailableReason, nativeLibPath, nativeVersion } = await import('../native/ffi.ts')
  const lines: string[] = []
  const mode = daemonMode()
  lines.push(`ELIA_DAEMON        ${mode}${mode === 'off' ? '  (warm shell pool + Java pre-flight need auto; the structural pre-flight does not)' : ''}`)

  if (nativeAvailable()) {
    lines.push(`elia-native        in-process · ${nativeLibPath()}`)
    lines.push(`                   v${nativeVersion() ?? '?'} · structural pre-flight runs without the daemon`)
  } else {
    lines.push(`elia-native        not loaded — ${nativeUnavailableReason() ?? 'unknown'}`)
    lines.push('                   build: cargo build -p elia-native --release')
  }
  lines.push(`last structural    ${lastStructuralBackend()}`)

  const eliad = resolveEliadPath()
  if (eliad) {
    const profile = /[\\/]release[\\/]/.test(eliad) ? 'release' : /[\\/]debug[\\/]/.test(eliad) ? 'debug' : 'published'
    let version = 'did not run'
    try {
      const probe = Bun.spawnSync([eliad, '--version'])
      if (probe.exitCode === 0) version = new TextDecoder().decode(probe.stdout).trim()
    } catch {
      // reported as "did not run"
    }
    lines.push(`eliad binary       ${eliad}`)
    lines.push(`                   profile ${profile} · ${version}`)
  } else {
    lines.push('eliad binary       not found (build: cargo build --release -p eliad, or install @elia/native)')
  }

  lines.push(`socket             ${socketPath()}`)
  if (mode !== 'off') {
    try {
      const info = await daemonClient().info()
      lines.push(`daemon             reachable · protocol ${info.protocol}`)
    } catch (err) {
      lines.push(`daemon             not reachable · ${err instanceof DaemonUnavailable ? err.message : String(err)}`)
    }
  }

  const jar = resolveJvmBridgeJar()
  lines.push(`jvm bridge jar     ${jar ?? 'not found (build: jvm/elia-jvm-bridge → elia-jvm-bridge.jar)'}`)
  lines.push(`java on PATH        ${Bun.which('java') ?? 'no (Java pre-flight for .java edits will be skipped)'}`)

  const skip = lastPreflightSkipReason()
  if (skip) lines.push(`last pre-flight     skipped — ${skip}`)

  // What broke in elia itself: crashes, bugs a turn surfaced, sessions and runs
  // that died, and the errors it degraded around — read back, not just written.
  const { gatherSelfCheck, renderSelfCheck } = await import('../recovery/selfRepair.ts')
  lines.push(...renderSelfCheck(gatherSelfCheck()).split('\n'))

  if (machineReadable) emitEvent('doctor', { report: lines.join('\n') })
  else process.stdout.write(`${lines.join('\n')}\n`)
}

async function runSelfRepairCommand(): Promise<void> {
  const { groupFaults, readFaults } = await import('../recovery/faults.ts')
  const { repairBrief, runSelfRepair, selfRepairTarget } = await import('../recovery/selfRepair.ts')
  const groups = groupFaults(readFaults())
  const wanted = positionals()[0]
  if (groups.length === 0) {
    writeNotice('No errors in elia\'s own code are recorded here, so there is nothing to repair. elia doctor shows what is recorded.')
    return
  }
  const group = wanted ? groups.find((candidate) => candidate.signature.startsWith(wanted)) : groups[0]
  if (!group) {
    writeError(`No recorded bug matches ${wanted}. Recorded: ${groups.map((candidate) => candidate.signature).join(', ')}`)
    process.exitCode = 1
    return
  }
  if (hasFlag('--brief')) {
    writeUsageLine(repairBrief(group))
    return
  }
  const result = runSelfRepair(group, selfRepairTarget(group.signature))
  if (result.status === 'ran' || result.status === 'already-attempted' || result.status === 'not-a-checkout') writeNotice(result.message)
  else writeError(result.message)
  if (result.status === 'worktree-failed' || (result.status === 'ran' && result.exitCode !== 0)) process.exitCode = 1
}
