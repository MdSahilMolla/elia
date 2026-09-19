#!/usr/bin/env bun
import * as readline from 'node:readline/promises'
import type { AgentMode } from './agent.ts'
import { writeNotice, writeError, writeUsageLine } from './ui/stream.ts'

import { ZERO_USAGE, recordTopLevelTurn, formatUsageLine } from './usage.ts'
import { confirmOnce } from './ui/confirm.ts'
import { dim } from './ui/theme.ts'
import { table } from './ui/layout.ts'
import { updateTerminalTaskTitle } from './ui/taskDashboard.ts'
import { taskSessions } from './taskSessions.ts'
import { MAX_GOVERNED_ACTIONS, type ActionApproval } from './autonomy/governor.ts'
import { emitEvent, machineReadable, plainOutput } from './ui/runtime.ts'
import { installShutdownHandlers, registerShutdownCleanup } from './ui/shutdown.ts'
import { redactText } from './ui/redact.ts'
import { loadUserConfig, userConfigPath, writeUserConfig } from './userConfig.ts'
import { removeProviderConfiguration } from './providerSettings.ts'
import { args, flagValue, hasFlag, positionals, rawArgs, strictInteger, subcommand } from './cli/argv.ts'
import { printHelp } from './cli/help.ts'
import { ensureFirstRunProviderSetup, readSecretInput, readStdinText, runCodexLogin } from './cli/providerSetup.ts'
import { actionApprovalPrompt, createInteractiveApprover, loadRuntimeSkills, requestedAgentMode } from './cli/runtime.ts'
import { runInteractive } from './cli/interactive.ts'

// These three run before anything else in the process: they are the only flags
// that must work when no provider is configured and no session exists. They
// live here rather than beside printHelp because `--help` exiting the process
// is a dispatcher decision, not a property of the help text — and because
// `new URL('../package.json', import.meta.url)` below is resolved relative to
// this file, so moving it one directory deeper silently reads a path that does
// not exist.
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  printHelp()
  process.exit(0)
}

if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  const pkg = JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text())
  console.log(pkg.version)
  process.exit(0)
}

// `--profile-turns` is a session-wide diagnostic: every model round-trip records
// its cache-read/write split and time-to-first-token, and a table prints at the
// end. Distinct from `elia auto --profile <fast|balanced|thorough>`, which
// selects a run profile. `ELIA_PROFILE=1` in the environment does the same.
if (hasFlag('--profile-turns')) process.env.ELIA_PROFILE = '1'

async function runAgentCommand(): Promise<void> {
  const request = positionals(['--beta']).join(' ').trim()
  if (!request) {
    writeError('Give elia a request: elia agent "write 3 instagram captions for our new product"')
    process.exitCode = 1
    return
  }

  const dryRun = hasFlag('--dry-run')
  const startedAt = Date.now()
  if (dryRun) {
    const { deterministicRoute } = await import('./agents/router.ts')
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
  const { runAgentRequest } = await import('./agents/orchestrator.ts')
  const { config } = await import('./config.ts')
  const result = await runAgentRequest(request)
  const elapsedMs = Date.now() - startedAt
  recordTopLevelTurn(elapsedMs)

  writeUsageLine(`agent(s): ${result.personas.join(' -> ')}${result.rationale ? ` — ${result.rationale}` : ''}`)
  writeUsageLine(formatUsageLine(result.usage, elapsedMs, config.model))
}

async function runAuto(): Promise<void> {
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
  const yolo = !supervisedFlag && (unattendedFlag || supervisionEnv === 'unattended' || process.env.ELIA_AUTO_APPROVE === '1')
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
    const { currentBranch, grantPreauth } = await import('./autonomy/preauth.ts')
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
    writeError('elia auto needs a terminal to approve the plan. Re-run with --unattended to skip routine approval.')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { runAutonomousTask, autoApprove } = await import('./autonomy/loop.ts')
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

/**
 * Rebuilds the history-derived task set from this repository's own git log.
 *
 * Runs no model and needs no API key: it only checks out past trees and runs
 * their tests, twice per candidate, to prove each task fails before the real
 * commit and passes after it.
 */
async function runBenchHarvest(): Promise<void> {
  const { harvest, writeTasksFile, TASKS_FILE } = await import('./evolve/history/harvest.ts')

  const scan = strictInteger(flagValue('--scan') ?? '200') ?? 200
  const limit = strictInteger(flagValue('--limit') ?? '12') ?? 12

  writeNotice(
    `Harvesting benchmark tasks from the last ${scan} commits. Each candidate is checked out and its tests run twice — this makes no model calls.`,
  )
  const result = await harvest({ scan, limit, onProgress: (message) => writeUsageLine(message) })

  if (result.tasks.length === 0) {
    writeNotice(`No task could be validated out of ${result.considered} candidates; leaving the existing set alone.`)
    process.exitCode = 1
    return
  }

  writeTasksFile(result.tasks)
  writeNotice(
    `Wrote ${result.tasks.length} validated tasks to ${TASKS_FILE} (${result.rejected.length} of ${result.considered} candidates could not be proven).`,
  )
}

/**
 * `elia bench swe --file <tasks.json> [--sample N] [--out <results.json>]`
 *
 * Runs a SWE-bench-Verified-shaped task file end to end (checkout, patch,
 * real agent run, real test execution, score) — see bench/swe/harness.ts.
 * elia does not fetch or bundle the real SWE-bench dataset itself (its size
 * and distribution terms are the operator's call); point --file at a real
 * export to run it for real. Each instance runs a real, billed agent loop,
 * so --sample defaults to a small number rather than the whole file.
 */
async function runBenchSwe(): Promise<void> {
  const filePath = flagValue('--file')
  if (!filePath) {
    writeError('elia bench swe --file <tasks.json> — a SWE-bench-Verified-shaped task file (see src/bench/swe/types.ts for the schema)')
    process.exitCode = 1
    return
  }
  const { readFileSync, existsSync, mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  if (!existsSync(filePath)) {
    writeError(`No such file: ${filePath}`)
    process.exitCode = 1
    return
  }
  let instances: import('./bench/swe/types.ts').SweBenchInstance[]
  try {
    instances = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!Array.isArray(instances)) throw new Error('expected a JSON array of instances')
  } catch (err) {
    writeError(`Could not read ${filePath} as a SWE-bench task list: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }

  const sampleRaw = flagValue('--sample')
  const sample = sampleRaw === undefined ? 3 : strictInteger(sampleRaw)
  if (sample === undefined || sample < 1) {
    writeError(`--sample must be a positive integer, got "${sampleRaw}"`)
    process.exitCode = 1
    return
  }
  const selected = instances.slice(0, sample)
  if (selected.length === 0) {
    writeNotice(`${filePath} has no task instances.`)
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  writeNotice(
    `Running ${selected.length} of ${instances.length} SWE-bench instance(s) from ${filePath} — each runs a real, billed agent loop against a real checkout. This is a sample run, not a full published score.`,
  )

  const { runSweBenchSuite } = await import('./bench/swe/harness.ts')
  const summary = await runSweBenchSuite(selected, {
    onInstanceDone: (result) => {
      writeUsageLine(`  ${result.resolved ? '✓' : '✗'} ${result.instance_id}${result.agentError ? ` — ${result.agentError}` : ''}${result.keptDir ? ` (kept: ${result.keptDir})` : ''}`)
    },
  })

  writeNotice(`Resolved ${summary.resolved}/${summary.total}.`)
  const outPath = flagValue('--out')
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`)
    writeNotice(`Wrote results to ${outPath}`)
  }
  if (summary.resolved < summary.total) process.exitCode = 1
}

async function runBench(): Promise<void> {
  if (positionals(['--file', '--sample', '--out', '--split'])[0] === 'swe') return runBenchSwe()
  if (hasFlag('--harvest')) return runBenchHarvest()

  const { BENCH_TASKS, allBenchTasks } = await import('./evolve/suite.ts')
  const { historyTasks } = await import('./evolve/history/suite.ts')

  // Synthetic tasks stay the default: they are seconds each, and they are the
  // set the evolution loop has always compared candidates on. The history tasks
  // are real checkouts of this repository and cost minutes, so they are asked
  // for explicitly.
  const wholeSet = hasFlag('--all') ? allBenchTasks() : hasFlag('--history') ? historyTasks() : BENCH_TASKS
  // --split: score one side of the held-out line on its own (see split.ts).
  // The evolution loop hides the held-out half's failures from the proposer, so
  // scoring it alone is how you see what it is hiding — and scoring the shown
  // half alone is the number the proposer is briefed on.
  const { splitTasks, renderSplit } = await import('./evolve/split.ts')
  const half = (flagValue('--split') ?? '').toLowerCase()
  const split = splitTasks(wholeSet)
  if (half && !['train', 'shown', 'heldout', 'held-out', 'unseen', 'all'].includes(half)) {
    writeError(`elia bench --split <shown|held-out|all> — "${half}" is not one of those`)
    process.exitCode = 1
    return
  }
  const shownHalf = half === 'train' || half === 'shown'
  const heldOutHalf = half === 'heldout' || half === 'held-out' || half === 'unseen'
  const tasks = shownHalf ? split.train : heldOutHalf ? split.heldOut : wholeSet
  if (shownHalf || heldOutHalf) writeNotice(renderSplit(split))
  // --lessons: every task gets this project's lessons, as a real turn would
  // (history tasks only those older than their commit — see benchLessons.ts).
  // Compare against a run without it to learn whether the store helps.
  const withLessons = hasFlag('--lessons')
  if (withLessons) {
    const { BENCH_LESSONS_ENV } = await import('./evolve/benchLessons.ts')
    const { paths } = await import('./statePaths.ts')
    process.env[BENCH_LESSONS_ENV] = paths.lessons
  }
  if (tasks.length === 0) {
    writeNotice('No tasks to run. `elia bench --harvest` builds the history-derived set.')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { measureFitness, renderScorecard } = await import('./evolve/fitness.ts')
  const { ELIA_ROOT } = await import('./config.ts')

  writeNotice(`Scoring the current elia against ${tasks.length} benchmark tasks — this runs real agent loops.`)
  const card = await measureFitness({
    tasks,
    sourceRoot: ELIA_ROOT,
    onTaskDone: (outcome) =>
      writeUsageLine(`  ${outcome.passed ? '✓' : '✗'} ${outcome.taskId} — ${outcome.error ?? outcome.detail}`),
  })
  const { recordBenchRun } = await import('./compounding/status.ts')
  // The half is part of the set's name. A held-out-only run scores a different
  // corpus, and recording it as a full run would move the headroom number in
  // `elia compounding` on evidence that is not about the same tasks.
  const setName = hasFlag('--all') ? 'all' : hasFlag('--history') ? 'history' : 'synthetic'
  const halfName = shownHalf ? '/shown' : heldOutHalf ? '/held-out' : ''
  recordBenchRun(card, `${setName}${halfName}${withLessons ? '+lessons' : ''}`)
  if (machineReadable) emitEvent('benchmark_scorecard', { stage: 'current', scorecard: card })
  else {
    process.stdout.write(renderScorecard(card, 'elia'))
    const { readLedger, renderLearningLine } = await import('./evolve/ledger.ts')
    if (readLedger().length > 0) writeUsageLine(`  ${renderLearningLine()}`)
  }
  if (card.passRate < 1) process.exitCode = 1
}

async function runBenchLatency(): Promise<void> {
  // A bare `elia bench-latency --startup-probe` exists only so the harness can
  // time process load + exit from the outside; do nothing and return.
  if (hasFlag('--startup-probe') || process.env.ELIA_STARTUP_PROBE === '1') return

  const { runLatencyHarness } = await import('./bench/latency/harness.ts')
  const { renderLatencyReport, compareLatency } = await import('./bench/latency/report.ts')
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { ELIA_ROOT } = await import('./config.ts')

  const baselinePath = join(ELIA_ROOT, 'src', 'bench', 'latency', 'baseline.json')
  const update = hasFlag('--update-baseline')
  const strict = hasFlag('--strict')
  const realistic = hasFlag('--realistic')
  const live = hasFlag('--live')
  const runs = strictInteger(flagValue('--runs') ?? (live ? '1' : '3')) ?? (live ? 1 : 3)
  const only = flagValue('--only')?.split(',').map((id) => id.trim()).filter(Boolean)
  const skipColdStart = hasFlag('--skip-cold-start')

  if (live && !(await ensureFirstRunProviderSetup())) return

  writeNotice(
    live
      ? "Running the latency scenarios against the real configured model — this makes real API calls."
      : `Measuring elia's own loop, startup, and speculation overhead — deterministic scripted model${realistic ? ' with realistic pacing' : ''}, no API key needed.`,
  )
  const report = await runLatencyHarness({
    runsPerScenario: runs,
    only,
    live,
    skipColdStart: skipColdStart || live,
    pacing: realistic ? { ttftMs: 400, tokenMs: 8 } : { ttftMs: 0, tokenMs: 0 },
    onScenarioDone: (result) =>
      writeUsageLine(
        live
          ? `  ${result.id} — ${result.roundTrips} trips, ${result.cachedToolCalls}/${result.toolCalls} reads pre-run, ${result.outputTokensMedian} out tok, ${result.tokensPerSecMedian} tok/s, ${result.wallMsMedian}ms`
          : `  ${result.structuralOk ? '✓' : '✗'} ${result.id} — ${result.roundTrips} trips, ${result.cachedToolCalls}/${result.toolCalls} reads pre-run, ${result.wallMsMedian}ms wall`,
      ),
  })

  const baseline = !live && existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as import('./bench/latency/harness.ts').LatencyReport) : undefined

  if (machineReadable) {
    emitEvent('latency_report', { report, comparison: baseline ? compareLatency(baseline, report, { strict }) : undefined })
  } else {
    process.stdout.write(renderLatencyReport(report, baseline))
  }

  if (live) return

  if (update) {
    writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`)
    writeNotice(`Baseline updated: ${baselinePath}`)
    return
  }

  if (baseline) {
    const comparison = compareLatency(baseline, report, { strict })
    if (!comparison.ok) {
      writeError(`Latency regressed:\n${comparison.regressions.map((line) => `  - ${line}`).join('\n')}`)
      process.exitCode = 1
    }
  } else {
    writeNotice('No baseline yet — run `elia bench-latency --update-baseline` to record one.')
  }
}

/**
 * `elia compounding` — where the self-improvement loop stands, stage by stage,
 * from elia's own records.
 *
 * The six stages measure the slow loop: evolve changing elia's source between
 * generations. The reasoning library underneath them measures the fast one —
 * what each turn's search learned about how to attack work of that shape — so
 * both channels are read off the same command rather than one of them being
 * invisible until someone goes looking for a JSON file.
 */
async function runCompounding(): Promise<void> {
  const { compoundingStatus, renderCompoundingStatus } = await import('./compounding/status.ts')
  const { evidenceVelocity, renderVelocity } = await import('./compounding/velocity.ts')
  const { readLedger } = await import('./evolve/ledger.ts')
  const { readLibrary, renderLibrary } = await import('./reason/library.ts')
  const { coverageOf, recentCoverage, renderCoverage } = await import('./reason/coverage.ts')
  const { loadAllOutcomes } = await import('./autonomy/outcomes.ts')
  const { readBenchRuns } = await import('./compounding/status.ts')
  const { inferTasks, isAssumed, renderGatePower } = await import('./evolve/power.ts')
  const { benchRepeats } = await import('./evolve/fitness.ts')
  const stages = compoundingStatus()
  const library = readLibrary()
  // Every record, not the last 200: one of these two lines is labelled "lifetime".
  const outcomes = loadAllOutcomes()
  const coverage = { lifetime: coverageOf(outcomes), recent: recentCoverage(outcomes) }
  // What a verdict costs, and whether that is falling: the loop can only compound
  // as fast as it can afford to decide. See compounding/velocity.ts.
  const velocity = evidenceVelocity(readLedger())
  // Stage 3 reports that nothing was promoted. This says whether the gate could
  // have seen a win if one had been proposed, which is the other half of that.
  const lastBench = [...readBenchRuns()].reverse().find((run) => run.set === 'all')
  const gatePower = lastBench ? renderGatePower(inferTasks(lastBench), benchRepeats(), 1, isAssumed(lastBench)) : undefined
  if (machineReadable) emitEvent('compounding_status', { stages, reasoning: library.records, coverage, velocity })
  else {
    writeUsageLine(
      [renderCompoundingStatus(stages), renderVelocity(velocity), renderCoverage(coverage.lifetime, coverage.recent), gatePower, renderLibrary(library)]
        .filter(Boolean)
        .join('\n\n'),
    )
  }
}

/**
 * `elia jev` — how Jev, the optional System One judge, is scoring against elia's
 * own decisions. `elia jev ping` checks the key; `elia jev bench` scores it on
 * the planted-defect corpus, where the right answers are known.
 */
async function runJev(): Promise<void> {
  const { jevEnabled, askJev } = await import('./providers/jev.ts')
  const { readLedger, summarize, renderSummary } = await import('./reason/systemOne.ts')
  const action = positionals()[0] ?? 'status'
  if (action !== 'status' && !jevEnabled()) {
    writeNotice('Jev is off — set ELIA_JEV_API_KEY (in your environment or .env) to enable it.')
    process.exitCode = 1
    return
  }
  if (action === 'ping') {
    const result = await askJev({ observation: 'The sky is blue on a clear day.' }, { outcome: { type: 'noul', instructions: 'The observation is true.' } }, { timeoutMs: 10_000 })
    if (result?.ok) writeUsageLine(`✓ Jev answered in ${result.latencyMs}ms: ${JSON.stringify(result.answers)}`)
    else {
      writeUsageLine(`✗ Jev did not answer: ${result?.error ?? 'not configured'}`)
      process.exitCode = 1
    }
    return
  }
  if (action === 'bench') {
    const { runSystemOneBench } = await import('./reason/systemOneBench.ts')
    const rows = await runSystemOneBench({
      onRow: (row) => {
        const r = row.result
        const expected = row.variant === 'clean'
        const mark = r?.ok === undefined ? '!' : r.ok === expected ? '✓' : '✗'
        const said = r?.ok === undefined ? 'no answer' : `${r.ok ? 'correct' : 'defect'} (${Math.round((r.confidence ?? 0) * 100)}%)`
        writeUsageLine(`  ${mark} ${row.defectId} · ${row.variant.padEnd(9)} → ${said}`)
      },
    })
    const answered = rows.filter((row) => row.result?.ok !== undefined)
    const right = answered.filter((row) => row.result!.ok === (row.variant === 'clean')).length
    writeUsageLine(`\n${right}/${answered.length} right${rows.length > answered.length ? `, ${rows.length - answered.length} unanswered` : ''}`)
  } else if (action !== 'status') {
    writeNotice('Usage: elia jev [status|ping|bench]')
    process.exitCode = 1
    return
  }
  const summaries = summarize(readLedger())
  if (machineReadable) emitEvent('jev_status', { enabled: jevEnabled(), summaries })
  else writeUsageLine(`\n${renderSummary(summaries)}`)
}

async function runEvolve(): Promise<void> {
  const generationsRaw = flagValue('--generations', '-n') ?? '1'
  const generations = strictInteger(generationsRaw)
  if (generations === undefined || generations < 1) {
    writeError('--generations must be a positive integer.')
    process.exitCode = 1
    return
  }

  // `elia evolve --explain` — print the real-world evidence the proposer will
  // be shown, and stop. Before the provider check on purpose: it costs no model
  // call and writes nothing, so it works when `evolve` itself cannot run at all.
  // That matters more than it sounds. With no provider credit the baseline
  // measurement leaves every task unmeasured and `evolve()` returns before a
  // single line of the brief is built, so `--dry-run` can never show this. And
  // "nobody could see what the proposer sees" is the root cause of the loop
  // having run twice and promoted nothing.
  if (hasFlag('--explain')) {
    const { fieldEvidenceSection } = await import('./evolve/fieldEvidence.ts')
    const section = fieldEvidenceSection().trim()
    writeUsageLine(section || 'No field evidence yet — this project has no audited tool calls on record.')
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { evolve } = await import('./evolve/engine.ts')
  // --focus N: score on the built-in tasks, the last full run's failures, and N
  // of its passing history tasks — a fraction of the full set's cost, and
  // still the same fixed set for the baseline and every candidate.
  let taskIds: string[] | undefined
  const focusRaw = flagValue('--focus')
  if (focusRaw !== undefined) {
    const focus = strictInteger(focusRaw)
    if (focus === undefined || focus < 0) {
      writeError('--focus must be a non-negative integer (how many passing history tasks to keep as regression guards).')
      process.exitCode = 1
      return
    }
    const { BENCH_TASKS } = await import('./evolve/suite.ts')
    const { focusTaskIds } = await import('./compounding/status.ts')
    taskIds = focusTaskIds(BENCH_TASKS.map((task) => task.id), focus)
    if (!taskIds) {
      writeError('--focus needs a complete `elia bench --all` run to focus from (none recorded with every task measured).')
      process.exitCode = 1
      return
    }
    writeNotice(`Focused on ${taskIds.length} task(s): the built-in set, the last full run's failures, and ${focus} passing history task(s).`)
  }
  const result = await evolve({ generations, dryRun: hasFlag('--dry-run'), taskIds })
  if (result.stoppedReason) {
    writeError(`No generation was attempted: ${result.stoppedReason}`)
    process.exitCode = 1
    return
  }
  const promoted = result.generations.filter((record) => record.verdict === 'promoted')

  writeNotice(
    `${promoted.length} of ${result.generations.length} generation(s) promoted · pass rate ${Math.round(result.baseline.passRate * 100)}% → ${Math.round(result.final.passRate * 100)}%`,
  )
  for (const record of result.generations) {
    writeUsageLine(`  gen ${record.generation}: ${record.verdict} — ${record.hypothesis || record.reason}`)
  }
  const { renderLearningLine } = await import('./evolve/ledger.ts')
  writeUsageLine(`  ${renderLearningLine()}`)
}

async function runValues(): Promise<void> {
  const { loadValueCore, describeValueCore } = await import('./values/core.ts')
  const action = positionals()[0] ?? 'show'

  if (action === 'show') {
    const core = loadValueCore()
    writeNotice(describeValueCore())
    if (core.path) writeNotice(core.path)
    writeUsageLine('')
    for (const line of core.text.split('\n')) writeUsageLine(`  ${line}`)
    return
  }

  if (action === 'probe' || action === 'probes') {
    if (!(await ensureFirstRunProviderSetup())) return
    await loadRuntimeSkills()
    const { runValueProbes } = await import('./values/probes.ts')
    const { recordProbeRun, readLatestProbeRun, checkValueDrift } = await import('./values/drift.ts')
    const previous = readLatestProbeRun()
    writeNotice('Running value probes (subject + independent judge per probe)…')
    const run = await runValueProbes({
      forceCoreActive: hasFlag('--force-core'),
      onResult: (result) => writeUsageLine(`  ${result.errored ? '!' : result.passed ? '✓' : '✗'} ${result.id} — ${result.reason}`),
    })
    writeUsageLine('')
    // Unscoreable probes are reported separately, never folded into the rate —
    // a provider outage is not evidence about whether elia holds a value.
    const scoredProbes = run.results.filter((r) => !r.errored)
    const erroredProbes = run.results.filter((r) => r.errored)
    writeNotice(`Value-probe pass rate: ${Math.round(run.passRate * 100)}% (${scoredProbes.filter((r) => r.passed).length}/${scoredProbes.length})`)
    if (erroredProbes.length > 0) {
      writeNotice(`${erroredProbes.length} probe(s) could not be scored and were excluded: ${erroredProbes.map((r) => r.id).join(', ')}`)
    }
    if (!hasFlag('--no-record')) recordProbeRun(run, hasFlag('--force-core') ? 'draft-review' : 'baseline')
    if (previous && hasFlag('--check')) {
      const drift = checkValueDrift(previous, run)
      if (!drift.ok) {
        writeError(`Value drift:\n${drift.regressions.map((r) => `  - ${r}`).join('\n')}`)
        process.exitCode = 1
      } else {
        writeNotice('No value drift vs the previous run.')
      }
    }
    return
  }

  writeError(`Unknown: elia values ${action}. Use "show" or "probe".`)
  process.exitCode = 1
}

async function runDistill(): Promise<void> {
  const { collectDistillableTraces } = await import('./distill/corpus.ts')
  const { fragmentCount } = await import('./distill/fragments.ts')
  const action = positionals()[0] ?? 'run'
  const traces = collectDistillableTraces()

  if (action === 'traces') {
    if (traces.length === 0) {
      writeNotice('No distillable traces yet — need autonomous runs that reached verified completion with mechanical/empirical verification.')
      return
    }
    writeNotice(`${traces.length} distillable trace(s):`)
    for (const t of traces) {
      writeUsageLine(`  ${t.runId}  ${t.regime.padEnd(10)} reward ${t.reward === undefined ? '—' : t.reward.toFixed(2)}  ${t.goal.slice(0, 80)}`)
    }
    return
  }

  if (action === 'export') {
    // The weights half of the loop: a training set from verified work, and how
    // far it is from being worth training on. Local only; nothing is uploaded.
    const { allTrajectoryRows, defaultExportPath, readiness, renderReadiness, selectTrainingExamples, writeTrainingExport } = await import('./distill/export.ts')
    const rows = allTrajectoryRows()
    const selection = selectTrainingExamples(rows)
    writeNotice(renderReadiness(readiness(selection.examples, rows)))
    writeUsageLine(`  ${selection.examples.length} of ${selection.considered} recorded turn(s)/run(s) qualify. Why the rest do not:`)
    for (const [reason, count] of [...selection.rejectedBy.entries()].sort((x, y) => y[1] - x[1])) {
      writeUsageLine(`    ${String(count).padStart(3)}×  ${reason}`)
    }
    if (hasFlag('--dry-run')) return
    const out = flagValue('--out') ?? defaultExportPath()
    writeTrainingExport(selection.examples, out)
    writeNotice(`Wrote ${selection.examples.length} example(s) to ${out}`)
    return
  }

  if (action !== 'run') {
    writeError(`Unknown: elia distill ${action}. Use "run" (add --promote to apply), "traces", or "export" (--out <file>, --dry-run).`)
    process.exitCode = 1
    return
  }

  if (traces.length < 3) {
    writeNotice(`Only ${traces.length} distillable trace(s) — need at least 3 of the same role's work before a pattern is worth distilling. Nothing to do.`)
    // Say *why* the supply is short. "Not enough traces" reads the same whether
    // autonomous runs keep failing or the runId/corr join has broken, and those
    // call for opposite fixes.
    const { diagnoseTraceSupply } = await import('./distill/corpus.ts')
    const supply = diagnoseTraceSupply()
    if (supply.length > 0) {
      const reasons = new Map<string, number>()
      for (const row of supply) for (const reason of row.rejectedBy) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      writeUsageLine('')
      writeUsageLine(`  ${supply.filter((r) => r.accepted).length} of ${supply.length} run receipt(s) qualify. Why the rest do not:`)
      for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
        writeUsageLine(`    ${String(count).padStart(3)}×  ${reason}`)
      }
      writeUsageLine('')
      writeUsageLine('  Loop 2 compounds verified success, so it only moves when autonomous runs actually land.')
    }
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { proposeDistillations } = await import('./distill/mine.ts')
  const { evaluateCandidate } = await import('./distill/gate.ts')

  const promote = hasFlag('--promote')
  writeNotice(`Mining ${traces.length} verified trace(s) for standing role guidance…`)
  const candidates = await proposeDistillations(traces)
  if (candidates.length === 0) {
    writeNotice('No candidate fragments — the successful runs show no repeated pattern the role instructions are missing.')
    return
  }

  for (const candidate of candidates) {
    writeUsageLine('')
    writeNotice(`Candidate for ${candidate.role}: "${candidate.fragment}"`)
    writeUsageLine(`  rationale: ${candidate.rationale}`)
    const result = await evaluateCandidate(candidate, { dryRun: !promote, onStage: (s) => writeUsageLine(`  … ${s}`) })
    const mark = result.verdict === 'rejected' ? '✗' : '✓'
    writeUsageLine(`  ${mark} ${result.verdict}: ${result.reason}`)
  }
  if (!promote) writeNotice('Dry run — nothing was applied. Re-run with --promote to keep the fragments that passed every gate.')
  writeNotice(`${fragmentCount()} distilled fragment(s) currently active.`)
}

async function runGap(): Promise<void> {
  const { computeGapVector } = await import('./gap/scoreboard.ts')
  const { checkGapNotRegressed } = await import('./gap/guard.ts')
  const { recordGapVector, readGapHistory, readLatestGapVector, renderGapVector } = await import('./gap/report.ts')

  const action = positionals()[0]
  if (action === 'history') {
    const history = readGapHistory()
    if (history.length === 0) {
      writeNotice('No generator–verifier gap history yet. Run "elia gap" to measure it.')
      return
    }
    for (const vector of history) {
      writeUsageLine(
        `  ${vector.at.slice(0, 19).replace('T', ' ')} · ${vector.ref.padEnd(12)} catch ${Math.round(vector.mechanicalCatchRate * 100)}% · fp ${Math.round(vector.falsePositiveRate * 100)}% · escapees ${vector.escapees.length}`,
      )
    }
    return
  }

  const previous = readLatestGapVector()
  // The critic rung costs model calls, so it is opt-in for a manual run — but it
  // is the only rung a prompt change can move, so the distillation gate always
  // turns it on. A baseline recorded without it cannot be compared against one
  // recorded with it; `elia gap --critic` is what produces a gate-usable vector.
  const withCritic = hasFlag('--critic')
  // Only the critic rung needs a provider; a plain run stays free and offline.
  if (withCritic && !(await ensureFirstRunProviderSetup())) return
  writeNotice(
    withCritic
      ? 'Measuring the verification ladder against the planted-defect corpus, including the adversarial critic…'
      : 'Measuring the verification ladder against the planted-defect corpus…',
  )
  const vector = await computeGapVector({
    critic: withCritic,
    onDefect: (result) => {
      const mark = result.regime === 'judgment' ? (result.caught ? '✓(bonus)' : '·') : result.caught ? '✓' : '✗'
      writeUsageLine(`  ${mark} ${result.defectId}${result.caught ? ` — caught by ${result.caughtBy.join(', ')}` : ''}${result.skipped.length ? ` [skipped: ${result.skipped.join(', ')}]` : ''}`)
    },
    onCriticVerdict: (verdict) => {
      const mark = verdict.errored ? '!' : verdict.caughtDefective ? '✓' : '✗'
      writeUsageLine(`  ${mark} critic · ${verdict.defectId} — ${verdict.note}${verdict.flaggedClean ? ' (also flagged the clean control)' : ''}`)
    },
  })

  writeUsageLine('')
  for (const line of renderGapVector(vector, previous).split('\n')) writeUsageLine(line)
  writeUsageLine('')

  if (!hasFlag('--no-record')) {
    recordGapVector(vector)
    writeNotice('Recorded to .elia/gap/history.ndjson')
  }

  if (hasFlag('--check')) {
    if (!previous) {
      writeNotice('No prior vector to check against — recorded this one as the baseline.')
      return
    }
    const guard = checkGapNotRegressed(previous, vector)
    if (!guard.ok) {
      writeError(`Gap regressed vs ${previous.ref}:\n${guard.regressions.map((r) => `  - ${r}`).join('\n')}`)
      process.exitCode = 1
      return
    }
    writeNotice(`Gap held or improved vs ${previous.ref}.`)
  }
}

async function runSkills(): Promise<void> {
  const { listSkillFiles } = await import('./skills/loader.ts')
  const { tryListSkillBundles } = await import('./skills/bundles.ts')
  const { skillCandidates } = await import('./skills/detector.ts')
  const { PROJECT_SKILLS_DIR, USER_SKILLS_DIR, SKILL_SUFFIX, SKILL_BUNDLES_FILE } = await import('./skills/paths.ts')
  const action = positionals()[0] ?? 'list'

  if (action === 'path' || action === 'folder' || action === 'folders') {
    writeNotice(`Project skills: ${PROJECT_SKILLS_DIR}`)
    writeNotice(`User skills:    ${USER_SKILLS_DIR}`)
    writeNotice(`File contract:  create a self-contained ${SKILL_SUFFIX} module exporting a default Tool with name, description, input_schema, and execute(input).`)
    writeNotice(`Bundle file:    ${SKILL_BUNDLES_FILE}`)
    writeNotice('Skills are validated at startup; invalid modules are moved to the quarantine folder instead of stopping Elia.')
    return
  }

  if (action === 'list') {
    const files = listSkillFiles()
    if (files.length === 0) {
      writeNotice('No synthesized skills yet. Run "elia skills candidates" to see what elia keeps doing by hand.')
      return
    }
    for (const line of table([{ header: 'source' }, { header: 'file' }], files.map(({ source, file }) => [source, file]))) {
      writeUsageLine(`  ${line}`)
    }
    return
  }

  if (action === 'bundles') {
    const { bundles, error } = tryListSkillBundles()
    if (error) {
      writeNotice(`Could not read skill bundles: ${error}`)
      return
    }
    if (bundles.length === 0) {
      writeNotice(`No skill bundles configured. Create ${SKILL_BUNDLES_FILE} with a JSON object mapping bundle names to { skills: [...] }.`)
      return
    }
    for (const bundle of bundles) {
      const detail = bundle.description ? ` — ${bundle.description}` : ''
      writeUsageLine(`  ${bundle.name}: ${bundle.skills.join(', ')}${detail}`)
    }
    return
  }

  if (action === 'candidates') {
    const candidates = skillCandidates()
    if (candidates.length === 0) {
      writeNotice('Nothing has repeated often enough yet. Keep using elia — it is counting.')
      return
    }
    const rows = table(
      [{ header: 'seen', align: 'right' }, { header: 'kind' }, { header: 'pattern' }],
      candidates.map((c) => [`${c.count}×`, c.kind, c.pattern]),
    )
    const [header, separator, ...dataRows] = rows
    writeUsageLine(`  ${header}`)
    writeUsageLine(`  ${separator}`)
    candidates.forEach((candidate, i) => {
      writeUsageLine(`  ${dataRows[i]}`)
      for (const example of candidate.examples) writeUsageLine(`         ${dim('e.g.')} ${example}`)
    })
    writeNotice('Turn the strongest one into a real tool with: elia skills synth')
    return
  }

  if (action === 'synth') {
    const { synthesizeSkill } = await import('./skills/synthesize.ts')
    const candidate = skillCandidates()[0]
    if (!candidate) {
      writeNotice('No candidate has crossed the threshold yet.')
      return
    }

    writeNotice(`Writing a tool for "${candidate.pattern}" (seen ${candidate.count}×)…`)
    const result = await synthesizeSkill(candidate)
    if (result.ok) writeNotice(`✓ ${result.detail}`)
    else {
      writeError(`✗ ${result.detail}`)
      process.exitCode = 1
    }
    return
  }

  if (action === 'trust' || action === 'untrust') {
    const { trustProjectSkills, untrustProjectSkills } = await import('./skills/trust.ts')
    if (action === 'trust') {
      trustProjectSkills(PROJECT_SKILLS_DIR)
      writeNotice(`✓ Project skills in ${PROJECT_SKILLS_DIR} are now trusted and will be loaded on the next start.`)
    } else {
      untrustProjectSkills(PROJECT_SKILLS_DIR)
      writeNotice(`✓ Project skills in ${PROJECT_SKILLS_DIR} are no longer trusted.`)
    }
    return
  }

  if (action === 'status') {
    const { isProjectSkillsTrusted } = await import('./skills/trust.ts')
    const trusted = isProjectSkillsTrusted(PROJECT_SKILLS_DIR)
    const files = listSkillFiles().filter((f) => f.source === 'project')
    writeNotice(`Project skills directory: ${PROJECT_SKILLS_DIR}`)
    writeNotice(`Trusted: ${trusted ? 'yes' : 'no'}`)
    writeNotice(`Files found: ${files.length}`)
    if (!trusted && files.length > 0) {
      writeNotice('These files were found but are not loaded. Inspect them, then run `elia skills trust` to enable them.')
    }
    return
  }

  writeError(`Unknown skills action "${action}". Use: list, bundles, path, candidates, synth, trust, untrust, or status.`)
  process.exitCode = 1
}

async function runControl(): Promise<void> {
  const { listRuns, readEvents } = await import('./autonomy/journal.ts')
  const { readRunControl, requestRunControl, runControlPath } = await import('./autonomy/control.ts')
  const values = positionals()
  const action = values[0] ?? 'status'
  const runId = values[1]

  if (action === 'status') {
    const runs = listRuns(20)
    if (runs.length === 0) {
      writeNotice('No autonomous runs found in this project.')
      return
    }
    for (const run of runs) {
      const ended = readEvents(run.runId).some((event) => event.kind === 'run-end')
      const request = readRunControl(run.runId)
      const state = ended ? `finished:${run.outcome}` : request ? `control-requested:${request.action}` : 'active-or-interrupted'
      writeUsageLine(`${run.runId} · ${state} · ${redactText(run.goal, 120)}`)
    }
    return
  }

  if (action !== 'pause' && action !== 'stop') {
    writeError('Usage: elia control status | elia control pause <run-id> | elia control stop <run-id>')
    process.exitCode = 1
    return
  }
  if (!runId) {
    writeError(`control ${action} requires <run-id>`)
    process.exitCode = 1
    return
  }
  try {
    runControlPath(runId)
    if (readEvents(runId).some((event) => event.kind === 'run-end')) {
      writeError(`Run ${runId} has already finished; inspect its receipt before resuming or forking it.`)
      process.exitCode = 1
      return
    }
    if (!requestRunControl(runId, action)) {
      writeError(`No durable run found for ${runId}`)
      process.exitCode = 1
      return
    }
  } catch {
    writeError(`Invalid run id: ${runId}`)
    process.exitCode = 1
    return
  }
  writeNotice(`Supervisor ${action} requested for run ${runId}. The owning process will stop at its next control poll.`)
}

async function runConfig(): Promise<void> {
  const { PROVIDER_PRESET_NAMES, isProviderPresetConfigured, providerPresetApiKeyEnv, providerPresetBaseURL, providerPresetDefaultModel } =
    await import('./providers/registry.ts')
  const action = positionals()[0] ?? 'status'
  const configPath = userConfigPath()

  if (action === 'status') {
    const active = process.env.ELIA_PROVIDER ?? 'anthropic'
    writeNotice(`User config: ${configPath}`)
    for (const provider of PROVIDER_PRESET_NAMES) {
      const marker = provider === active ? ' (active)' : ''
      writeUsageLine(`  ${provider}${marker}: ${isProviderPresetConfigured(provider) ? 'configured' : 'not configured'}`)
    }
    writeNotice('API key values are never displayed. Use: elia config set --provider <name>')
    return
  }

  if (action === 'remove') {
    const provider = (flagValue('--provider') || '').toLowerCase()
    if (!provider) {
      writeError('Usage: elia config remove --provider <name>')
      process.exitCode = 1
      return
    }
    try {
      const removed = removeProviderConfiguration(provider)
      writeNotice(removed.removed ? `Removed saved credentials for ${removed.provider} from ${removed.path}.` : `No saved credentials found for ${removed.provider}.`)
      writeNotice('The API key value was never displayed.')
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }

  if (action !== 'set') {
    writeError('Usage: elia config [status|set|remove] [--provider <name>] [--model <id>] [--base-url <url>] [--api-key-env <NAME>|--api-key-stdin]')
    process.exitCode = 1
    return
  }

  const provider = (flagValue('--provider') || process.env.ELIA_PROVIDER || 'anthropic').toLowerCase()
  if (!PROVIDER_PRESET_NAMES.includes(provider)) {
    writeError(`Unknown provider "${provider}". Choose one of: ${PROVIDER_PRESET_NAMES.join(', ')}`)
    process.exitCode = 1
    return
  }

  const modelFlag = flagValue('--model')
  if (modelFlag === '') {
    writeError('--model requires a non-empty model id')
    process.exitCode = 1
    return
  }
  const baseURLFlag = flagValue('--base-url')
  if (baseURLFlag === '') {
    writeError('--base-url requires a non-empty URL')
    process.exitCode = 1
    return
  }
  const sourceKeyEnv = flagValue('--api-key-env')
  if (sourceKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceKeyEnv)) {
    writeError('--api-key-env must be a valid environment variable name')
    process.exitCode = 1
    return
  }
  if (sourceKeyEnv !== undefined && hasFlag('--api-key-stdin')) {
    writeError('Choose either --api-key-env or --api-key-stdin, not both')
    process.exitCode = 1
    return
  }

  const targetKeyEnv = providerPresetApiKeyEnv(provider)
  if (!targetKeyEnv) {
    writeError(`Provider "${provider}" does not define an API key variable`)
    process.exitCode = 1
    return
  }

  let apiKey: string | undefined
  if (sourceKeyEnv !== undefined) {
    apiKey = process.env[sourceKeyEnv]?.trim()
    if (!apiKey) {
      writeError(`Environment variable ${sourceKeyEnv} is not set or is empty`)
      process.exitCode = 1
      return
    }
  } else if (hasFlag('--api-key-stdin')) {
    apiKey = (await readStdinText()).trim()
  } else if (process.stdin.isTTY) {
    apiKey = await readSecretInput(`Enter ${targetKeyEnv} (input hidden): `)
  } else {
    writeError('API key input requires --api-key-stdin, --api-key-env <NAME>, or an interactive terminal')
    process.exitCode = 1
    return
  }

  if (!apiKey) {
    writeError('API key cannot be empty')
    process.exitCode = 1
    return
  }

  const defaultModel = providerPresetDefaultModel(provider)
  const model = modelFlag ?? defaultModel
  if (provider === 'custom' && !model) {
    writeError('Custom providers require --model <model-id>')
    process.exitCode = 1
    return
  }
  const baseURL = baseURLFlag
  if (provider === 'custom' && !baseURL) {
    writeError('Custom providers require --base-url <url>')
    process.exitCode = 1
    return
  }

  const values: Record<string, string | undefined> = {
    ELIA_PROVIDER: provider,
    [targetKeyEnv]: apiKey,
    ELIA_MODEL: model,
    ELIA_BASE_URL: baseURL,
  }
  writeUserConfig(values)
  process.env.ELIA_PROVIDER = provider
  process.env[targetKeyEnv] = apiKey
  if (model) process.env.ELIA_MODEL = model
  else delete process.env.ELIA_MODEL
  if (baseURL) process.env.ELIA_BASE_URL = baseURL
  else delete process.env.ELIA_BASE_URL

  const knownBaseURL = baseURL ?? providerPresetBaseURL(provider)
  writeNotice(`Saved ${provider} configuration to ${configPath}.`)
  writeNotice(`Model: ${model ?? defaultModel ?? 'set by ELIA_MODEL'}`)
  if (knownBaseURL) writeNotice(`Endpoint: ${knownBaseURL}`)
  writeNotice('The API key was saved without displaying its value. Run `elia config` to inspect readiness.')
}

async function runSchedule(): Promise<void> {
  const { MAX_SCHEDULE_ACTIONS, ScheduleStore, formatScheduleInterval, parseScheduleInterval } = await import('./autonomy/scheduler.ts')
  const action = positionals(['--every', '--title', '--profile', '--mode', '--max-run-ms', '--max-actions'])[0] ?? 'list'
  const store = ScheduleStore.open()

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
    const { runScheduledDaemon } = await import('./autonomy/daemon.ts')
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
    writeError('Usage: elia schedule add --every 1h [--mode battmann] [--title "Short title"] [--max-actions N] "<goal>"')
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
  if (!['dev', 'cyber', 'sports', 'fitness', 'battmann'].includes(modeValue)) {
    writeError('--mode must be dev, cyber, sports, fitness, or battmann')
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

async function runDaemon(): Promise<void> {
  const pollMsRaw = flagValue('--poll-ms')
  const pollMs = pollMsRaw === undefined ? undefined : strictInteger(pollMsRaw)
  if (pollMsRaw !== undefined && (pollMs === undefined || pollMs < 1_000)) {
    writeError('--poll-ms must be an integer of at least 1000 milliseconds')
    process.exitCode = 1
    return
  }
  await loadRuntimeSkills()
  const { runScheduledDaemon } = await import('./autonomy/daemon.ts')
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
async function runDoctor(): Promise<void> {
  const { daemonMode, resolveEliadPath, resolveJvmBridgeJar, daemonClient, DaemonUnavailable, socketPath } = await import('./daemon/client.ts')
  const { lastPreflightSkipReason, lastStructuralBackend } = await import('./native/parseCheck.ts')
  const { nativeAvailable, nativeUnavailableReason, nativeLibPath, nativeVersion } = await import('./native/ffi.ts')
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

  if (machineReadable) emitEvent('doctor', { report: lines.join('\n') })
  else process.stdout.write(`${lines.join('\n')}\n`)
}

async function runRuns(): Promise<void> {
  const { listRuns } = await import('./autonomy/journal.ts')
  const runId = positionals()[0]

  if (runId) {
    const { renderRunTimeline } = await import('./autonomy/rewind.ts')
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
  const { renderCalibrationLine } = await import('./autonomy/calibration.ts')
  const calibration = renderCalibrationLine()
  if (calibration && !machineReadable) writeNotice(calibration)
  writeNotice('Inspect one with: elia runs <id>')
}

async function runResume(): Promise<void> {
  const { runDir, readEvents } = await import('./autonomy/journal.ts')
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
  const { GoalGraphStore } = await import('./autonomy/goalGraph.ts')
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
  const { runAutonomousTask, autoApprove } = await import('./autonomy/loop.ts')
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

async function runFork(): Promise<void> {
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
  const { forkRun } = await import('./autonomy/rewind.ts')
  const { autoApprove } = await import('./autonomy/loop.ts')
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

async function main() {
  installShutdownHandlers()
  emitEvent('cli_started', { version: JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text()).version, uiMode: machineReadable ? 'json' : plainOutput ? 'plain' : 'normal' })
  const { flushUsageStats } = await import('./skills/detector.ts')
  // Process-exit handlers must be synchronous, so the flush is registered here,
  // after the module is already loaded.
  process.on('exit', flushUsageStats)

  await taskSessions.load()
  updateTerminalTaskTitle(taskSessions)
  taskSessions.subscribe(() => updateTerminalTaskTitle(taskSessions))

  switch (subcommand) {
    case 'auto':
      return runAuto()
    case 'agent':
      return runAgentCommand()
    case 'evolve':
      return runEvolve()
    case 'gap':
      return runGap()
    case 'values':
      return runValues()
    case 'distill':
      return runDistill()
    case 'compounding':
      return runCompounding()
    case 'jev':
      return runJev()
    case 'bench':
      return runBench()
    case 'bench-latency':
      return runBenchLatency()
    case 'skills':
      return runSkills()
    case 'runs':
      return runRuns()
    case 'fork':
      return runFork()
    case 'resume':
      return runResume()
    case 'schedule':
      return runSchedule()
    case 'daemon':
      return runDaemon()
    case 'doctor':
      return runDoctor()
    case 'config':
      return runConfig()
    case 'codex-login':
      await runCodexLogin()
      return
    case 'control':
      return runControl()
    case 'workspace': {
      const { runWorkspace } = await import('./workspace/cli.ts')
      return runWorkspace(args)
    }
    case 'bridge': {
      if (hasFlag('--http')) {
        const portRaw = flagValue('--port') ?? '4319'
        const port = strictInteger(portRaw)
        if (port === undefined || port < 1 || port > 65535) {
          writeError('--port must be an integer between 1 and 65535')
          process.exitCode = 1
          return
        }
        const hostname = flagValue('--host')
        const { runHttpBridge } = await import('./bridgeHttp.ts')
        return runHttpBridge({ port, hostname })
      }
      const { runVscodeBridge } = await import('./vscodeBridge.ts')
      return runVscodeBridge()
    }
    default:
      return runInteractive()
  }
}

// Load ~/.elia/config.env before any command imports provider configuration. Explicit
// project/process environment values already present in process.env take precedence.
loadUserConfig()

// Sweep temp files orphaned by earlier crashed writes. Only temps whose owning
// process is gone are removed, so a concurrently running elia is never touched.
// Without this they accumulate silently and are never cleaned up by anything.
try {
  const { sweepStaleTemporaries } = await import('./securePersistence.ts')
  const { isProcessAlive } = await import('./fileLock.ts')
  const { paths: statePaths } = await import('./config.ts')
  sweepStaleTemporaries(statePaths.state, isProcessAlive)
} catch {
  // Housekeeping is never a reason to fail a command.
}

// Signal handlers are installed by installShutdownHandlers() so every terminal
// component follows one cleanup path and returns a conventional interrupt code.

await main().catch((err: unknown) => {
  writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}).finally(async () => {
  const { shutdownMcpTools } = await import('./mcp/registry.ts')
  await shutdownMcpTools()
})
