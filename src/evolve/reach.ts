import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { stateDir } from '../statePaths.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'

/**
 * Which of elia's own modules each benchmark task actually loads.
 *
 * The self-improvement loop's whole cost is measurement: scoring one candidate
 * means running every benchmark task against a model, and most of that spend
 * buys nothing. A candidate that edits `src/tools/webSearch.ts` cannot change
 * the outcome of a task that never loads that file — yet the loop runs it
 * anyway, pays for it, and gets back the number it already had. Two generations
 * in a month is what that costs (see `elia compounding`, stage 3).
 *
 * So record the truth instead of guessing it. A Bun preload plugin
 * (`reachRecorder.ts`) sits in front of the module loader in every benchmark
 * child process and writes down each source file that was actually loaded. The
 * recording is free — it rides along on runs the loop is already paying for —
 * and it is *exact* at module granularity: a file that was never loaded never
 * executed.
 *
 * The direction of the error matters. A module that loaded may still not have
 * run the changed line, so "reachable" over-approximates — which is the safe
 * side: a task is only ever *skipped* when its recorded set proves the changed
 * file was never loaded at all. And because the model can steer a run down a
 * path an earlier run did not take, sets are **unioned across runs and never
 * shrink**: every observation can only widen what a task is assumed to touch.
 * A task with no record at all counts as reachable by everything.
 */

/**
 * `ELIA_REACH_PATH` redirects the map, so a run that is exercising the machinery
 * rather than measuring elia — a scripted provider, a fixture — cannot seed the
 * real one. A recording is only as good as the run it came from, and the map is
 * a union that never shrinks: a thin set written once stays written.
 */
export const REACH_PATH = process.env.ELIA_REACH_PATH || join(stateDir, 'bench', 'reach.json')

/** Environment variable the recorder reads for where to write its list. */
export const REACH_OUT_ENV = 'ELIA_REACH_OUT'

export interface TaskReach {
  /** Source files, relative to the tree that ran, with forward slashes. */
  modules: string[]
  /** Runs folded into this set, so a thin record can be told from a settled one. */
  runs: number
  at: number
}

export type ReachMap = Record<string, TaskReach>

export function readReach(path = REACH_PATH): ReachMap {
  if (!existsSync(path)) return {}
  try {
    hardenSecureFile(path)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReachMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // A corrupt map costs pruning, not correctness: every task reads as unknown,
    // and an unknown task is always run.
    return {}
  }
}

/** Normalise one loaded path into a repo-relative module id, or undefined if it is not our source. */
export function moduleId(loaded: string, sourceRoot: string): string | undefined {
  if (!loaded) return undefined
  const rel = isAbsolute(loaded) ? relative(sourceRoot, loaded) : loaded
  if (!rel || rel.startsWith('..')) return undefined
  const posix = rel.replace(/\\/g, '/')
  if (posix.includes('node_modules/')) return undefined
  return posix
}

/**
 * Fold one run's loaded modules into the stored map.
 *
 * Union, never replace: see the note above about model-dependent paths. Returns
 * the merged record so callers can report on it without a second read.
 */
export function recordReach(taskId: string, modules: string[], path = REACH_PATH): TaskReach {
  const map = readReach(path)
  const previous = map[taskId]
  const merged = [...new Set([...(previous?.modules ?? []), ...modules])].sort()
  const record: TaskReach = { modules: merged, runs: (previous?.runs ?? 0) + 1, at: Date.now() }
  map[taskId] = record
  try {
    ensureSecureDirectory(dirname(path))
    writeSecureFile(path, `${JSON.stringify(map, null, 2)}\n`)
  } catch {
    // Losing a recording costs the next candidate some pruning, not this run.
  }
  return record
}

/** Read a recorder's output file and fold it in. Never throws. */
export function absorbReachFile(taskId: string, outFile: string, sourceRoot: string, path = REACH_PATH): void {
  try {
    if (!existsSync(outFile)) return
    const modules = readFileSync(outFile, 'utf8')
      .split('\n')
      .map((line) => moduleId(line.trim(), sourceRoot))
      .filter((id): id is string => Boolean(id))
    if (modules.length > 0) recordReach(taskId, modules, path)
  } catch {
    // Same bargain as recordReach.
  }
}

export interface Relevance {
  /** Tasks whose recorded modules include a changed file, plus every task with no record. */
  relevant: string[]
  /** Tasks proven not to load any changed file — their outcome is the baseline's. */
  inert: string[]
  /** Of `relevant`, the ones that are only there because nothing was ever recorded for them. */
  unknown: string[]
}

/**
 * Split a task set by whether this diff can possibly move it.
 *
 * Fails open in every direction that matters: no record, no changed files, or an
 * unreadable map all put a task in `relevant`, where it gets measured as before.
 */
export function relevantTasks(changedFiles: string[], taskIds: string[], map: ReachMap = readReach()): Relevance {
  const changed = new Set(changedFiles.map((file) => file.replace(/\\/g, '/')))
  const relevant: string[] = []
  const inert: string[] = []
  const unknown: string[] = []

  for (const id of taskIds) {
    const record = map[id]
    if (!record || record.modules.length === 0) {
      relevant.push(id)
      unknown.push(id)
      continue
    }
    if (changed.size === 0 || record.modules.some((module) => changed.has(module))) relevant.push(id)
    else inert.push(id)
  }

  return { relevant, inert, unknown }
}

/**
 * How much of this diff each task carries — the ordering signal for racing.
 *
 * A task that loads three of the four changed files is likelier to be the one
 * that breaks than a task that loads one, so it is worth running first: the
 * verdict for a candidate that regresses anywhere is "rejected" whatever the
 * rest say, so the cheapest search is the one that finds the regression soonest.
 */
export function overlap(taskId: string, changedFiles: string[], map: ReachMap = readReach()): number {
  const record = map[taskId]
  if (!record) return 0
  const changed = new Set(changedFiles.map((file) => file.replace(/\\/g, '/')))
  return record.modules.filter((module) => changed.has(module)).length
}

/** One line for a status report: how much of the benchmark has a recording yet. */
export function reachCoverage(taskIds: string[], map: ReachMap = readReach()): { recorded: number; total: number } {
  return { recorded: taskIds.filter((id) => (map[id]?.modules.length ?? 0) > 0).length, total: taskIds.length }
}

/**
 * The files the benchmark has ever been observed to load, as a directory-level
 * summary the proposer can act on.
 *
 * Half of elia's source has never been loaded by a benchmark task — the terminal
 * UI, the autonomous loop, the collaborative workspace. A hypothesis that only
 * touches those cannot move a score, however good it is, and the loop used to
 * spend a full sweep finding that out. Telling the proposer up front is the
 * cheap half of the same insight: it stops a generation being spent on a change
 * nothing can see.
 *
 * Reported as directories rather than files because the list is hundreds long
 * and the proposer needs a shape, not an index.
 */
export function measurableAreas(map: ReachMap = readReach(), depth = 2): string[] {
  const areas = new Set<string>()
  for (const record of Object.values(map)) {
    for (const module of record.modules) {
      const parts = module.split('/')
      areas.add(parts.length <= depth ? module : parts.slice(0, depth).join('/'))
    }
  }
  return [...areas].sort()
}

/** True once there is enough recorded for `measurableAreas` to be worth showing. */
export function hasReachEvidence(taskIds: string[], map: ReachMap = readReach()): boolean {
  return reachCoverage(taskIds, map).recorded > 0
}
