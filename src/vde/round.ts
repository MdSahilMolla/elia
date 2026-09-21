import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'
import { stateDir } from '../statePaths.ts'
import type { SkillCandidate } from '../skills/detector.ts'
import { estimateFrontier, type FrontierInputs, type FrontierReport } from './frontier.ts'
import { libraryHealth, readLibrary, type LibraryHealth } from './library.ts'
import { growthReport, readExposures, type GrowthReport } from './growth.ts'
import { compressionQueue, type CompressionQueue } from './closure.ts'
import { recommend, type Activity, type ActivityObservation, type BenchPower, type Recommendation } from './governor.ts'
import { sealedMinimumGain } from './acceptance.ts'

/**
 * Algorithm 1 of the paper, one round: read where the engine stands, let the
 * governor pick the activity with the best expected frontier gain per unit
 * cost, run it, and record what it did to Φ.
 *
 *   τ ← FrontierSampler(L, A); z ← Retrieve(τ, L; θ); repeat B: … ;
 *   every T_audit: L.audit(); every T_comp: L.compress(); every T_meta: MetaStep
 *
 * elia's version of the inner loop (sample, check, admit) is its ordinary work
 * — every turn draws samples, every verify gate is the lattice, every lesson and
 * skill goes through admission. What was missing was the outer schedule: the
 * audit, compression and meta steps ran only when someone typed a command, and
 * nothing decided among them. A round is that schedule, made explicit.
 *
 * Activities are injected. The ones that cost nothing (the audit) may run
 * whenever a round runs; the ones that spend model credit run only when the
 * caller says it may spend — provider credit is not something a background
 * schedule gets to use up on its own.
 */

export interface VdeState {
  frontier: FrontierReport
  library: LibraryHealth
  growth: GrowthReport
  queue: CompressionQueue
  bench?: BenchPower
}

export interface StateSources {
  frontier: FrontierInputs
  libraryFile?: string
  exposuresFile: string
  candidates: readonly SkillCandidate[]
  lastBench?: { tasks: number; passRate: number }
  /** How many comparisons the evolve loop has made, for the gate's spent level. */
  comparisons: number
}

export function gatherState(sources: StateSources): VdeState {
  const artifacts = readLibrary(...(sources.libraryFile ? [sources.libraryFile] : []))
  const state: VdeState = {
    frontier: estimateFrontier(sources.frontier),
    library: libraryHealth(artifacts),
    growth: growthReport(readExposures(sources.exposuresFile)),
    queue: compressionQueue(sources.candidates, artifacts),
  }
  if (sources.lastBench && sources.lastBench.tasks > 0) {
    state.bench = {
      tasks: sources.lastBench.tasks,
      passRate: sources.lastBench.passRate,
      minimumDetectable: sealedMinimumGain(sources.lastBench.tasks, sources.comparisons + 1),
    }
  }
  return state
}

export interface ActivityResult {
  /** False when the activity could not run (nothing to do, no credit, refused). */
  ran: boolean
  detail: string
  /** Relative cost actually spent; 0 for deterministic work. */
  cost: number
}

export type ActivityRunner = (state: VdeState) => Promise<ActivityResult>

export interface RoundOptions {
  state: VdeState
  /** Recomputes the state after an activity, so ΔΦ is measured rather than assumed. */
  regather: () => VdeState
  runners: Partial<Record<Activity, ActivityRunner>>
  /** Activities that spend model credit. They run only when `spend` is set. */
  paid: ReadonlySet<Activity>
  spend: boolean
  history?: readonly ActivityObservation[]
  logFile?: string
}

export interface RoundResult {
  plan: Recommendation[]
  ran?: { activity: Activity; result: ActivityResult; deltaPhi: number }
  /** Activities the plan preferred but the round did not run, and why. */
  skipped: Array<{ activity: Activity; reason: string }>
}

export function activityLogPath(dir = join(stateDir, 'vde')): string {
  return join(dir, 'activities.jsonl')
}

export function readActivityLog(path = activityLogPath()): ActivityObservation[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as ActivityObservation
          return typeof record.activity === 'string' ? [record] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export async function runRound(options: RoundOptions): Promise<RoundResult> {
  const plan = recommend(options.state, options.history ?? [])
  const skipped: RoundResult['skipped'] = []
  for (const rec of plan) {
    if (!rec.viable) {
      skipped.push({ activity: rec.activity, reason: rec.why })
      continue
    }
    const runner = options.runners[rec.activity]
    if (!runner) {
      skipped.push({ activity: rec.activity, reason: 'no automatic runner — this one needs a person or a task' })
      continue
    }
    if (options.paid.has(rec.activity) && !options.spend) {
      skipped.push({ activity: rec.activity, reason: 'spends model credit — rerun with --spend to allow it' })
      continue
    }
    const before = options.state.frontier.mass ?? 0
    const result = await runner(options.state)
    if (!result.ran) {
      skipped.push({ activity: rec.activity, reason: result.detail })
      continue
    }
    const after = options.regather().frontier.mass ?? 0
    const deltaPhi = after - before
    try {
      const path = options.logFile ?? activityLogPath()
      ensureSecureDirectory(dirname(path))
      appendSecureFile(path, `${JSON.stringify({ at: Date.now(), activity: rec.activity, deltaPhi, cost: result.cost, detail: result.detail })}\n`)
    } catch {
      // The log is how the governor learns; losing a line costs one observation.
    }
    return { plan, ran: { activity: rec.activity, result, deltaPhi }, skipped }
  }
  return { plan, skipped }
}
