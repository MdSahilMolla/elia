import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from '../statePaths.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'
import { readReach, type ReachMap } from './reach.ts'
import { cardFromOutcomes, measureFitness, type MeasureOptions, type Scorecard, type TaskOutcome } from './fitness.ts'
import type { BenchTask } from './suite.ts'

/**
 * The baseline, remembered between runs.
 *
 * `elia evolve` opens by measuring the live tree — a full benchmark sweep, paid
 * for before a single hypothesis exists. Across a month of invocations that is
 * most of the money, and almost all of it re-learns a number that has not moved:
 * the ledger shows two generations and no promotions, which means the tree
 * scored at the start of the second run was byte for byte the tree scored at the
 * end of the first.
 *
 * So key the result on what could have changed it. A task's outcome depends on
 * the code that task loads, and `reach.ts` records exactly which modules those
 * are; hash their contents, add the model, and a hit means the same code scored
 * by the same model. Any edit anywhere in a task's footprint misses, and a task
 * with no recording never hits at all.
 *
 * What this cannot rule out is the model itself drifting — a cached pass against
 * a candidate that now flakes reads as a regression. That is the safe direction:
 * it loses a good candidate rather than promoting a bad one, it is bounded by
 * `MAX_AGE_MS`, and nothing is promoted on a cached number in any case. The
 * confirmation pair in `engine.ts` re-measures both trees in full, and this
 * cache is never consulted for it.
 *
 * On by default, off with `ELIA_BASELINE_CACHE=off` — the same shape as the
 * sieve, and for the same reason: the cost it removes is the thing stopping the
 * loop from turning, and it cannot serve a task that has no recorded footprint,
 * so it does nothing at all until the benchmark has been run once.
 */

export const BASELINE_CACHE_PATH = process.env.ELIA_BASELINE_CACHE_PATH || join(stateDir, 'bench', 'baseline-cache.json')

/** A week. Long enough to cover a run of invocations, short enough that provider drift expires. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface CachedBaseline {
  fingerprint: string
  at: number
  outcome: TaskOutcome
}

export type BaselineCache = Record<string, CachedBaseline>

export function baselineCacheEnabled(): boolean {
  return (process.env.ELIA_BASELINE_CACHE ?? '').toLowerCase() !== 'off'
}

export function readBaselineCache(path = BASELINE_CACHE_PATH): BaselineCache {
  if (!existsSync(path)) return {}
  try {
    hardenSecureFile(path)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BaselineCache
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeBaselineCache(cache: BaselineCache, path: string): void {
  try {
    ensureSecureDirectory(dirname(path))
    writeSecureFile(path, `${JSON.stringify(cache, null, 2)}\n`)
  } catch {
    // A cache that cannot be written costs the next run a measurement.
  }
}

/**
 * What a task's result depends on: the model, and the bytes of every module the
 * task has been observed to load.
 *
 * Undefined when there is no recording, which is what stops a task being served
 * from cache on the strength of a footprint nobody has ever measured, and
 * undefined again if any module has vanished.
 *
 * Contents, not timestamps. A footprint is a couple of hundred files and the
 * tasks share nearly all of them, so `memo` reads each one once per sweep and
 * the whole thing costs milliseconds — cheap enough that there is no reason to
 * accept what timestamps get wrong, which is a file edited and put back reading
 * as changed and costing a real benchmark run to find out otherwise.
 */
export function fingerprint(
  taskId: string,
  sourceRoot: string,
  model: string,
  map: ReachMap = readReach(),
  memo: Map<string, string | undefined> = new Map(),
): string | undefined {
  const modules = map[taskId]?.modules
  if (!modules || modules.length === 0) return undefined

  const parts: string[] = [`model=${model}`]
  for (const module of modules) {
    const path = join(sourceRoot, module)
    if (!memo.has(path)) {
      try {
        memo.set(path, `${Bun.hash(readFileSync(path))}`)
      } catch {
        memo.set(path, undefined)
      }
    }
    const hash = memo.get(path)
    if (hash === undefined) return undefined
    parts.push(`${module}:${hash}`)
  }
  return `${Bun.hash(parts.join(String.fromCharCode(10)))}`
}

export interface CacheLookup {
  /** Outcomes served from cache, ready to use as-is. */
  hits: TaskOutcome[]
  /** Task ids with no usable cached outcome — these still have to be measured. */
  misses: string[]
}

export function lookupBaselines(
  taskIds: string[],
  sourceRoot: string,
  model: string,
  options: { map?: ReachMap; cache?: BaselineCache; now?: number } = {},
): CacheLookup {
  const map = options.map ?? readReach()
  const cache = options.cache ?? readBaselineCache()
  const now = options.now ?? Date.now()

  const hits: TaskOutcome[] = []
  const misses: string[] = []
  const memo = new Map<string, string | undefined>()

  for (const id of taskIds) {
    const entry = cache[id]
    const print = fingerprint(id, sourceRoot, model, map, memo)
    if (!entry || !print || entry.fingerprint !== print || now - entry.at > MAX_AGE_MS) {
      misses.push(id)
      continue
    }
    // An unmeasured row is a provider failure, not a result. Serving one from
    // cache would freeze a bad afternoon into every run for a week.
    if (entry.outcome.unmeasured) {
      misses.push(id)
      continue
    }
    hits.push({ ...entry.outcome, detail: `${entry.outcome.detail} (cached baseline)` })
  }

  return { hits, misses }
}

/** Remember these outcomes for next time. Never throws. */
export function rememberBaselines(
  outcomes: TaskOutcome[],
  sourceRoot: string,
  model: string,
  options: { map?: ReachMap; path?: string; now?: number } = {},
): void {
  const map = options.map ?? readReach()
  const path = options.path ?? BASELINE_CACHE_PATH
  const now = options.now ?? Date.now()
  const cache = readBaselineCache(path)

  let changed = false
  const memo = new Map<string, string | undefined>()
  for (const outcome of outcomes) {
    if (outcome.unmeasured) continue
    const print = fingerprint(outcome.taskId, sourceRoot, model, map, memo)
    if (!print) continue
    const { keptDir: _keptDir, ...rest } = outcome
    cache[outcome.taskId] = { fingerprint: print, at: now, outcome: rest }
    changed = true
  }

  if (changed) writeBaselineCache(cache, path)
}

export interface LiveTreeMeasure {
  card: Scorecard
  /** How many of the card's rows were served from cache rather than run. */
  reused: number
}

/**
 * Score the live tree, reusing any task whose own code and model are unchanged
 * since it was last scored, and remembering each new result the moment it lands.
 *
 * The second half is what lets a full sweep finish at all on a quota. A sweep is
 * a few hundred agent runs; a free tier runs out partway through, and a practice
 * run is stopped when the machine sleeps. When results were only written at the
 * end, the first attempt on this machine got through half the tasks and kept
 * none of them — so the next attempt started from zero and ran into the same
 * wall. Kept one at a time, each attempt picks up where the last one stopped.
 *
 * `reuse: false` re-measures every task and still remembers what it finds.
 * With the cache switched off this is `measureFitness`, nothing more.
 */
export async function measureLiveTree(options: {
  tasks: BenchTask[]
  sourceRoot: string
  model: string
  onTaskDone?: (outcome: TaskOutcome) => void
  reuse?: boolean
  map?: ReachMap
  path?: string
  measure?: (options: MeasureOptions) => Promise<Scorecard>
}): Promise<LiveTreeMeasure> {
  const { tasks, sourceRoot, model } = options
  const measure = options.measure ?? measureFitness
  const report = options.onTaskDone ?? (() => {})
  if (!baselineCacheEnabled()) return { card: await measure({ sourceRoot, tasks, onTaskDone: report }), reused: 0 }

  const startedAt = Date.now()
  const ids = tasks.map((task) => task.id)
  const { hits, misses } = options.reuse === false
    ? { hits: [], misses: ids }
    : lookupBaselines(ids, sourceRoot, model, { map: options.map, cache: readBaselineCache(options.path) })
  for (const hit of hits) report(hit)

  const toMeasure = tasks.filter((task) => misses.includes(task.id))
  const measured = toMeasure.length > 0
    ? await measure({
        sourceRoot,
        tasks: toMeasure,
        onTaskDone: (outcome) => {
          rememberBaselines([outcome], sourceRoot, model, { map: options.map, path: options.path })
          report(outcome)
        },
      })
    : undefined

  const byId = new Map([...hits, ...(measured?.outcomes ?? [])].map((outcome) => [outcome.taskId, outcome]))
  const outcomes = ids.flatMap((id) => byId.get(id) ?? [])
  // A card made partly of remembered rows cannot report the wall clock it did
  // not spend, and the whole point is that it did not spend it. The summed task
  // durations are what the tasks cost when they last ran, which is the honest
  // stand-in and the number `compareScorecards` falls back to.
  const wallClockMs = hits.length === 0 ? Date.now() - startedAt : outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0)
  return { card: cardFromOutcomes(sourceRoot, tasks, outcomes, wallClockMs), reused: hits.length }
}
