import type { Activity, ActivityObservation } from './resourceGovernor.ts'
import type { ActivityResult, ActivityRunner, StateSources } from './round.ts'

/**
 * The hands of the resource governor: what each activity of §10 actually does
 * when a round picks it.
 *
 * Before this, a round could run three of the six activities. The governor's
 * top two picks on elia's own records — synthesise verifiers (R1) and grow the
 * benchmark (R4) — had no runner, so every round skipped past them with "needs a
 * person", and the idle practice loop ran `evolve` regardless, which the same
 * governor ranked last: a benchmark of 54 tasks cannot certify any gain it has
 * headroom for. Algorithm 1 was a plan with nothing to carry it out.
 *
 * One set of runners serves both callers — `elia compounding round`, and the practice
 * run an idle REPL starts (cli/selfImprove.ts) — so what a person can run by
 * hand is exactly what runs by itself. The evolve generation is passed in,
 * because the two callers promote differently.
 *
 * Solving has no runner on purpose. For elia, solving frontier tasks is the
 * person's own requests; the practice benchmark is measurement, not work.
 */

/** Activities that spend model credit whatever they are asked to do. `verify` spends only when allowed to. */
export const PAID_ACTIVITIES: ReadonlySet<Activity> = new Set<Activity>(['compress', 'meta', 'solve'])

/** Algorithm 1's T_audit: a routine audit at most this often. R2 overrides it when the library is at risk. */
export const AUDIT_EVERY_MS = 24 * 60 * 60_000

/** The planted-defect ladder is deterministic; re-measuring it sooner than this learns nothing new. */
export const LADDER_STALE_MS = 7 * 24 * 60 * 60_000

/** Commits scanned, and new tasks proved, per harvest. Each proof is two test runs in a fresh checkout. */
export const HARVEST_SCAN = 400
export const HARVEST_LIMIT = 6

/**
 * `ELIA_HARVEST_SCAN`/`ELIA_HARVEST_LIMIT` bound the commits scanned and the
 * tasks proved in one harvest run. Scanning git history and proving a commit is
 * two test runs in a fresh checkout, so the first run on a deep history is the
 * loop's most expensive no-model step — a person with a slow disk or a quota to
 * protect can cap it this way. Same parsing rule as `benchRepeats`: a positive
 * integer, else the shipped default.
 */
export function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value >= 1 ? value : fallback
}

/** When an activity last ran, from the activity log. */
export function lastRunAt(history: readonly ActivityObservation[], activity: Activity): number | undefined {
  let latest: number | undefined
  for (const observation of history) {
    if (observation.activity !== activity || observation.at === undefined) continue
    if (latest === undefined || observation.at > latest) latest = observation.at
  }
  return latest
}

export function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'moments ago'
  if (minutes < 90) return `${minutes} minute(s) ago`
  const hours = Math.round(ms / 3_600_000)
  return hours < 48 ? `${hours} hour(s) ago` : `${Math.round(hours / 24)} day(s) ago`
}

/** Where a round reads elia's state from. Shared, so `elia compounding frontier` and the practice run see the same numbers. */
export async function gatherSources(cwd = process.cwd()): Promise<StateSources> {
  const { loadAllOutcomes } = await import('../autonomy/outcomes.ts')
  const { readLatestGapVector } = await import('../gap/report.ts')
  const { readCalibrationLog } = await import('../autonomy/calibration.ts')
  const { skillCandidates } = await import('../skills/detector.ts')
  const { readBenchRuns } = await import('./status.ts')
  const { readLedger } = await import('../evolve/ledger.ts')
  const { allBenchTasks } = await import('../evolve/suite.ts')
  const { paths } = await import('../statePaths.ts')
  const lastBench = [...readBenchRuns()].reverse().find((run) => run.set === 'all')
  const gap = readLatestGapVector(cwd)
  // Tasks added since the last full run — harvested, or new to the suite —
  // widen what a generation compares on, and so the gate's power, before any
  // full run has scored them.
  const seen = new Set([...(lastBench?.passed ?? []), ...(lastBench?.failed ?? [])])
  const unbenched = lastBench?.passed ? allBenchTasks().filter((task) => !seen.has(task.id)).length : 0
  return {
    frontier: { outcomes: loadAllOutcomes(), calibration: readCalibrationLog(), ...(gap ? { gap } : {}) },
    exposuresFile: paths.lessonsEfficacy,
    candidates: skillCandidates(),
    ...(lastBench ? { lastBench: { tasks: lastBench.tasks - lastBench.unmeasured + unbenched, passRate: lastBench.passRate, unbenched } } : {}),
    comparisons: readLedger().filter((record) => record.candidate).length,
  }
}

export interface RunnerOptions {
  /** Whether activities that spend model credit may run. */
  spend: boolean
  history: readonly ActivityObservation[]
  /** One evolve generation, as the caller promotes it. */
  meta?: ActivityRunner
  onProgress?: (message: string) => void
  cwd?: string
  now?: number
}

export function createRunners(options: RunnerOptions): Partial<Record<Activity, ActivityRunner>> {
  const now = options.now ?? Date.now()
  const cwd = options.cwd ?? process.cwd()
  const progress = options.onProgress ?? (() => {})

  const runners: Partial<Record<Activity, ActivityRunner>> = {
    // R1 / Phase 0. What a background round can do about verification is
    // measure it: the planted-defect ladder gives α and β for the mechanical and
    // empirical rungs, and the critic rung gives α for judgment when credit may
    // be spent. Checking real turns is the turn gate's job, on every turn.
    verify: async (): Promise<ActivityResult> => {
      const { readLatestGapVector, recordGapVector } = await import('../gap/report.ts')
      const last = readLatestGapVector(cwd)
      const age = last ? now - Date.parse(last.at) : Number.POSITIVE_INFINITY
      // Worth a paid re-run only to add the critic rung — and only once a
      // week: a critic with no provider behind it returns nothing, and asking
      // again every round would re-run the whole ladder for the same nothing.
      const tried = lastRunAt(options.history, 'verify')
      const wantsCritic = options.spend && !(last?.criticVerdicts?.length) && !(tried !== undefined && now - tried < LADDER_STALE_MS)
      if (last && age < LADDER_STALE_MS && !wantsCritic) {
        return { ran: false, cost: 0, detail: `the verifier ladder was measured ${ago(age)} and is deterministic — measuring it again learns nothing` }
      }
      const { computeGapVector } = await import('../gap/scoreboard.ts')
      progress(`measuring the verifier ladder${options.spend ? ', with the critic rung' : ''}…`)
      const vector = await computeGapVector({ cwd, critic: options.spend })
      recordGapVector(vector, cwd)
      const critic = vector.criticVerdicts?.length ? `; critic reviewed ${vector.criticVerdicts.length} judgment defect(s)` : ''
      return {
        ran: true,
        cost: options.spend ? 1 : 0,
        detail: `measured the verifier ladder: ${Math.round(vector.mechanicalCatchRate * 100)}% of planted defects caught, ${Math.round(vector.falsePositiveRate * 100)}% of clean controls wrongly failed${critic}`,
      }
    },

    // R4. No model call: each commit is checked out and its tests run twice, to
    // prove the task fails before the work and passes after it. New tasks go to
    // elia's state, never the tracked task file (see growHarvest).
    harvest: async (): Promise<ActivityResult> => {
      const { growHarvest } = await import('../evolve/history/harvest.ts')
      const { loadTaskSpecs, resetTaskSpecCache } = await import('../evolve/history/suite.ts')
      const scan = envPositiveInt('ELIA_HARVEST_SCAN', HARVEST_SCAN)
      const limit = envPositiveInt('ELIA_HARVEST_LIMIT', HARVEST_LIMIT)
      progress(`proving new benchmark tasks from the last ${scan} commits (no model calls)…`)
      const grown = await growHarvest({ tracked: loadTaskSpecs(), scan, limit, onProgress: progress })
      resetTaskSpecCache()
      if (grown.added.length === 0) {
        return {
          ran: false,
          cost: 0,
          detail: grown.considered === 0 ? 'every recent commit has already been tried' : `none of ${grown.considered} untried commit(s) proved out as a task (${grown.refused} refused)`,
        }
      }
      return {
        ran: true,
        cost: 0,
        detail: `proved ${grown.added.length} new benchmark task(s) from elia's own history (${grown.harvested} harvested in all) — the next generation measures them`,
      }
    },

    // R2 and T_audit. Deterministic and free, but routine audits on a schedule,
    // not every round — otherwise a free audit that always "runs" would take
    // every round and starve the activities below it.
    audit: async (state): Promise<ActivityResult> => {
      const last = lastRunAt(options.history, 'audit')
      const urgent = state.library.auditFirst || state.library.total === 0
      if (!urgent && last !== undefined && now - last < AUDIT_EVERY_MS) {
        return { ran: false, cost: 0, detail: `audited ${ago(now - last)} and nothing is urgent (R2) — next routine audit after ${Math.round(AUDIT_EVERY_MS / 3_600_000)}h` }
      }
      const { retireLessons, loadLessons, lessonKey } = await import('../autonomy/lessons.ts')
      const { backfillLessons } = await import('../autonomy/lessonCertificates.ts')
      const { auditSkills } = await import('../skills/audit.ts')
      const { USER_SKILLS_DIR } = await import('../skills/paths.ts')
      const { loadSkillFile } = await import('../skills/loader.ts')
      const { runProcess } = await import('../shell.ts')
      const { paths } = await import('../statePaths.ts')
      // Lessons older than the library get their certificate first, so the
      // audit sees the whole store and hygiene reaches every lesson.
      const backfilled = backfillLessons(
        loadLessons().map((lesson) => ({ text: lesson.text, key: lesson.key ?? lessonKey(lesson.text), ...(lesson.source ? { source: lesson.source } : {}) })),
        paths.lessons,
      )
      const lessons = retireLessons()
      const skills = await auditSkills({
        skillsDir: USER_SKILLS_DIR,
        runTest: async (file) => (await runProcess({ executable: 'bun', args: ['test', file], timeoutMs: 120_000 })).exitCode === 0,
        toolName: async (file) => {
          const loaded = await loadSkillFile(file)
          return 'tool' in loaded ? loaded.tool.name : undefined
        },
      })
      const detail = `lessons: ${backfilled} newly certified, ${lessons.retired.length} retired, ${lessons.kept} kept${lessons.skippedReason ? ` (${lessons.skippedReason})` : ''}; tools: ${skills.audited} re-checked, ${skills.purged.length} purged`
      // An audit that certified, retired, re-checked and purged nothing did
      // nothing, and saying it ran would let a free no-op take every round:
      // on a fresh store the empty library made it "urgent" forever (#1275).
      if (backfilled === 0 && lessons.retired.length === 0 && skills.audited === 0 && skills.purged.length === 0) {
        return { ran: false, cost: 0, detail: `nothing to audit yet — ${detail}` }
      }
      return { ran: true, cost: 0, detail }
    },

    // R3. Builds a tool for the most valuable habit that is safe to encode.
    compress: async (state): Promise<ActivityResult> => {
      const { compressOnce } = await import('../skills/closure.ts')
      const { synthesizeSkill } = await import('../skills/synthesize.ts')
      const outcome = await compressOnce(state.queue, synthesizeSkill)
      if (!outcome.attempted) return { ran: false, cost: 0, detail: outcome.skipped ?? 'nothing to compress' }
      return { ran: true, cost: 1, detail: `${outcome.attempted}: ${outcome.result?.ok ? 'built' : 'failed'} — ${outcome.result?.detail.split('\n')[0] ?? ''}` }
    },
  }
  if (options.meta) runners.meta = options.meta
  return runners
}
