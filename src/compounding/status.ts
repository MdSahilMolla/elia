import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../statePaths.ts'
import { appendSecureFile } from '../securePersistence.ts'
import { readTrajectories } from '../trajectory/record.ts'
import { learningRate, readLedger, type GenerationRecord } from '../evolve/ledger.ts'
import { lessonTrials } from '../autonomy/lessonEfficacy.ts'
import { readContributions } from '../github/contribute.ts'
import { recursionSignal, renderRecursion } from './recursion.ts'
import { evidenceVelocity } from './velocity.ts'
import type { Scorecard } from '../evolve/fitness.ts'

/**
 * Where elia is on the road to compounding, read off its own ledgers.
 *
 * Six stages, each one fuel for the next: record what happened, check it for
 * real, turn checked work into a change, prove the change helps on a benchmark
 * that can still move, know which remembered lessons help, and finally show that
 * a gain makes the next gain easier — the improver improving, with no weights
 * involved. Every line is computed from files elia
 * writes anyway — nothing here is a claim, and a stage with no evidence says so.
 */

export type StageState = 'working' | 'partial' | 'blocked' | 'no evidence'

export interface StageReport {
  stage: number
  name: string
  state: StageState
  evidence: string
  next?: string
}

export interface BenchRecord {
  at: number
  /** Which task set was run: synthetic, history, or all. */
  set: string
  tasks: number
  passRate: number
  unmeasured: number
  model: string
  /** Tasks that ran and failed — absent on records written before this existed. */
  failed?: string[]
  /** Tasks that ran and passed. */
  passed?: string[]
}

export const BENCH_HISTORY_PATH = join(stateDir, 'bench', 'history.ndjson')

/** Remember a benchmark score, so headroom is a recorded fact rather than a guess. Never throws. */
export function recordBenchRun(card: Scorecard, set: string, path = BENCH_HISTORY_PATH): void {
  try {
    const record: BenchRecord = {
      at: Date.now(),
      set,
      tasks: card.outcomes.length,
      passRate: card.passRate,
      unmeasured: card.unmeasured.length,
      model: card.model,
      failed: card.outcomes.filter((outcome) => !outcome.passed && !outcome.unmeasured).map((outcome) => outcome.taskId),
      passed: card.outcomes.filter((outcome) => outcome.passed).map((outcome) => outcome.taskId),
    }
    appendSecureFile(path, `${JSON.stringify(record)}\n`)
  } catch {
    // A lost score costs a data point, not the run.
  }
}

export function readBenchRuns(path = BENCH_HISTORY_PATH): BenchRecord[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as BenchRecord]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/**
 * Whether the generations that scored better did so where they could see the
 * failure, or where they could not.
 *
 * A pass rate that went up is not the same claim as an agent that got better —
 * `split.ts` exists because the proposer is handed every failing task's error
 * and can write to it. This reads back what actually happened, and says nothing
 * at all on records written before the corpus was split rather than guessing.
 */
function generalizationNote(ledger: GenerationRecord[]): string {
  const scored = ledger.filter((record) => record.generalization && record.generalization.verdict !== 'not-split')
  if (scored.length === 0) return ''
  const generalized = scored.filter((record) => record.generalization!.verdict === 'generalized').length
  const shownOnly = scored.filter((record) => record.generalization!.verdict === 'shown-only').length
  if (generalized === 0 && shownOnly === 0) return `; none of ${scored.length} scored generation(s) moved a task either way`
  return `; of ${scored.length} scored generation(s), ${generalized} gained on tasks it was never shown, ${shownOnly} only where it was`
}

/** A benchmark this close to perfect can only reward cheaper, not better. */
const SATURATED = 0.95

export function benchStage(runs: BenchRecord[]): StageReport {
  const name = 'Benchmark with room to improve'
  const last = [...runs].reverse().find((run) => run.set === 'all')
  if (!last) {
    return { stage: 4, name, state: 'no evidence', evidence: 'no full benchmark run recorded', next: 'run `elia bench --all`' }
  }
  const score = `${Math.round(last.passRate * 100)}% of ${last.tasks - last.unmeasured} measured task(s) on ${last.model || 'unknown model'}, ${new Date(last.at).toISOString().slice(0, 10)}`
  if (last.unmeasured > 0) {
    return { stage: 4, name, state: 'blocked', evidence: `${score}; ${last.unmeasured} task(s) unmeasured`, next: 'fix what stopped them (provider credit, stale tasks), then re-run `elia bench --all`' }
  }
  if (last.passRate >= SATURATED) {
    return { stage: 4, name, state: 'partial', evidence: `${score} — saturated`, next: 'harvest harder tasks: `elia bench --harvest --scan 600 --limit 60`' }
  }
  return { stage: 4, name, state: 'working', evidence: `${score} — ${Math.round((1 - last.passRate) * 100)} points of headroom` }
}

/**
 * The task ids `elia evolve --focus N` scores on: every built-in task (they are
 * the regression guards), every history task the last complete full run saw
 * fail (the headroom), and the first `passingHistory` history tasks it saw pass
 * (so a candidate cannot buy a fix by breaking real work). Undefined when there
 * is no complete full run to focus from.
 */
export function focusTaskIds(builtInIds: string[], passingHistory: number, runs = readBenchRuns()): string[] | undefined {
  const last = [...runs].reverse().find((run) => run.set === 'all' && run.unmeasured === 0 && run.failed && run.passed)
  if (!last) return undefined
  const history = (ids: string[]) => ids.filter((id) => !builtInIds.includes(id))
  return [...new Set([...builtInIds, ...history(last.failed!), ...history(last.passed!).slice(0, passingHistory)])]
}

export interface LessonStoreEffect {
  set: string
  without: number
  with: number
  /** Tasks that passed only with lessons, and only without. */
  gained: string[]
  lost: string[]
}

/**
 * The lesson store as a whole, measured on the benchmark: the latest complete
 * run of a task set without lessons against the latest complete run of the same
 * set with them (`elia bench --lessons`). Undefined until both exist.
 */
export function lessonStoreEffect(runs: BenchRecord[]): LessonStoreEffect | undefined {
  const complete = runs.filter((run) => run.unmeasured === 0 && run.passed)
  for (const withRun of [...complete].reverse()) {
    if (!withRun.set.endsWith('+lessons')) continue
    const set = withRun.set.slice(0, -'+lessons'.length)
    const withoutRun = [...complete].reverse().find((run) => run.set === set)
    if (!withoutRun) continue
    return {
      set,
      without: withoutRun.passRate,
      with: withRun.passRate,
      gained: withRun.passed!.filter((id) => !withoutRun.passed!.includes(id)),
      lost: withoutRun.passed!.filter((id) => !withRun.passed!.includes(id)),
    }
  }
  return undefined
}

/** Merged external pull requests, for stage 2's evidence line. Empty when there are none. */
function mergedUpstreamNote(): string {
  const merged = readContributions().filter((row) => row.status === 'merged')
  if (merged.length === 0) return ''
  const repos = [...new Set(merged.map((row) => row.slug))]
  return `; ${merged.length} change(s) accepted upstream by maintainers of ${repos.slice(0, 3).join(', ')}${repos.length > 3 ? ` and ${repos.length - 3} more` : ''}`
}

export function compoundingStatus(): StageReport[] {
  const interactive = readTrajectories('interactive')
  const autonomous = readTrajectories('autonomous')
  const rows = [...interactive, ...autonomous]
  const checked = rows.filter((row) => row.verify === 'pass' && row.regime !== 'judgment').length

  const ledger = readLedger()
  const promoted = ledger.filter((record) => record.verdict === 'promoted').length
  const lastGen = ledger.at(-1)

  const trials = [...lessonTrials().values()]
  const helps = trials.filter((trial) => trial.verdict === 'helps').length
  const hurts = trials.filter((trial) => trial.verdict === 'hurts').length

  const learning = learningRate(ledger)
  const recursion = recursionSignal(ledger)
  const velocity = evidenceVelocity(ledger)
  const benchRuns = readBenchRuns()
  const storeEffect = lessonStoreEffect(benchRuns)

  return [
    {
      stage: 1,
      name: 'Record experience',
      state: rows.length > 0 ? 'working' : 'no evidence',
      evidence: `${interactive.length} interactive turn(s), ${autonomous.length} autonomous run(s) recorded`,
    },
    {
      stage: 2,
      name: 'Check that experience',
      state: rows.length === 0 ? 'no evidence' : checked / rows.length >= 0.5 ? 'working' : 'partial',
      // A maintainer merging a patch into a repository elia does not own is the
      // hardest check in these records: an outside party with no stake in elia
      // looking good accepted the work. It is reported, not counted — the state
      // above stays earned by the turn-level checks, because a handful of merged
      // pull requests must not be able to colour a rate computed over thousands
      // of turns.
      evidence: `${checked} of ${rows.length} (${rows.length ? Math.round((checked / rows.length) * 100) : 0}%) passed a check that was not a model's opinion${mergedUpstreamNote()}`,
      next: checked / Math.max(1, rows.length) < 0.5 ? 'more autonomous runs that land; `elia distill --dry-run` lists why runs do not qualify' : undefined,
    },
    {
      stage: 3,
      name: 'Turn checked work into a change',
      state: promoted > 0 ? 'working' : ledger.length > 0 ? 'partial' : 'no evidence',
      evidence: ledger.length === 0
        ? 'evolve has never run'
        : `${ledger.length} evolve generation(s), ${promoted} promoted; last ${new Date(lastGen!.at).toISOString().slice(0, 10)} (${lastGen!.verdict})${generalizationNote(ledger)}`,
      next: promoted === 0 ? 'once stage 4 is measured cleanly: `elia evolve --generations 3`' : undefined,
    },
    benchStage(benchRuns),
    {
      stage: 5,
      name: 'Know which lessons help',
      state: storeEffect && trials.length > 0 ? 'working' : storeEffect || trials.length > 0 ? 'partial' : 'no evidence',
      evidence: [
        storeEffect
          ? `lesson store on the ${storeEffect.set} benchmark: ${Math.round(storeEffect.without * 100)}% without → ${Math.round(storeEffect.with * 100)}% with (gained ${storeEffect.gained.length}, lost ${storeEffect.lost.length})`
          : 'the lesson store has not been benchmarked with and without',
        trials.length === 0
          ? 'no single lesson has a randomized trial yet (holdout gathers them as turns run)'
          : `${trials.length} lesson(s) trialled one by one: ${helps} proven to help, ${hurts} proven to hurt`,
      ].join('; '),
      next: storeEffect ? undefined : 'run `elia bench --all --lessons` after a plain `elia bench --all`',
    },
    {
      stage: 6,
      name: 'Gains improve the improver',
      // Deliberately not moved by evidence velocity. Verdicts getting cheaper is
      // the improver improving — but the first drop came from switching `sieve.ts`
      // on, which is one change by one hand, not the loop compounding on itself.
      // The number is reported below; the stage stays earned by promotions.
      state: recursion.compounding ? 'working' : recursion.promotions > 0 || recursion.trial !== 'no challenger' ? 'partial' : 'no evidence',
      evidence: `${renderRecursion(recursion)}; improvement trend: ${learning.trend}${velocity.all.verdicts > 0 ? `; ${Math.round(velocity.avoided * 100)}% of benchmark task runs avoided per verdict` : ''}`,
      next: recursion.compounding
        ? undefined
        : 'keep `elia evolve --focus N` running: stalls write a new search strategy and trial it; promotions to the loop/roles/tools are tracked for their effect on later search',
    },
  ]
}

export function renderCompoundingStatus(stages: StageReport[]): string {
  const mark: Record<StageState, string> = { working: '●', partial: '◐', blocked: '✕', 'no evidence': '○' }
  const lines = ['Compounding — six stages, read from elia’s own records', '']
  for (const stage of stages) {
    lines.push(`  ${mark[stage.state]} ${stage.stage}. ${stage.name} — ${stage.state}`)
    lines.push(`      ${stage.evidence}`)
    if (stage.next) lines.push(`      next: ${stage.next}`)
  }
  lines.push('', '  ● working   ◐ partial   ✕ blocked   ○ no evidence')
  return lines.join('\n')
}
