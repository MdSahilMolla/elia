/**
 * The self-improvement subcommands: `compounding`, `jev`, `evolve`, `values`,
 * `distill` and `gap`.
 *
 * These are the loop elia runs on itself — propose, gate, promote, distil — and
 * they are grouped so the commands that can change elia sit together, apart
 * from the ones that only report on it.
 */
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { flagValue, hasFlag, positionals, strictInteger } from './argv.ts'
import { ensureFirstRunProviderSetup } from './providerSetup.ts'
import { loadRuntimeSkills } from './runtime.ts'

/**
 * `elia compounding` — where the self-improvement loop stands, stage by stage,
 * from elia's own records.
 *
 * The six stages measure the slow loop: evolve changing elia's source between
 * generations. The reasoning library underneath them measures the fast one —
 * what each turn's search learned about how to attack work of that shape — so
 * both channels are read off the same command rather than one of them being
 * invisible until someone goes looking for a JSON file.
 *
 * With a subcommand it measures elia against the theory the loop rests on —
 * `frontier`, `round`, `simulate`, `predict` (cli/compoundingEngine.ts).
 */
export async function runCompounding(): Promise<void> {
  const action = positionals()[0]
  if (action !== undefined) {
    const { COMPOUNDING_ACTIONS, runCompoundingAction } = await import('./compoundingEngine.ts')
    if (await runCompoundingAction(action)) return
    writeError(`unknown compounding action "${action}". Try: elia compounding [${COMPOUNDING_ACTIONS.join('|')}]`)
    process.exitCode = 1
    return
  }
  const { compoundingStatus, renderCompoundingStatus } = await import('../compounding/status.ts')
  const { evidenceVelocity, renderVelocity } = await import('../compounding/velocity.ts')
  const { readLedger } = await import('../evolve/ledger.ts')
  const { readLibrary, renderLibrary } = await import('../reason/library.ts')
  const { coverageOf, recentCoverage, renderCoverage } = await import('../reason/coverage.ts')
  const { loadAllOutcomes } = await import('../autonomy/outcomes.ts')
  const { readBenchRuns } = await import('../compounding/status.ts')
  const { inferTasks, isAssumed, renderGatePower } = await import('../evolve/power.ts')
  const { benchRepeats } = await import('../evolve/fitness.ts')
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
  const practice = await import('../evolve/autoImprove.ts')
  const practiceLine = practice.renderPracticeStatus(practice.reapPractice(), { now: Date.now(), enabled: practice.autoImproveEnabled() })
  // Capability in the field, beside capability on the benchmark: what elia
  // proposed to projects it does not own, and what was accepted. The benchmark
  // can saturate; other people's repositories cannot.
  const { readContributions, renderContributionEvidence } = await import('../github/contribute.ts')
  const contributions = readContributions()
  if (machineReadable) emitEvent('compounding_status', { stages, reasoning: library.records, coverage, velocity, contributions })
  else {
    writeUsageLine(
      [
        renderCompoundingStatus(stages),
        practiceLine,
        renderContributionEvidence(contributions),
        renderVelocity(velocity),
        renderCoverage(coverage.lifetime, coverage.recent),
        gatePower,
        renderLibrary(library),
      ]
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
export async function runJev(): Promise<void> {
  const { jevEnabled, askJev } = await import('../providers/jev.ts')
  const { readLedger, summarize, renderSummary } = await import('../reason/systemOne.ts')
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
    const { runSystemOneBench } = await import('../reason/systemOneBench.ts')
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

export async function runEvolve(): Promise<void> {
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
    const { fieldEvidenceSection } = await import('../evolve/fieldEvidence.ts')
    const section = fieldEvidenceSection().trim()
    writeUsageLine(section || 'No field evidence yet — this project has no audited tool calls on record.')
    return
  }

  if (hasFlag('--auto')) return runAutoPractice()

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { evolve } = await import('../evolve/engine.ts')
  // --focus N: score on the built-in tasks, the last full run's failures, and N
  // of its passing history tasks — a fraction of the full set's cost, and
  // still the same fixed set for the baseline and every candidate.
  let taskIds: string[] | undefined
  const focusRaw = flagValue('--focus')
  if (hasFlag('--builtin') && focusRaw !== undefined) {
    writeError('--builtin and --focus each choose the task set; pass one.')
    process.exitCode = 1
    return
  }
  // --builtin: the fixed built-in suite alone — seconds a task, no git-history
  // checkouts, and no full sweep needed first. A full `--all` sweep is hours on
  // a free tier; this turns the loop while that is still out of reach. Every
  // baseline and candidate in the run is scored on the same set, and the split
  // still holds part of it back from the proposer.
  if (hasFlag('--builtin')) {
    const { BENCH_TASKS } = await import('../evolve/suite.ts')
    taskIds = BENCH_TASKS.map((task) => task.id)
    writeNotice(`Scoring on the ${taskIds.length} built-in task(s) only — no history tasks, so a change that only affects those will not be seen.`)
  }
  if (focusRaw !== undefined) {
    const focus = strictInteger(focusRaw)
    if (focus === undefined || focus < 0) {
      writeError('--focus must be a non-negative integer (how many passing history tasks to keep as regression guards).')
      process.exitCode = 1
      return
    }
    const { BENCH_TASKS, allBenchTasks } = await import('../evolve/suite.ts')
    const { focusTaskIds } = await import('../compounding/status.ts')
    taskIds = focusTaskIds(BENCH_TASKS.map((task) => task.id), focus, undefined, allBenchTasks().map((task) => task.id))
    if (!taskIds) {
      writeError('--focus needs a complete `elia bench --all` run to focus from (none recorded with every task measured).')
      process.exitCode = 1
      return
    }
    writeNotice(`Focused on ${taskIds.length} task(s): the built-in set, the last full run's failures, any task harvested since it, and ${focus} passing history task(s).`)
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
  const { renderLearningLine } = await import('../evolve/ledger.ts')
  writeUsageLine(`  ${renderLearningLine()}`)
}

/**
 * `elia evolve --auto`: one unattended practice run, started in the background
 * by an idle or closing REPL (evolve/autoImprove.ts). Never prompts, never
 * touches the working tree — a promotion goes to its own branch — and records
 * what came of it for the next session to say.
 *
 * The first run on a project has no full benchmark to focus from, so it runs
 * one: that is what records the reach map the sieve needs and the failures the
 * proposer studies, and without it every later verdict costs a full sweep.
 * After that, each run is one round of the resource governor (compounding/round.ts),
 * of which an evolve generation is one possible choice.
 */
async function runAutoPractice(): Promise<void> {
  const auto = await import('../evolve/autoImprove.ts')
  const started = auto.readAutoImproveState()
  // A session that launched this already claimed the slot with our pid; run
  // by hand (`elia evolve --auto`), claim it here.
  const claimed = started.pid === process.pid
  auto.writeAutoImproveState({
    ...started,
    pid: process.pid,
    startedAt: claimed && started.startedAt !== undefined ? started.startedAt : Date.now(),
    finishedAt: undefined,
    newTurns: claimed ? (started.newTurns ?? 0) : 0,
    reported: false,
  })
  // A run that is killed cannot write its own outcome, so it says it is alive as
  // it goes and a later session reaps the silence (evolve/autoImprove.ts).
  const stopHeartbeat = auto.startPracticeHeartbeat()
  let finished = false
  const finish = (outcome: import('../evolve/autoImprove.ts').AutoOutcome, detail: string, branch?: string): void => {
    if (finished) return
    finished = true
    stopHeartbeat()
    const blocked = outcome === 'blocked'
    auto.writeAutoImproveState({
      ...auto.readAutoImproveState(),
      finishedAt: Date.now(),
      outcome,
      summary: auto.practiceSummary(outcome, detail, branch),
      branch,
      blockedUntil: blocked ? Date.now() + auto.BLOCKED_BACKOFF_MS : undefined,
      reported: false,
    })
    writeUsageLine(`[${new Date().toISOString()}] practice ${outcome}: ${detail}`)
  }

  // The signals that can be caught are worth a precise reason; the ones that
  // cannot (SIGKILL, `taskkill /F`, a closing console) fall through to the reaper.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      finish('failed', `the practice run was stopped (${signal})`)
      process.exit(1)
    })
  }

  try {
    await loadRuntimeSkills()
    const { BENCH_TASKS, allBenchTasks } = await import('../evolve/suite.ts')
    const { focusTaskIds, recordBenchRun } = await import('../compounding/status.ts')
    const taskIds = focusTaskIds(BENCH_TASKS.map((task) => task.id), 8, undefined, allBenchTasks().map((task) => task.id))

    if (!taskIds) {
      // Kept task by task and reused next time: a practice run is stopped
      // whenever the machine sleeps, and the sweep has to survive that.
      const { measureLiveTree } = await import('../evolve/baselineCache.ts')
      const { ELIA_ROOT, config } = await import('../config.ts')
      const { card } = await measureLiveTree({ tasks: allBenchTasks(), sourceRoot: ELIA_ROOT, model: config.model })
      if (card.unmeasured.length > 0) {
        const detail = `the benchmark could not measure ${card.unmeasured.length} task(s)`
        finish(auto.looksBlocked(card.outcomes.map((outcome) => outcome.error ?? '').join('\n')) ? 'blocked' : 'failed', detail)
        return
      }
      recordBenchRun(card, 'all')
      finish('benchmarked', `scored itself on ${card.outcomes.length} benchmark tasks (${Math.round(card.passRate * 100)}%) — the next practice run can now try changes`)
      return
    }

    // What the idle compute goes to is the resource governor's call (§10), not
    // always a generation: while the benchmark cannot tell a gain from noise it
    // grows the benchmark, builds a tool or audits first. `meta` below is the
    // generation practice always ran, promoted to its own branch as before.
    const { gatherState, readActivityLog, runRound } = await import('../compounding/round.ts')
    const { createRunners, gatherSources, PAID_ACTIVITIES } = await import('../compounding/runners.ts')
    const { ACTIVITY_LABEL } = await import('../compounding/resourceGovernor.ts')
    const history = readActivityLog()
    let generation: import('../evolve/ledger.ts').GenerationRecord | undefined
    let stoppedReason: string | undefined
    const round = await runRound({
      state: gatherState(await gatherSources()),
      regather: async () => gatherState(await gatherSources()),
      // Practice already spent credit on every run; the governor only decides on what.
      spend: true,
      paid: PAID_ACTIVITIES,
      history,
      runners: createRunners({
        spend: true,
        history,
        onProgress: (message) => writeUsageLine(`[${new Date().toISOString()}] ${message}`),
        meta: async () => {
          const { evolve } = await import('../evolve/engine.ts')
          const result = await evolve({ generations: 1, taskIds, promoteTo: 'branch' })
          stoppedReason = result.stoppedReason
          generation = result.generations[0]
          const detail = generation ? `${generation.verdict}: ${generation.reason.split('\n')[0]}` : (stoppedReason ?? 'no generation was recorded')
          return { ran: Boolean(generation || stoppedReason), cost: 5, detail }
        },
      }),
    })
    for (const entry of round.skipped) writeUsageLine(`[${new Date().toISOString()}] governor skipped ${entry.activity}: ${entry.reason}`)
    const verdict = auto.governedOutcome({
      ...(round.ran ? { ran: { activity: round.ran.activity, label: ACTIVITY_LABEL[round.ran.activity], detail: round.ran.result.detail } } : {}),
      skipped: round.skipped,
      ...(generation ? { generation } : {}),
      ...(stoppedReason ? { stoppedReason } : {}),
    })
    finish(verdict.outcome, verdict.detail, verdict.branch)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    finish(auto.looksBlocked(detail) ? 'blocked' : 'failed', detail.split('\n')[0]!.slice(0, 300))
  }
}

export async function runValues(): Promise<void> {
  const { loadValueCore, describeValueCore } = await import('../values/core.ts')
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
    const { runValueProbes } = await import('../values/probes.ts')
    const { recordProbeRun, readLatestProbeRun, checkValueDrift } = await import('../values/drift.ts')
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

export async function runDistill(): Promise<void> {
  const { collectDistillableTraces } = await import('../distill/corpus.ts')
  const { fragmentCount } = await import('../distill/fragments.ts')
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
    const { allTrajectoryRows, defaultExportPath, readiness, renderReadiness, selectTrainingExamples, writeTrainingExport } = await import('../distill/export.ts')
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
    const { diagnoseTraceSupply } = await import('../distill/corpus.ts')
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
  const { proposeDistillations } = await import('../distill/mine.ts')
  const { evaluateCandidate } = await import('../distill/gate.ts')

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

export async function runGap(): Promise<void> {
  const { computeGapVector } = await import('../gap/scoreboard.ts')
  const { checkGapNotRegressed } = await import('../gap/guard.ts')
  const { recordGapVector, readGapHistory, readLatestGapVector, renderGapVector } = await import('../gap/report.ts')

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
