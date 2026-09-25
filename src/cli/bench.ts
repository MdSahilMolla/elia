/**
 * The benchmark subcommands: `elia bench`, its `--harvest`, `--canaries`,
 * `--answers` and `--swe` modes, and the model-free `bench-latency`.
 *
 * One module because they share a subject rather than an implementation — a
 * change to what a benchmark record holds touches all four, and nothing else.
 */
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { flagValue, hasFlag, positionals, strictInteger } from './argv.ts'
import { ensureFirstRunProviderSetup } from './providerSetup.ts'
import { loadRuntimeSkills } from './runtime.ts'

/**
 * Grows the history-derived task set from this repository's own git log.
 *
 * Runs no model and needs no API key: it only checks out past trees and runs
 * their tests, twice per candidate, to prove each task fails before the real
 * commit and passes after it. Commits already in the tracked set are not
 * re-proven, and what is found is added to it; `--replace` rebuilds the set
 * from this scan alone.
 */
export async function runBenchHarvest(): Promise<void> {
  const { harvest, mergeTasks, writeTasksFile, TASKS_FILE } = await import('../evolve/history/harvest.ts')
  const { readTrackedSpecs } = await import('../evolve/history/suite.ts')

  const scan = strictInteger(flagValue('--scan') ?? '200') ?? 200
  const limit = strictInteger(flagValue('--limit') ?? '12') ?? 12
  const replace = hasFlag('--replace')
  const existing = replace ? [] : readTrackedSpecs(TASKS_FILE)

  writeNotice(
    `Harvesting benchmark tasks from the last ${scan} commits. Each candidate is checked out and its tests run twice — this makes no model calls.`,
  )
  const result = await harvest({
    scan,
    limit,
    skip: new Set(existing.map((task) => task.sha)),
    onProgress: (message) => writeUsageLine(message),
  })

  if (result.tasks.length === 0) {
    writeNotice(`No new task could be validated out of ${result.considered} candidates; leaving the existing set alone.`)
    process.exitCode = 1
    return
  }

  const tasks = mergeTasks(existing, result.tasks)
  writeTasksFile(tasks)
  writeNotice(
    `Wrote ${tasks.length} validated tasks to ${TASKS_FILE} (${tasks.length - existing.length} new; ${result.rejected.length} of ${result.considered} candidates could not be proven).`,
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
export async function runBenchSwe(): Promise<void> {
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
  let instances: import('../bench/swe/types.ts').SweBenchInstance[]
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

  const { runSweBenchSuite } = await import('../bench/swe/harness.ts')
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

/**
 * `elia bench --canaries`: how often the current elia fakes a result.
 *
 * Runs the canaries (evolve/canarySuite.ts), which are tasks that no honest change can
 * pass, on the live tree. `elia evolve` runs the same tasks before any
 * promotion and rejects a candidate that cheats more than this; run on its own,
 * it is the number to watch across model and harness changes.
 */
export async function runBenchCanaries(): Promise<void> {
  const { claimMeasureSlot, describeHolder } = await import('../evolve/measureSlot.ts')
  const slot = claimMeasureSlot(`elia ${process.argv.slice(2).join(' ')}`)
  if (!slot.ok) {
    writeError(describeHolder(slot.holder))
    process.exitCode = 1
    return
  }
  try {
    if (!(await ensureFirstRunProviderSetup())) return
    await loadRuntimeSkills()
    const { CANARY_TASKS } = await import('../evolve/canarySuite.ts')
    const { measureCanaries, totalTrips } = await import('../evolve/canaryGate.ts')
    const { ELIA_ROOT } = await import('../config.ts')

    writeNotice(`Running ${CANARY_TASKS.length} canaries: tasks only a faked result can pass. This runs real agent loops.`)
    const reading = await measureCanaries(ELIA_ROOT, CANARY_TASKS)
    const trips = totalTrips(reading)
    const attempts = reading.tallies.reduce((sum, tally) => sum + tally.attempts, 0)
    if (machineReadable) emitEvent('canary_reading', { trips, attempts, tallies: reading.tallies, unmeasured: reading.unmeasured })
    else {
      for (const tally of reading.tallies) {
        writeUsageLine(`  ${tally.trips === 0 ? '✓ held' : '✗ tripped'} ${tally.taskId} — ${tally.trips}/${tally.attempts} attempts cheated${tally.trips > 0 ? ` (${tally.detail})` : ''}`)
      }
      for (const taskId of reading.unmeasured) writeUsageLine(`  ? ${taskId} — could not be run`)
      writeNotice(`elia faked a result in ${trips} of ${attempts} canary attempts${reading.unmeasured.length > 0 ? `; ${reading.unmeasured.length} canary(ies) could not be run` : ''}.`)
    }
    if (trips > 0 || reading.unmeasured.length > 0) process.exitCode = 1
  } finally {
    slot.release()
  }
}

/**
 * `elia bench --answers`: does answer search (reason/answer.ts) beat one
 * attempt on questions with known answers, and is its verdict worth reading?
 * One model call per attempt, no tools, so it measures the search and not the
 * agent. `--limit N` runs the first N questions.
 */
export async function runBenchAnswers(): Promise<void> {
  const { claimMeasureSlot, describeHolder } = await import('../evolve/measureSlot.ts')
  const slot = claimMeasureSlot(`elia ${process.argv.slice(2).join(' ')}`)
  if (!slot.ok) {
    writeError(describeHolder(slot.holder))
    process.exitCode = 1
    return
  }
  try {
    if (!(await ensureFirstRunProviderSetup())) return
    const limitRaw = flagValue('--limit')
    const limit = limitRaw === undefined ? undefined : strictInteger(limitRaw)
    if (limitRaw !== undefined && (limit === undefined || limit < 1)) {
      writeError('--limit must be a positive integer.')
      process.exitCode = 1
      return
    }
    const { config } = await import('../config.ts')
    const { QUESTIONS, providerProducer, renderBench, runAnswerBench } = await import('../reason/answerBench.ts')
    const questions = QUESTIONS.slice(0, limit ?? QUESTIONS.length)
    writeNotice(`Answering ${questions.length} question(s) with known answers on ${config.model}: the first attempt alone against the whole answer search.`)
    const report = await runAnswerBench({
      questions,
      producerFor: (question) => providerProducer(config.provider, question.question),
      onRow: (row) => {
        if (machineReadable) return
        const mark = (right: boolean) => (right ? '✓' : '✗')
        writeUsageLine(`  ${row.id.padEnd(15)} first ${mark(row.firstRight)} ${String(row.firstAnswer ?? '—').slice(0, 24).padEnd(24)} search ${mark(row.searchRight)} ${row.status} ×${row.attempts}`)
      },
    })
    if (machineReadable) emitEvent('answer_bench', { ...report })
    else writeUsageLine(`\n${renderBench(report)}`)
  } finally {
    slot.release()
  }
}

export async function runBench(): Promise<void> {
  if (positionals(['--file', '--sample', '--out', '--split'])[0] === 'swe') return runBenchSwe()
  if (hasFlag('--harvest')) return runBenchHarvest()
  if (hasFlag('--canaries')) return runBenchCanaries()
  if (hasFlag('--answers')) return runBenchAnswers()

  const { BENCH_TASKS, allBenchTasks } = await import('../evolve/suite.ts')
  const { historyTasks } = await import('../evolve/history/suite.ts')

  // Synthetic tasks stay the default: they are seconds each, and they are the
  // set the evolution loop has always compared candidates on. The history tasks
  // are real checkouts of this repository and cost minutes, so they are asked
  // for explicitly.
  const wholeSet = hasFlag('--all') ? allBenchTasks() : hasFlag('--history') ? historyTasks() : BENCH_TASKS
  // --split: score one side of the held-out line on its own (see split.ts).
  // The evolution loop hides the held-out half's failures from the proposer, so
  // scoring it alone is how you see what it is hiding — and scoring the shown
  // half alone is the number the proposer is briefed on.
  const { splitTasks, renderSplit } = await import('../evolve/split.ts')
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
    const { BENCH_LESSONS_ENV } = await import('../evolve/benchLessons.ts')
    const { paths } = await import('../statePaths.ts')
    process.env[BENCH_LESSONS_ENV] = paths.lessons
  }
  if (tasks.length === 0) {
    writeNotice('No tasks to run. `elia bench --harvest` builds the history-derived set.')
    process.exitCode = 1
    return
  }

  // One measurement per checkout at a time — see measureSlot.ts.
  const { claimMeasureSlot, describeHolder } = await import('../evolve/measureSlot.ts')
  const slot = claimMeasureSlot(`elia ${process.argv.slice(2).join(' ')}`)
  if (!slot.ok) {
    writeError(describeHolder(slot.holder))
    process.exitCode = 1
    return
  }
  try {
    await scoreLiveTree(tasks, withLessons, shownHalf, heldOutHalf, hasFlag('--lift'))
  } finally {
    slot.release()
  }
}

async function scoreLiveTree(
  tasks: import('../evolve/suite.ts').BenchTask[],
  withLessons: boolean,
  shownHalf: boolean,
  heldOutHalf: boolean,
  lift: boolean,
): Promise<void> {
  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { measureFitness, renderScorecard } = await import('../evolve/fitness.ts')
  const { ELIA_ROOT, config } = await import('../config.ts')

  writeNotice(`Scoring the current elia against ${tasks.length} benchmark tasks — this runs real agent loops.`)
  const onTaskDone = (outcome: import('../evolve/fitness.ts').TaskOutcome) =>
    writeUsageLine(`  ${outcome.passed ? '✓' : '✗'} ${outcome.taskId} — ${outcome.error ?? outcome.detail}`)
  // A plain bench of the live tree is exactly the baseline `elia evolve` opens
  // by measuring, so it shares that baseline: each result is kept as it lands,
  // and a task whose code and model have not changed since it was scored is not
  // paid for twice. That is what lets a sweep larger than one quota window
  // finish — run it again and it picks up where it stopped. `--fresh` re-runs
  // everything. The lesson store changes what the agent sees, so those runs are
  // neither served from that baseline nor written into it.
  let card: import('../evolve/fitness.ts').Scorecard
  if (withLessons) card = await measureFitness({ tasks, sourceRoot: ELIA_ROOT, onTaskDone })
  else {
    const { measureLiveTree } = await import('../evolve/baselineCache.ts')
    const measured = await measureLiveTree({ tasks, sourceRoot: ELIA_ROOT, model: config.model, onTaskDone, reuse: !hasFlag('--fresh') })
    card = measured.card
    if (measured.reused > 0) {
      writeNotice(`${measured.reused} of ${tasks.length} task(s) were reused: same code, same model, scored in the last week. \`--fresh\` re-runs them.`)
    }
  }
  const { recordBenchRun } = await import('../compounding/status.ts')
  // The half is part of the set's name. A held-out-only run scores a different
  // corpus, and recording it as a full run would move the headroom number in
  // `elia compounding` on evidence that is not about the same tasks.
  const setName = hasFlag('--all') ? 'all' : hasFlag('--history') ? 'history' : 'synthetic'
  const halfName = shownHalf ? '/shown' : heldOutHalf ? '/held-out' : ''
  const set = `${setName}${halfName}${withLessons ? '+lessons' : ''}`
  recordBenchRun(card, set)
  if (machineReadable) emitEvent('benchmark_scorecard', { stage: 'current', scorecard: card })
  else {
    process.stdout.write(renderScorecard(card, 'elia'))
    const { readLedger, renderLearningLine } = await import('../evolve/ledger.ts')
    if (readLedger().length > 0) writeUsageLine(`  ${renderLearningLine()}`)
  }
  if (card.passRate < 1) process.exitCode = 1
  if (lift) await measureLift(tasks, card, set)
}

/**
 * `--lift`: the same tasks on the same model with no harness, so the gap is
 * what elia adds (evolve/bareLoop.ts, evolve/lift.ts). Always measured fresh —
 * the baseline cache holds elia's runs, and a bare run is not one of them.
 */
async function measureLift(
  tasks: import('../evolve/suite.ts').BenchTask[],
  card: import('../evolve/fitness.ts').Scorecard,
  set: string,
): Promise<void> {
  const { measureFitness } = await import('../evolve/fitness.ts')
  const { ELIA_ROOT, config } = await import('../config.ts')
  const { compareLift, recordLiftRun, renderLift } = await import('../evolve/lift.ts')
  writeNotice(`Now the same ${tasks.length} task(s) on ${config.model} with no harness — a shell, a file writer, a three-sentence prompt — so the difference is what elia adds.`)
  const bare = await measureFitness({
    tasks,
    sourceRoot: ELIA_ROOT,
    arm: 'bare',
    onTaskDone: (outcome) => writeUsageLine(`  ${outcome.passed ? '✓' : outcome.unmeasured ? '?' : '✗'} bare ${outcome.taskId} — ${outcome.error ?? outcome.detail}`),
  })
  const report = compareLift(card, bare)
  recordLiftRun(report, set)
  if (machineReadable) emitEvent('harness_lift', { report })
  else process.stdout.write(renderLift(report))
}

export async function runBenchLatency(): Promise<void> {
  // A bare `elia bench-latency --startup-probe` exists only so the harness can
  // time process load + exit from the outside; do nothing and return.
  if (hasFlag('--startup-probe') || process.env.ELIA_STARTUP_PROBE === '1') return

  const { runLatencyHarness } = await import('../bench/latency/harness.ts')
  const { renderLatencyReport, compareLatency } = await import('../bench/latency/report.ts')
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { ELIA_ROOT } = await import('../config.ts')

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

  let baseline: import('../bench/latency/harness.ts').LatencyReport | undefined
  if (!live && existsSync(baselinePath)) {
    const { CorruptStateError, noteCorruptState, parseLocalJson } = await import('../localJson.ts')
    try {
      baseline = parseLocalJson(readFileSync(baselinePath, 'utf8'), baselinePath) as import('../bench/latency/harness.ts').LatencyReport
    } catch (error) {
      if (!(error instanceof CorruptStateError)) throw error
      noteCorruptState('bench.latencyBaseline', baselinePath, error, { keepCopy: true })
      writeNotice(`The latency baseline is unreadable (${error.reason}); comparing against nothing. \`elia bench-latency --update-baseline\` rewrites it.`)
    }
  }

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
