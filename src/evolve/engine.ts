import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEV_SYSTEM_PROMPT, ELIA_ROOT, config } from '../config.ts'
import { runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { runSubAgent } from '../subagent.ts'
import { allWorkerTools } from '../tools/registry.ts'
import type { Tool } from '../tools/types.ts'
import { clampOutput, runShell } from '../shell.ts'
import { writeText } from '../ui/stream.ts'
import { writeBlock, writeFail, writePass, writePhase, writeSubStep, writeSummary } from '../ui/report.ts'
import { formatElapsed } from '../usage.ts'
import { emitEvent, machineReadable, quietOutput } from '../ui/runtime.ts'
import {
  EVOLUTION_DIR,
  appendGeneration,
  nextGenerationNumber,
  readLedger,
  renderLedgerForPrompt,
  type EvidenceCost,
  type GenerationRecord,
  type Metrics,
} from './ledger.ts'
import {
  REAL_CHANGE,
  benchConcurrency,
  cardFromOutcomes,
  compareScorecards,
  measureFitness,
  renderScorecard,
  toMetrics,
  type Comparison,
  type Scorecard,
  type TaskOutcome,
} from './fitness.ts'
import { raceCandidate, regressionsIn, renderRace, settleRegressions, sieveEnabled } from './sieve.ts'
import {
  blindEvidence,
  blindMetrics,
  classifyGeneralization,
  halfMetrics,
  renderGeneralization,
  renderSplit,
  splitTasks,
  type TaskSplit,
} from './split.ts'
import { hasReachEvidence, measurableAreas } from './reach.ts'
import { measureLiveTree } from './baselineCache.ts'
import {
  IMMUTABLE_FILES,
  changedFiles,
  createSandbox,
  describeChanges,
  isImmutablePath,
  LiveTreeConflict,
  promote,
  promoteToBranch,
  removeSandbox,
  violatedImmutables,
  type Sandbox,
} from './sandbox.ts'
import { candidateTools } from './candidateTools.ts'
import { gapVectorIn, toolNamesIn, valueProbesIn } from './measureTree.ts'
import { removedTools } from './toolSurface.ts'
import { checkGapNotRegressed } from '../gap/guard.ts'
import { checkValueDrift, confirmValueDrift, recordProbeRun } from '../values/drift.ts'
import { allBenchTasks, type BenchTask } from './suite.ts'
import {
  incumbentStrategy,
  pickStrategy,
  settleStrategyTrial,
  shouldProposeChallenger,
  type Strategy,
} from './strategy.ts'
import { proposeChallengerStrategy } from './metaPropose.ts'
import { fieldEvidenceSection } from './fieldEvidence.ts'
import { gateDecision, gateMode, meanGainOver, sealedCompare, type SealedVerdict } from './acceptance.ts'
import { diffDigest, redactHeldOut, sealedReadTools } from './isolation.ts'
import { applySteppingStone, archiveNearMiss, elites, readArchive, renderSteppingStones } from './archive.ts'

/**
 * Elia improving elia.
 *
 * The loop is: measure yourself, read everything you have already tried, form one
 * hypothesis about your weakest link, implement it in a copy of yourself, and let
 * the benchmark decide whether that copy replaces you. Then do it again, now
 * standing on the version that won.
 *
 * Two design choices are what make this self-improvement rather than self-editing.
 *
 * The candidate is evaluated *by running the candidate* — the benchmark child
 * processes are launched from the sandbox's own source, so a mutation to the agent
 * loop, the system prompt, or the tool set is measured through its own effects.
 * And the mutation is allowed to target the parts of elia that do the improving:
 * the planner prompt, the role definitions, the loop policy. A generation that
 * makes elia a better engineer makes the next generation's attempt better too,
 * which is the recursion.
 *
 * What keeps it honest is that nothing is promoted on a model's opinion. The
 * benchmark is code, its files cannot be edited by the candidate, and a tie is a
 * rejection.
 */

const HYPOTHESIS_MAX_STEPS = 30
/** Further runs of a candidate's value probes before a one-sample drift rejects it. */
const VALUE_RETESTS = 2
/**
 * Typecheck and unit tests in the sandbox. The suite takes about 90s on an idle
 * machine and took 239s with a benchmark running beside it; practice runs in
 * the background while someone works, so a busy machine is the normal case.
 */
const GATE_TIMEOUT_MS = 600_000

export interface Hypothesis {
  title: string
  rationale: string
  targetFiles: string[]
  plan: string
  /** An archived stepping stone to start from instead of the current source (archive.ts). */
  buildOn?: string
}

export interface EvolveOptions {
  generations?: number
  /** Evaluate and report, but never write to the live source. */
  dryRun?: boolean
  /** Score only these task ids (fixed for the whole run). Default: every task. */
  taskIds?: string[]
  /**
   * Where a promoted candidate goes. `live` (the default, and what a person at
   * the keyboard asked for) copies it into the source tree; `branch` commits it
   * to its own `evolve/…` branch for review and leaves the checkout alone — what
   * an unattended run must do.
   */
  promoteTo?: 'live' | 'branch'
  signal?: AbortSignal
}

export interface EvolveResult {
  generations: GenerationRecord[]
  baseline: Metrics
  final: Metrics
  /** Set when no generation was attempted, and why. */
  stoppedReason?: string
}

export async function evolve(options: EvolveOptions = {}): Promise<EvolveResult> {
  const generations = options.generations ?? 1
  const records: GenerationRecord[] = []

  // The full grown set (the fixed synthetic+hard suite plus whatever
  // `elia bench --harvest` has mined from this repo's own git history) —
  // not the fixed BENCH_TASKS the CLI's plain `elia bench` still defaults to
  // for speed. Without this, the harvester's output was already written to
  // disk but never reached the loop that actually decides what "better"
  // means, so the benchmark ceiling never grew even as the corpus did.
  // Resolved once per evolve() call, not per generation, so every baseline
  // and candidate measurement in this run is scored on the identical set —
  // required for compareScorecards' pass/fail comparison to mean anything.
  // The recursive half: settle any finished strategy trial before this run
  // chooses how to search. See strategy.ts.
  const trial = settleStrategyTrial(readLedger())
  if (trial.verdict === 'adopt') writePass(`search strategy ${trial.challenger!.id} adopted — its generations went further (${trial.challenger!.meanDepth.toFixed(2)} vs ${trial.incumbent.meanDepth.toFixed(2)})`)
  else if (trial.verdict === 'reject') writeSubStep(`search strategy ${trial.challenger!.id} retired — not ahead after ${trial.challenger!.generations} generations`)

  const everyTask = allBenchTasks()
  const tasks = options.taskIds ? everyTask.filter((task) => options.taskIds!.includes(task.id)) : everyTask
  if (tasks.length === 0) throw new Error('evolve was given a task subset that matches no benchmark task')

  writePhase('orient', `measuring the current elia against ${ELIA_ROOT} (${tasks.length} tasks)`)
  const baselineCard = await measureBaseline(tasks)
  if (machineReadable) emitEvent('benchmark_scorecard', { stage: 'baseline', scorecard: baselineCard })
  else if (!quietOutput) process.stdout.write(renderScorecard(baselineCard, 'Baseline'))

  const firstBaseline = toMetrics(baselineCard)
  let baseline = firstBaseline

  // Every generation compares against this baseline, and compareScorecards
  // refuses any comparison with a task missing from it. Starting anyway would
  // spend a full propose/implement/measure cycle per generation on a rejection
  // that is already certain.
  if (baselineCard.unmeasured.length > 0) {
    const stoppedReason = `the baseline could not measure ${baselineCard.unmeasured.join(', ')} — fix the provider or the tasks before evolving (see the scorecard above)`
    writeFail(stoppedReason)
    return { generations: [], baseline: firstBaseline, final: firstBaseline, stoppedReason }
  }

  // One slice of the corpus is scored but never described to the proposer, so
  // that a gain there cannot have been aimed at. See split.ts for what that
  // does and does not buy. Computed once per run: a split that moved between
  // generations would make the halves' scores incomparable within the run.
  const split = splitTasks(tasks)
  writeSubStep(renderSplit(split))

  // What the proposer studies. Only the card that produced the current baseline
  // is evidence about it, so this is replaced whenever a candidate is promoted.
  let evidence = baselineCard.outcomes.filter((outcome) => !outcome.passed)

  // The baseline's per-task rows, not just its totals. `sieve.ts` carries the row
  // of any task the candidate's diff provably cannot reach straight across, so
  // the two cards stay comparable without paying to re-run a task whose code did
  // not change. Replaced on a promotion for the same reason `baseline` is.
  let baselineOutcomes = baselineCard.outcomes

  for (let index = 0; index < generations; index++) {
    if (options.signal?.aborted) break

    const generation = nextGenerationNumber()
    const { record, candidateCard } = await runGeneration(generation, baseline, options, tasks, evidence, baselineOutcomes, split)
    records.push(record)
    appendGeneration(record)

    if (record.verdict === 'promoted' && record.candidate) {
      // Stand on the winner: the next generation is measured against, and builds
      // on, the version that just won.
      baseline = record.candidate
      if (candidateCard) {
        evidence = candidateCard.outcomes.filter((outcome) => !outcome.passed)
        baselineOutcomes = candidateCard.outcomes
      }
    }

    // A search that keeps banking nothing writes itself a different way to
    // search; the next generations put it on trial against the incumbent.
    if (!options.signal?.aborted && shouldProposeChallenger(readLedger())) {
      await proposeChallengerStrategy(generation, options.signal)
    }
  }

  return { generations: records, baseline: firstBaseline, final: baseline }
}

/**
 * Score the live tree, reusing any task whose own code has not changed since it
 * was last scored.
 *
 * The reuse trades a measurement for an assumption — see baselineCache.ts for
 * which one, and why the direction it can be wrong in is the safe one. It is on
 * by default and `ELIA_BASELINE_CACHE=off` goes back to measuring every time.
 */
async function measureBaseline(tasks: BenchTask[]): Promise<Scorecard> {
  const report = (outcome: TaskOutcome) =>
    outcome.passed ? writePass(`${outcome.taskId} — ${outcome.detail}`) : writeFail(`${outcome.taskId} — ${outcome.error ?? outcome.detail}`)
  const { card, reused } = await measureLiveTree({ tasks, sourceRoot: ELIA_ROOT, model: config.model, onTaskDone: report })
  if (reused > 0) writeSubStep(`${reused} of ${tasks.length} baseline task(s) unchanged since they were last scored — reused`)
  return card
}

async function runGeneration(
  generation: number,
  baseline: Metrics,
  options: EvolveOptions,
  tasks: BenchTask[],
  evidence: TaskOutcome[],
  baselineOutcomes: TaskOutcome[],
  split: TaskSplit,
): Promise<{ record: GenerationRecord; candidateCard?: Scorecard }> {
  let candidateCard: Scorecard | undefined
  // The record is built early and filled in as the attempt progresses, so a
  // throw from anywhere inside it still has a funnel stage and a hypothesis to
  // report. Without this the whole attempt vanished: a provider rate limit
  // partway through the build left nothing in the ledger, and the next
  // generation read a history in which that attempt had never happened.
  let started: GenerationRecord | undefined
  let sandbox: Sandbox | undefined
  try {
    const record = await attemptGeneration(
      generation,
      baseline,
      options,
      tasks,
      evidence,
      baselineOutcomes,
      split,
      (card) => {
        candidateCard = card
      },
      (base) => {
        started = base
      },
      (created) => {
        sandbox = created
      },
    )
    keepSteppingStone(record, sandbox, split)
    return { record, candidateCard }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const record: GenerationRecord = {
      ...(started ?? {
        generation,
        at: Date.now(),
        strategyId: 'unknown',
        hypothesis: '',
        rationale: '',
        targetFiles: [],
        changedFiles: [],
        baseline,
        model: config.model,
      }),
      verdict: 'error',
      reason: `the attempt could not finish: ${clampOutput(detail, 400)}`,
    }
    writeFail(`generation ${generation} could not finish: ${detail.split('\n')[0]!.slice(0, 200)}`)
    return { record, candidateCard }
  }
}

/**
 * A rejected candidate that still moved the shown tasks the right way is a
 * stepping stone (archive.ts, Proposition 4). Its sandbox is still on disk
 * at this point — every post-measurement rejection keeps it — so its files are
 * copied into the archive before the pruner can take them.
 */
function keepSteppingStone(record: GenerationRecord, sandbox: Sandbox | undefined, split: TaskSplit): void {
  if (record.verdict !== 'rejected' || !record.baseline || !record.candidate || !sandbox) return
  const shownIds = new Set(split.train.map((task) => task.id))
  const stone = archiveNearMiss(
    {
      generation: record.generation,
      hypothesis: record.hypothesis,
      verdict: record.verdict,
      reason: record.reason,
      sandboxRoot: sandbox.root,
      changedFiles: record.changedFiles,
      base: sandbox.base,
      shownQuality: meanGainOver(record.baseline, record.candidate, shownIds),
      gainedShown: record.generalization?.gainedShown ?? [],
    },
    EVOLUTION_DIR,
  )
  if (stone) writeSubStep(`kept as stepping stone ${stone.id} [${stone.area} → ${stone.target}] — a later generation can build on it`)
}

async function attemptGeneration(
  generation: number,
  baseline: Metrics,
  options: EvolveOptions,
  tasks: BenchTask[],
  evidence: TaskOutcome[],
  baselineOutcomes: TaskOutcome[],
  split: TaskSplit,
  onCandidateCard: (card: Scorecard) => void,
  onStarted: (base: GenerationRecord) => void,
  onSandbox: (sandbox: Sandbox) => void = () => {},
): Promise<GenerationRecord> {
  const startedAt = Date.now()
  const strategy = pickStrategy()
  const base: GenerationRecord = {
    generation,
    at: Date.now(),
    strategyId: strategy.id,
    hypothesis: '',
    rationale: '',
    targetFiles: [],
    changedFiles: [],
    baseline,
    verdict: 'error',
    reason: '',
    model: config.model,
  }
  // Hand the caller the live record, so an attempt that throws is still
  // reported at the stage it reached.
  onStarted(base)

  writePhase('propose', `generation ${generation}`)
  const sandbox = createSandbox(generation)
  onSandbox(sandbox)

  // --- Hypothesise ----------------------------------------------------------

  const capture = createHypothesisTool()

  // The proposer is briefed on the shown half only. `baseline` itself stays
  // whole — it is what the candidate is compared against, and thinning that
  // would change the verdict rather than the prompt.
  const shownBaseline = blindMetrics(baseline, split, halfMetrics(baselineOutcomes, split.train).passRate)
  const shownEvidence = blindEvidence(evidence, split)
  // And it reads only what it was briefed on: its own source copy and the kept
  // runs of the failures it was shown. With unrestricted reads the ledger and
  // bench history — which list every held-out result — were one read_file
  // away, which is the per-task channel isolation requirement I2 closes.
  const readOnly = sealedReadTools(
    allWorkerTools().filter((tool) => ['read_file', 'list_files', 'grep'].includes(tool.name)),
    [sandbox.root, ...shownEvidence.flatMap((outcome) => (outcome.keptDir ? [outcome.keptDir] : []))],
  )
  const messages: ConversationMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: hypothesisBrief(sandbox, shownBaseline, shownEvidence, split.split ? split.heldOut.map((task) => task.id) : []) }],
    },
  ]

  await runAgentLoop({
    messages,
    systemPrompt: hypothesisPrompt(strategy),
    tools: [...readOnly, capture.tool],
    onText: writeText,
    useAnimation: true,
    verbose: true,
    maxSteps: HYPOTHESIS_MAX_STEPS,
    signal: options.signal,
    // One hypothesis is the whole output; nothing after it is used.
    finishAfterTool: 'submit_hypothesis',
  })

  const hypothesis = capture.taken()
  if (!hypothesis) {
    return { ...base, reason: 'the model never submitted a hypothesis' }
  }

  Object.assign(base, {
    funnel: 'proposed',
    hypothesis: hypothesis.title,
    rationale: hypothesis.rationale,
    targetFiles: hypothesis.targetFiles,
  })

  writeBlock(
    `Generation ${generation} hypothesis`,
    `  ${hypothesis.title}\n\n  Why: ${hypothesis.rationale}\n  Files: ${hypothesis.targetFiles.join(', ') || '(unspecified)'}\n\n  Plan: ${hypothesis.plan}${hypothesis.buildOn ? `\n\n  Builds on: ${hypothesis.buildOn}` : ''}`,
  )

  // Start from a stepping stone when the proposer asked to. Only files whose
  // base is unchanged are laid in, so a stale stone cannot undo newer work.
  if (hypothesis.buildOn) {
    const stone = elites(readArchive(EVOLUTION_DIR)).find((entry) => entry.id === hypothesis.buildOn)
    if (!stone) {
      writeSubStep(`stepping stone ${hypothesis.buildOn} is not in the archive — building from the current source`)
    } else {
      const applied = applySteppingStone(stone, EVOLUTION_DIR, sandbox.root, sandbox.base)
      writeSubStep(`built on ${stone.id}: ${applied.applied.length} file(s) laid in${applied.stale.length > 0 ? `, ${applied.stale.length} skipped as stale (${applied.stale.join(', ')})` : ''}`)
    }
  }

  // --- Implement it inside the sandbox --------------------------------------

  writePhase('execute', `applying it in ${sandbox.root}`)
  await runSubAgent({
    role: 'builder',
    name: `builder#gen${generation}`,
    prompt: implementationBrief(sandbox, hypothesis),
    signal: options.signal,
    tools: candidateTools(sandbox.root, allWorkerTools()),
  })

  // --- Gate -----------------------------------------------------------------

  writePhase('verify', `generation ${generation}`)

  const changed = changedFiles(sandbox)
  base.changedFiles = changed
  if (changed.length > 0) base.diffDigest = diffDigest(sandbox.root, changed)

  if (changed.length === 0) {
    return { ...base, reason: 'the builder changed nothing' }
  }
  writeSubStep(`changed ${changed.length} file${changed.length === 1 ? '' : 's'}`)
  base.funnel = 'built'
  if (machineReadable) emitEvent('candidate_changes', { generation, files: changed, description: describeChanges(sandbox, changed) })
  else process.stdout.write(`${describeChanges(sandbox, changed)}\n`)

  const violations = violatedImmutables(changed)
  if (violations.length > 0) {
    // Not treated as a bug to fix — the attempt is void, because a candidate that
    // edits the benchmark cannot be meaningfully scored by it.
    writeFail(`touched the fitness gate itself: ${violations.join(', ')}`)
    return {
      ...base,
      verdict: 'rejected',
      reason: `modified files it is not allowed to change (${violations.join(', ')}) — the benchmark cannot score a candidate that edits the benchmark`,
    }
  }

  const typecheck = await runShell('bun run typecheck', GATE_TIMEOUT_MS, sandbox.root)
  if (typecheck.exitCode !== 0) {
    if (looksUnavailable(typecheck.stderr)) {
      writeSubStep('typecheck unavailable in the sandbox — skipping that gate')
    } else {
      writeFail('typecheck failed')
      return {
        ...base,
        verdict: 'rejected',
        reason: `does not typecheck:\n${clampOutput(typecheck.stdout || typecheck.stderr, 800)}`,
      }
    }
  } else {
    writePass('typecheck')
  }
  base.funnel = 'compiled'

  const unitTests = await runShell('bun test', GATE_TIMEOUT_MS, sandbox.root)
  if (unitTests.exitCode !== 0) {
    // A failing file has to fail again on its own before it rejects. Generation
    // 7 of the first run here — shorter descriptions for three tools — was
    // turned away by presentation.test.ts, which the change never touched,
    // timing out at 151s on a machine running a benchmark beside it. A file
    // the candidate really broke fails again; a list that cannot be read, or a
    // retry that fails, keeps the rejection.
    const files = failingTestFiles(`${unitTests.stdout}\n${unitTests.stderr}`)
    const retry = files.length > 0 ? await runShell(`bun test ${files.map((file) => `'${file}'`).join(' ')}`, GATE_TIMEOUT_MS, sandbox.root) : undefined
    if (retry?.exitCode !== 0) {
      writeFail('unit tests failed')
      const output = retry ? `${retry.stderr || retry.stdout}` : `${unitTests.stderr || unitTests.stdout}`
      return {
        ...base,
        verdict: 'rejected',
        reason: `unit tests fail${retry ? ' (and again when re-run on their own)' : ''}:\n${clampOutput(output, 800)}`,
      }
    }
    writeSubStep(`${files.join(', ')} failed in the full run and passed on their own — a flake, not this change`)
  }
  writePass('unit tests')
  base.funnel = 'tested'

  // Cheaper by owning fewer tools is not cheaper: no benchmark task calls most
  // of them, so the loss would never show up in a score (toolSurface.ts).
  // Checked before the benchmark, so a candidate that does it costs no runs.
  const [liveSurface, candidateSurface] = await Promise.all([toolNamesIn(ELIA_ROOT, options.signal), toolNamesIn(sandbox.root, options.signal)])
  if (!liveSurface || !candidateSurface) {
    const reason = 'could not read the tools each tree gives its agent — refusing to measure a candidate that may have dropped some'
    writeFail(`rejected: ${reason}`)
    return { ...base, verdict: 'rejected', reason }
  }
  const dropped = removedTools(liveSurface, candidateSurface)
  if (dropped.length > 0) {
    const reason = `removed tools the agent is given (${dropped.join(', ')}) — a capability no benchmark task uses is still a capability; describe a tool in fewer tokens instead of taking it away`
    writeFail(`rejected: ${reason}`)
    return { ...base, verdict: 'rejected', reason }
  }

  // --- Measure the candidate, using the candidate ---------------------------

  // Race for the verdict rather than buying the whole scoreboard: the tasks this
  // diff cannot reach keep their baseline rows, and the run stops the moment a
  // regression has already decided the answer. Same rule, same arithmetic, far
  // fewer model calls — see sieve.ts. `ELIA_SIEVE=off` restores the full sweep.
  writeSubStep('running the benchmark against the candidate')
  let candidateCard: Scorecard
  let comparison: Comparison
  let evidenceCost: EvidenceCost | undefined
  let ranTaskIds: string[] = []
  // The baseline as the race compared it: pooled, when a retest settled an
  // apparent regression (sieve.ts), so the recorded verdicts use the same numbers.
  let comparedBaseline = baseline
  const onBenchTask = (outcome: TaskOutcome) =>
    outcome.passed ? writePass(`${outcome.taskId} — ${outcome.detail}`) : writeFail(`${outcome.taskId} — ${outcome.error ?? outcome.detail}`)

  try {
    if (sieveEnabled()) {
      const race = await raceCandidate({
        sourceRoot: sandbox.root,
        tasks,
        baseline,
        baselineOutcomes,
        changedFiles: changed,
        concurrency: benchConcurrency(),
        ...(options.signal ? { signal: options.signal } : {}),
        onTaskDone: onBenchTask,
      })
      candidateCard = race.card
      comparison = race.comparison
      if (race.baseline) comparedBaseline = race.baseline
      ranTaskIds = race.ran
      evidenceCost = {
        tasksRun: race.ran.length,
        tasksCarried: race.carried.length,
        tasksSkipped: race.skipped.length,
        tasksTotal: tasks.length,
        tokens: race.tokens,
        msToVerdict: race.elapsedMs,
        ...(race.settledBy ? { settledBy: race.settledBy } : {}),
      }
      writeSubStep(renderRace(race, tasks.length))
    } else {
      candidateCard = await measureFitness({ sourceRoot: sandbox.root, tasks, onTaskDone: onBenchTask })
      comparison = compareScorecards(baseline, toMetrics(candidateCard))
      ranTaskIds = candidateCard.outcomes.map((outcome) => outcome.taskId)
      evidenceCost = {
        tasksRun: candidateCard.outcomes.length,
        tasksCarried: 0,
        tasksSkipped: 0,
        tasksTotal: tasks.length,
        tokens: candidateCard.totalTokens,
        msToVerdict: candidateCard.wallClockMs,
      }
    }
  } catch (err) {
    return { ...base, reason: `benchmark could not run: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (machineReadable) emitEvent('benchmark_scorecard', { stage: 'candidate', generation, scorecard: candidateCard })
  else if (!quietOutput) process.stdout.write(renderScorecard(candidateCard, `Generation ${generation}`))

  const candidate = toMetrics(candidateCard)
  base.candidate = candidate
  base.evidenceCost = evidenceCost
  base.funnel = 'measured'
  // Recorded for every generation, not only the promoted ones: a rejected
  // candidate that gained on a held-out task is a near-miss worth knowing
  // about, and the ledger is where the next generation reads its history.
  base.generalization = classifyGeneralization({
    baselineOutcomes,
    candidateOutcomes: candidateCard.outcomes,
    split,
    ranTaskIds,
    realChange: REAL_CHANGE,
  })
  writeSubStep(renderGeneralization(base.generalization))
  onCandidateCard(candidateCard)

  // The paper's sealed verdict on the same measurement: an anytime-valid test
  // with a lifetime false-acceptance budget (acceptance.ts). Recorded on
  // every measured generation; `ELIA_EVOLVE_GATE` decides whether it, the
  // legacy rule, or both make the call.
  const gate = gateMode()
  const comparisonIndex = readLedger().filter((record) => record.candidate).length + 1
  const sealed = sealedCompare(comparedBaseline, candidate, { index: comparisonIndex })
  base.sealed = sealedRecord(sealed, gate)
  writeSubStep(`sealed gate (${gate === 'legacy' ? 'recorded only' : 'deciding'}): ${sealed.bit} — ${sealed.reason}`)
  const decisionReason = gate === 'sealed' ? sealed.reason : comparison.reason
  if (!gateDecision(gate, comparison.better, sealed)) {
    const reason = gate === 'both' && comparison.better ? sealed.reason : decisionReason
    writeFail(`rejected: ${reason}`)
    writeSubStep(`sandbox kept at ${sandbox.root} if you want to look`)
    return { ...base, verdict: 'rejected', reason }
  }

  base.funnel = 'better'

  // Model-driven benchmarks are stochastic. A single baseline/candidate pair
  // can manufacture an efficiency "win" from sampling variance, so a provisional
  // winner must reproduce its result independently before it can touch live code.
  // Reverse the order on confirmation to avoid consistently favoring the second run.
  writeSubStep('provisional win — running an independent confirmation pair')
  let confirmationCandidateCard = await measureFitness({ sourceRoot: sandbox.root, tasks })
  let confirmationBaselineCard = await measureFitness({ sourceRoot: ELIA_ROOT, tasks })
  // Two fresh sweeps of a coin-flip task disagree by half their attempts about
  // one time in nine; an apparent regression is re-run on both trees and the
  // pair judged on pooled attempts (sieve.ts settleRegressions).
  const apparent = regressionsIn(toMetrics(confirmationBaselineCard), confirmationCandidateCard.outcomes)
  if (apparent.length > 0) {
    writeSubStep(`${apparent.join(', ')} fell on the confirmation run — re-running it on both trees before it counts`)
    const settled = await settleRegressions({
      regressed: apparent,
      tasks,
      candidateRoot: sandbox.root,
      candidateRows: confirmationCandidateCard.outcomes,
      baselineRows: confirmationBaselineCard.outcomes,
    })
    confirmationCandidateCard = cardFromOutcomes(sandbox.root, tasks, settled.candidateRows, confirmationCandidateCard.wallClockMs)
    confirmationBaselineCard = cardFromOutcomes(ELIA_ROOT, tasks, settled.baselineRows, confirmationBaselineCard.wallClockMs)
  }
  const confirmationBaseline = toMetrics(confirmationBaselineCard)
  const confirmationCandidate = toMetrics(confirmationCandidateCard)
  const confirmation = compareScorecards(confirmationBaseline, confirmationCandidate)
  // Same comparison, same spent level: requiring both measurements to clear it
  // can only lower the false-acceptance rate.
  const sealedConfirmation = sealedCompare(confirmationBaseline, confirmationCandidate, { index: comparisonIndex })

  if (!gateDecision(gate, confirmation.better, sealedConfirmation)) {
    const why = gate === 'sealed' || (gate === 'both' && confirmation.better) ? sealedConfirmation.reason : confirmation.reason
    const reason = `provisional improvement did not reproduce: ${why}`
    writeFail(`rejected: ${reason}`)
    writeSubStep(`sandbox kept at ${sandbox.root} if you want to inspect it`)
    return { ...base, baseline: confirmationBaseline, candidate: confirmationCandidate, verdict: 'rejected', reason }
  }

  base.baseline = confirmationBaseline
  base.candidate = confirmationCandidate
  base.funnel = 'confirmed'

  // The confirmation pair measured every task on both trees. That is a fuller
  // picture of the candidate than the raced card, so it — not the race — becomes
  // what the next generation treats as its baseline rows and its failure evidence.
  onCandidateCard(confirmationCandidateCard)

  // A benchmark win is not sufficient to promote.
  //
  // `src/gap/guard.ts` says in its own doc comment that "any path that would
  // train or rewrite a generator on the strength of 'the verifier said it was
  // fine' — Loop 2 distillation, `elia evolve` promotion — calls this first."
  // That was true of distillation and false here: evolve promoted on
  // `compareScorecards` alone. It is the more dangerous of the two loops, since
  // it may rewrite the planner, the loop policy, the reviewers, and the critic's
  // own prompt — everything outside IMMUTABLE_FILES. A candidate that scores
  // better because it stopped noticing its own mistakes is exactly what the
  // benchmark cannot see and what these two checks exist to catch.
  //
  // Both are measured by running each tree's own code, never in-process: an
  // in-process check scores the live installation whatever the sandbox holds,
  // which is how the distillation gate's copy of this check sat inert.
  writeSubStep('checking the verifier did not get worse')
  const candidateGap = await gapVectorIn(sandbox.root, options.signal)
  const baselineGap = await gapVectorIn(ELIA_ROOT, options.signal)
  if (!candidateGap || !baselineGap) {
    const reason = 'could not measure the generator–verifier gap — refusing to promote unverified'
    writeFail(`rejected: ${reason}`)
    writeSubStep(`sandbox kept at ${sandbox.root} if you want to inspect it`)
    return { ...base, verdict: 'rejected', reason }
  }
  const gapGuard = checkGapNotRegressed(baselineGap, candidateGap)
  if (!gapGuard.ok) {
    const reason = `the verifier got worse: ${gapGuard.regressions.join('; ')}`
    writeFail(`rejected: ${reason}`)
    writeSubStep(`sandbox kept at ${sandbox.root} if you want to inspect it`)
    return { ...base, verdict: 'rejected', reason }
  }

  writeSubStep('checking the values did not move')
  const candidateProbes = await valueProbesIn(sandbox.root, { signal: options.signal })
  const baselineProbes = await valueProbesIn(ELIA_ROOT, { signal: options.signal })
  if (!candidateProbes || !baselineProbes) {
    const reason = 'could not run the value probes — refusing to promote unverified'
    writeFail(`rejected: ${reason}`)
    writeSubStep(`sandbox kept at ${sandbox.root} if you want to inspect it`)
    return { ...base, verdict: 'rejected', reason }
  }
  let valueGuard = checkValueDrift(baselineProbes, candidateProbes)
  if (!valueGuard.ok) {
    // One judged sample per probe flips on identical code, so a drift has to
    // happen again before it rejects (values/drift.ts confirmValueDrift). A
    // retest that cannot run leaves the first verdict standing.
    writeSubStep(`value drift on one sample (${valueGuard.regressions.join('; ')}) — asking the candidate ${VALUE_RETESTS} more times before it counts`)
    const retests: NonNullable<Awaited<ReturnType<typeof valueProbesIn>>>[] = []
    for (let index = 0; index < VALUE_RETESTS; index++) {
      const retest = await valueProbesIn(sandbox.root, { signal: options.signal })
      if (!retest) break
      retests.push(retest)
    }
    if (retests.length === VALUE_RETESTS) valueGuard = confirmValueDrift(baselineProbes, candidateProbes, retests)
    if (valueGuard.ok) writeSubStep('the drift did not happen again — noise, not a change in values')
  }
  if (!valueGuard.ok) {
    const reason = `value drift: ${valueGuard.regressions.join('; ')}`
    writeFail(`rejected: ${reason}`)
    writeSubStep(`sandbox kept at ${sandbox.root} if you want to inspect it`)
    return { ...base, verdict: 'rejected', reason }
  }
  recordProbeRun(candidateProbes, `evolve-gen-${generation}`)
  base.funnel = 'guarded'

  const confirmedReason = `${decisionReason}; confirmed independently (${gate === 'sealed' ? sealedConfirmation.reason : confirmation.reason}); verifier and values held`

  if (options.dryRun) {
    writePass(`would promote: ${confirmedReason}`)
    writeSubStep('dry run — the live source was not modified')
    return { ...base, verdict: 'rejected', reason: `dry run; would have been promoted (${confirmedReason})` }
  }

  if (options.promoteTo === 'branch') {
    const branch = `evolve/gen-${generation}-${new Date(startedAt).toISOString().slice(0, 10)}`
    try {
      const commit = await promoteToBranch(
        sandbox,
        changed,
        branch,
        `evolve(gen ${generation}): ${hypothesis.title}

${confirmedReason}

Proposed and proven by \`elia evolve\`; nothing was changed in the working tree.`,
      )
      removeSandbox(sandbox)
      writePass(`promoted to branch ${branch}: ${confirmedReason}`)
      return { ...base, funnel: 'promoted', verdict: 'promoted', reason: confirmedReason, branch, commit }
    } catch (error) {
      const reason = error instanceof LiveTreeConflict ? error.message : `could not commit the candidate: ${error instanceof Error ? error.message : String(error)}`
      writeFail(`rejected: ${reason}`)
      writeSubStep(`sandbox kept at ${sandbox.root} if you want to inspect it`)
      return { ...base, verdict: 'rejected', reason }
    }
  }

  let backupDir: string
  try {
    backupDir = promote(sandbox, changed)
  } catch (error) {
    if (!(error instanceof LiveTreeConflict)) throw error
    writeFail(`rejected: ${error.message}`)
    writeSubStep(`sandbox kept at ${sandbox.root} if you want to inspect it`)
    return { ...base, verdict: 'rejected', reason: error.message }
  }
  // The live tree now has the change and the backup holds what it replaced;
  // the full source copy has nothing left to offer, so don't keep it around.
  removeSandbox(sandbox)
  writePass(`promoted: ${confirmedReason}`)
  writeSummary(`Generation ${generation} promoted`, [
    ['change', hypothesis.title],
    ['files', changed.join(', ')],
    ['pass rate', `${Math.round(baseline.passRate * 100)}% → ${Math.round(candidate.passRate * 100)}%`],
    ['tokens', `${baseline.totalTokens} → ${candidate.totalTokens}`],
    ['took', formatElapsed(Date.now() - startedAt)],
    ['rollback', `copy ${backupDir} back over ${ELIA_ROOT}`],
  ])

  return { ...base, funnel: 'promoted', verdict: 'promoted', reason: confirmedReason }
}

/**
 * The proposer's instructions. The frame — what this phase produces and the
 * honesty requirement — is fixed here; the "how to choose" guidance in the
 * middle is the current search strategy, which the loop itself rewrites and
 * puts on trial (strategy.ts).
 */
export function hypothesisPrompt(strategy: Strategy = incumbentStrategy()): string {
  return `You are elia, examining your own source code in order to improve yourself.

You have read-only tools. This phase produces exactly one thing: a single, specific, testable hypothesis about what change to your own implementation would make you measurably better at the benchmark, submitted with \`submit_hypothesis\`.

How to choose well (search strategy ${strategy.id}):
${strategy.text}

Be honest about mechanism. "Improve the prompt to be clearer" is not a hypothesis; "the precise-edit task fails because the system prompt never tells the model to re-read a file after editing it, so it cannot notice it matched the wrong occurrence" is.`
}

/** How many failing tasks' details go into the brief — enough to pick from, not a transcript dump. */
const MAX_EVIDENCE_TASKS = 8
/** Traces are the long part of the brief, and every proposer step re-sends it. */
const MAX_TRACED_TASKS = 4

export function renderFailureEvidence(evidence: TaskOutcome[]): string {
  if (evidence.length === 0) return ''
  const lines = evidence.slice(0, MAX_EVIDENCE_TASKS).map((outcome, index) => {
    const bits = [`- ${outcome.taskId} (${outcome.steps} steps${outcome.stopReason ? `, stopped: ${outcome.stopReason}` : ''}): ${outcome.error ?? outcome.detail}`]
    if (outcome.keptDir) bits.push(`  its final state is kept at ${outcome.keptDir} — read it to see what the agent actually did`)
    if (outcome.trace && index < MAX_TRACED_TASKS) {
      bits.push(`  what the agent did on a failing attempt:\n${outcome.trace.split('\n').map((line) => `    ${line}`).join('\n')}`)
    }
    return bits.join('\n')
  })
  const more = evidence.length > MAX_EVIDENCE_TASKS ? `\n(${evidence.length - MAX_EVIDENCE_TASKS} more not shown)` : ''
  return `\n\n## Why the failing tasks failed
This is your best evidence. A task in the hist-* family is a real commit from elia's own history; its prompt is the failing test files.
${lines.join('\n')}${more}`
}

export function hypothesisBrief(sandbox: Sandbox, baseline: Metrics, evidence: TaskOutcome[] = [], heldOutIds: string[] = []): string {
  const failing = baseline.failed.length > 0 ? baseline.failed.join(', ') : '(none — everything currently passes)'

  return `## Your own source
It is copied at: ${sandbox.root}
Read it there (that copy is what will be modified). The structure mirrors the real installation at ${ELIA_ROOT}.

## How you are scored
The benchmark is in src/evolve/suite.ts — read it, it defines exactly what "better" means. Each task runs a real agent loop in a temporary repository and is checked by code, not by a model.

Current weighted pass rate: ${Math.round(baseline.passRate * 100)}%
Passing: ${baseline.passed.join(', ') || '(none)'}
FAILING: ${failing}
Observed model steps: ${baseline.steps ? Object.entries(baseline.steps).map(([id, steps]) => `${id}=${steps}`).join(', ') : '(not recorded)'}
Cost of one full run: ${baseline.totalTokens} tokens, ${Math.round(baseline.totalElapsedMs / 1000)}s of agent time.${renderFailureEvidence(evidence)}${fieldEvidenceSection()}
${winningRuleSection(baseline)}
${tokenCostSection()}

## What you may not change
These files define how you are judged or enforce deterministic safety boundaries, and editing them is an automatic rejection:
${IMMUTABLE_FILES.map((file) => `- ${file}`).join('\n')}

Improving your score by changing the benchmark or weakening a safety boundary is not improvement. Do not attempt it.
${measurableSection(baseline)}

## What has already been tried
${redactHeldOut(renderLedgerForPrompt(), heldOutIds)}${redactHeldOut(renderSteppingStones(elites(readArchive(EVOLUTION_DIR))), heldOutIds)}

Investigate, then submit exactly one hypothesis.`
}

/**
 * The test files `bun test` reported a failure in: each file's results follow
 * a `path.test.ts:` line, and a failure is a `(fail)` line under it. Paths are
 * kept only when they look like a test file inside the tree, since they go
 * back onto a command line.
 */
export function failingTestFiles(output: string): string[] {
  const files = new Set<string>()
  let current: string | undefined
  for (const line of output.split(/\r?\n/)) {
    const header = /^([\w./@-]+\.test\.[cm]?[jt]sx?):\s*$/.exec(line.trim())
    if (header) current = header[1]
    else if (line.trim().startsWith('(fail)') && current && !current.startsWith('/') && !current.includes('..')) files.add(current)
  }
  return [...files].sort()
}

/**
 * The rule a candidate is judged by, stated where the proposer reads it.
 *
 * The brief used to point at suite.ts for what "better" means, but the tasks
 * only say what passes; the rule that turns two scorecards into a verdict is
 * `compareScorecards`, which the proposer was never shown. The first run on
 * this machine had every shown task passing, so the one way left to win was
 * efficiency — and both of its proposals added text to the system prompt,
 * which every model call pays for.
 */
export function winningRuleSection(baseline: Metrics): string {
  const rates: Record<string, number> = baseline.taskRates ?? Object.fromEntries([...baseline.passed.map((id) => [id, 1]), ...baseline.failed.map((id) => [id, 0])])
  const headroom = Object.values(rates).some((rate) => rate < 1)
  return `
## How a candidate wins
Each task runs several times; its score is the fraction that passed, and it only counts as moving when that changes by at least half its attempts.
- Any task that falls by that much rejects the candidate, whatever else improved.
- A task that rises by that much, with no regression, wins.
- Otherwise the pass rate is a tie, and the candidate wins only by using at least 5% fewer tokens (without taking 5% longer), or at least 5% less time (without using 5% more tokens).
- A provisional win is measured again, in full, on both trees; it must win again.
${headroom ? '' : '\nEvery task you are shown passes every attempt, so a tie is the best a correctness change can do here: efficiency is the way to win.\n'}`
}

/**
 * What every model call pays before the conversation starts, measured from this
 * tree's own prompt and tool definitions (about four characters to a token).
 *
 * Measured on 2026-09-24: about 3.6k tokens of system prompt and 14k of
 * definitions for 50 tools went out on every step of every task — about 80% of
 * a step's input, for tools like github, browser and finance that no coding
 * task calls. The proposer could not see that, and aimed elsewhere.
 */
export function tokenCostSection(
  prompt = DEV_SYSTEM_PROMPT,
  tools: Pick<Tool, 'name' | 'description' | 'input_schema'>[] = allWorkerTools(),
  owners: Record<string, string> = toolOwners(ELIA_ROOT),
): string {
  const tokens = (chars: number) => Math.round(chars / 4)
  const sizes = tools.map((tool) => {
    const file = owners[tool.name]
    return { name: tool.name, file, locked: file ? isImmutablePath(file) : false, chars: JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.input_schema }).length }
  })
  const toolChars = sizes.reduce((sum, tool) => sum + tool.chars, 0)
  const editable = sizes.filter((tool) => tool.file && !tool.locked)
  const editableChars = editable.reduce((sum, tool) => sum + tool.chars, 0)
  const largest = [...editable].sort((a, b) => b.chars - a.chars).slice(0, 10)
  const locked = sizes.filter((tool) => tool.locked).map((tool) => tool.name)
  const share = Math.round((toolChars / (toolChars + prompt.length)) * 100)
  return `
## Where the tokens go
Every model call sends, before any conversation: the system prompt (src/config.ts DEV_SYSTEM_PROMPT, about ${tokens(prompt.length)} tokens) and the definitions of ${tools.length} tools (about ${tokens(toolChars)} tokens, ${share}% of that fixed cost). A task takes several calls, so this is paid again on every step.
Of those definitions, about ${tokens(editableChars)} tokens are in files you may change. Largest of those: ${largest.map((tool) => `${tool.name} ~${tokens(tool.chars)} (${tool.file})`).join(', ')}.${locked.length > 0 ? `
Locked (safety boundaries you may not edit): ${locked.join(', ')}.` : ''}
A definition is its description and its input schema, property descriptions included. One tool's worth is about one percent of a call; a saving the benchmark can see has to be several times that.
Making elia cheaper is a real improvement. Removing a tool, or putting it out of reach, is not: it is a capability loss the benchmark cannot see, and it is not an acceptable way to win. Every tool must stay usable by a task that needs it.`
}

/**
 * Which source file defines each tool: the first file under src/ with a
 * `name: '…'` literal followed by its `description`. A heuristic, good enough to tell the
 * proposer which definitions it may edit; a tool it cannot place is simply not
 * listed as editable.
 */
export function toolOwners(root: string): Record<string, string> {
  const owners: Record<string, string> = {}
  const walk = (relative: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(join(root, relative))
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      const path = `${relative}/${entry}`
      try {
        if (statSync(join(root, path)).isDirectory()) walk(path)
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
          // A definition, not a mention: the name is followed by its description.
          for (const match of readFileSync(join(root, path), 'utf8').matchAll(/\bname:\s*['"]([a-z][a-z0-9_]*)['"],?\s*description\s*:/g)) owners[match[1]!] ??= path
        }
      } catch {
        // An unreadable file owns nothing.
      }
    }
  }
  walk('src/tools')
  walk('src')
  return owners
}

/**
 * Which parts of the tree the benchmark can actually see.
 *
 * Read from what the tasks were observed to load, so it is a fact rather than a
 * rule, and omitted entirely until something has been recorded — an empty list
 * would read as "nothing is measurable" and stop the search dead.
 */
function measurableSection(baseline: Metrics): string {
  const taskIds = [...baseline.passed, ...baseline.failed]
  if (!hasReachEvidence(taskIds)) return ''
  const areas = measurableAreas()
  if (areas.length === 0) return ''
  return `
## What the benchmark can see
Every task run so far loaded code from these areas, and only these:
${areas.map((area) => `- ${area}`).join('\n')}

A change confined to anything else cannot move a score — it will be measured as inert and rejected without a task being run. If you want to improve something the benchmark cannot see, say so in your rationale and propose it anyway; it will be rejected, but the ledger will carry the reason.`
}

function implementationBrief(sandbox: Sandbox, hypothesis: Hypothesis): string {
  return `Implement this one change to elia's own source, in the copy at ${sandbox.root}.

## The change
${hypothesis.title}

## Why
${hypothesis.rationale}

## The plan
${hypothesis.plan}

## Expected files
${hypothesis.targetFiles.map((file) => `- ${file}`).join('\n') || '(the plan does not name specific files)'}

## Rules
- Work ONLY inside ${sandbox.root}. Never touch ${ELIA_ROOT} — that is the live installation.
- Implement exactly this change. Nothing else. Unrelated edits will cause the whole generation to be rejected even if your change was good.
- Do NOT modify any of these, at all: ${IMMUTABLE_FILES.join(', ')}. They define how the change is judged or enforce a deterministic safety boundary.
- Do not run git commands.
- The change must typecheck (\`bun run typecheck\`) and keep the existing tests passing (\`bun test\`). Run both yourself before you finish, from inside ${sandbox.root}.

Report what you changed and why it should move the benchmark.`
}

interface HypothesisCapture {
  tool: Tool
  taken(): Hypothesis | undefined
}

function createHypothesisTool(): HypothesisCapture {
  let captured: Hypothesis | undefined

  const tool: Tool = {
    name: 'submit_hypothesis',
    description:
      'Submit the single change you want to make to elia\'s own source, then stop. Call this exactly once. It must name the benchmark task it is expected to improve and explain the mechanism by which it does so.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The change itself, in one line' },
        rationale: {
          type: 'string',
          description:
            'The mechanism: what currently goes wrong, in which task, and why this change fixes that specifically',
        },
        targetFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repo-relative files you intend to modify, e.g. "src/config.ts"',
        },
        plan: { type: 'string', description: 'Concretely what to change in those files' },
        buildOn: {
          type: 'string',
          description: 'Optional: the id of a stepping stone from the brief (e.g. "gen-12") to start from. Its files are laid into your copy first; the plan is the next step on top of it.',
        },
      },
      required: ['title', 'rationale', 'plan'],
    },
    async execute(input) {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : ''
      const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
      if (!title || !rationale || !plan) throw new Error('title, rationale, and plan are all required')

      const targetFiles = Array.isArray(input.targetFiles)
        ? input.targetFiles.filter((file): file is string => typeof file === 'string')
        : []

      const forbidden = targetFiles.filter((file) => isImmutablePath(file))
      if (forbidden.length > 0) {
        throw new Error(
          `${forbidden.join(', ')} define evaluation, safety boundaries, or what elia is for, and cannot be changed. Propose a different hypothesis that improves the agent without changing the benchmark, safety controls, or value core.`,
        )
      }

      const buildOn = typeof input.buildOn === 'string' && input.buildOn.trim() ? input.buildOn.trim() : undefined
      captured = { title, rationale, targetFiles, plan, ...(buildOn ? { buildOn } : {}) }
      return 'Hypothesis recorded. Stop now — implementation happens in a separate step.'
    },
  }

  return {
    tool,
    taken() {
      const hypothesis = captured
      captured = undefined
      return hypothesis
    },
  }
}

function sealedRecord(verdict: SealedVerdict, mode: string): NonNullable<GenerationRecord['sealed']> {
  return {
    bit: verdict.bit,
    eValue: verdict.eValue,
    needed: verdict.needed,
    meanDiff: verdict.meanDiff,
    n: verdict.n,
    minimumDetectable: verdict.minimumDetectable,
    mode,
  }
}

/** Distinguishes "the gate found a real problem" from "the gate could not run at all". */
function looksUnavailable(stderr: string): boolean {
  return /not found|command not found|ENOENT|Cannot find module/i.test(stderr)
}

/** Reads elia's own package version, for reporting. */
export function eliaVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(ELIA_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
