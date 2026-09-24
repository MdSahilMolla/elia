import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-baseline-cache-test'

const { MAX_AGE_MS, baselineCacheEnabled, fingerprint, lookupBaselines, measureLiveTree, readBaselineCache, rememberBaselines } = await import('./baselineCache.ts')
const { cardFromOutcomes } = await import('./fitness.ts')
import type { ReachMap } from './reach.ts'
import type { MeasureOptions, Scorecard, TaskOutcome } from './fitness.ts'
import type { BenchTask } from './task.ts'

let dir: string
let root: string
let path: string

const MAP: ReachMap = { t1: { modules: ['src/a.ts', 'src/b.ts'], runs: 2, at: 0 }, t2: { modules: ['src/b.ts'], runs: 1, at: 0 } }

function outcome(taskId: string, over: Partial<TaskOutcome> = {}): TaskOutcome {
  return { taskId, weight: 1, passed: true, detail: 'ok', steps: 2, elapsedMs: 100, totalTokens: 500, model: 'm', ...over }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-baseline-cache-'))
  root = join(dir, 'tree')
  path = join(dir, 'cache.json')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('it is on unless switched off', () => {
  const before = process.env.ELIA_BASELINE_CACHE
  try {
    delete process.env.ELIA_BASELINE_CACHE
    expect(baselineCacheEnabled()).toBe(true)
    process.env.ELIA_BASELINE_CACHE = 'off'
    expect(baselineCacheEnabled()).toBe(false)
    process.env.ELIA_BASELINE_CACHE = 'on'
    expect(baselineCacheEnabled()).toBe(true)
  } finally {
    if (before === undefined) delete process.env.ELIA_BASELINE_CACHE
    else process.env.ELIA_BASELINE_CACHE = before
  }
})

test('with nothing recorded it serves nothing, so turning it on changes nothing yet', () => {
  // The safety of defaulting this on rests here: a task with no reach record has
  // no fingerprint, so it can never be a hit, however full the cache file is.
  rememberBaselines([outcome('t1')], root, 'm', { map: MAP, path })
  const found = lookupBaselines(['t1'], root, 'm', { map: {}, cache: readBaselineCache(path) })
  expect(found.hits).toEqual([])
  expect(found.misses).toEqual(['t1'])
})

test('a task with no recording has no fingerprint, and so can never be served from cache', () => {
  expect(fingerprint('never-run', root, 'm', MAP)).toBeUndefined()
  expect(fingerprint('t1', root, 'm', MAP)).toBeTruthy()
})

test('the fingerprint moves when the code the task loads moves', () => {
  const before = fingerprint('t1', root, 'm', MAP)
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2 // changed\n')
  expect(fingerprint('t1', root, 'm', MAP)).not.toBe(before)
})

test('the fingerprint does not move for a file the task never loads', () => {
  const before = fingerprint('t2', root, 'm', MAP)
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 3 // t2 never loads this\n')
  expect(fingerprint('t2', root, 'm', MAP)).toBe(before)
})

test('the model is part of the key', () => {
  expect(fingerprint('t1', root, 'mercury-2.5', MAP)).not.toBe(fingerprint('t1', root, 'other-model', MAP))
})

test('a remembered outcome comes back while its code is untouched', () => {
  rememberBaselines([outcome('t1')], root, 'm', { map: MAP, path })
  const cache = readBaselineCache(path)
  expect(Object.keys(cache)).toEqual(['t1'])

  const found = lookupBaselines(['t1'], root, 'm', { map: MAP, cache })
  expect(found.misses).toEqual([])
  expect(found.hits[0]!.taskId).toBe('t1')
  expect(found.hits[0]!.detail).toContain('cached baseline')
})

test('an edit to the task\'s own code is a miss', () => {
  rememberBaselines([outcome('t1')], root, 'm', { map: MAP, path })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 99\n')
  expect(lookupBaselines(['t1'], root, 'm', { map: MAP, cache: readBaselineCache(path) }).misses).toEqual(['t1'])
})

test('a stale entry is a miss', () => {
  rememberBaselines([outcome('t1')], root, 'm', { map: MAP, path, now: 1_000 })
  const cache = readBaselineCache(path)
  expect(lookupBaselines(['t1'], root, 'm', { map: MAP, cache, now: 1_000 + MAX_AGE_MS + 1 }).misses).toEqual(['t1'])
})

test('a provider failure is never remembered, and never served', () => {
  // Caching an unmeasured row would freeze one bad afternoon into every run for
  // a week, and `compareScorecards` refuses to compare against it anyway.
  rememberBaselines([outcome('t1', { unmeasured: true, passed: false })], root, 'm', { map: MAP, path })
  expect(readBaselineCache(path).t1).toBeUndefined()
})

test('the evidence directory of the run that produced it is not remembered', () => {
  rememberBaselines([outcome('t1', { keptDir: '/somewhere/that/will/be/deleted' })], root, 'm', { map: MAP, path })
  expect(readBaselineCache(path).t1!.outcome.keptDir).toBeUndefined()
})

test('a missing module invalidates rather than hashing around it', () => {
  rememberBaselines([outcome('t1')], root, 'm', { map: MAP, path })
  rmSync(join(root, 'src', 'a.ts'))
  expect(fingerprint('t1', root, 'm', MAP)).toBeUndefined()
  expect(lookupBaselines(['t1'], root, 'm', { map: MAP, cache: readBaselineCache(path) }).misses).toEqual(['t1'])
})

test('a file edited and put back is a hit again — the key is the contents', () => {
  // Timestamps would say this file changed twice. The tasks would be re-measured
  // for nothing, which on a paid model is the whole cost this cache exists to
  // avoid.
  rememberBaselines([outcome('t1')], root, 'm', { map: MAP, path })
  const original = 'export const a = 1\n'
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2\n')
  expect(lookupBaselines(['t1'], root, 'm', { map: MAP, cache: readBaselineCache(path) }).hits).toEqual([])
  writeFileSync(join(root, 'src', 'a.ts'), original)
  expect(lookupBaselines(['t1'], root, 'm', { map: MAP, cache: readBaselineCache(path) }).hits.length).toBe(1)
})

const TASKS = [{ id: 't1', weight: 1 }, { id: 't2', weight: 1 }] as BenchTask[]

/** Stands in for `measureFitness`: runs the given tasks in order, or stops dead after `stopAfter` of them. */
function fakeMeasure(ran: string[], stopAfter = Infinity) {
  return async (options: MeasureOptions): Promise<Scorecard> => {
    const outcomes: TaskOutcome[] = []
    for (const task of options.tasks ?? []) {
      if (outcomes.length >= stopAfter) throw new Error('quota ran out')
      ran.push(task.id)
      const result = outcome(task.id)
      outcomes.push(result)
      options.onTaskDone?.(result)
    }
    return cardFromOutcomes(options.sourceRoot, options.tasks ?? [], outcomes, 1)
  }
}

test('a sweep that dies partway keeps what it measured, and the next one only runs the rest', async () => {
  // The first full benchmark on this machine got through half its tasks before
  // the provider's quota ended it, and kept none of them: results were only
  // written once the whole sweep returned, so every attempt restarted at zero.
  const first: string[] = []
  await expect(measureLiveTree({ tasks: TASKS, sourceRoot: root, model: 'm', map: MAP, path, measure: fakeMeasure(first, 1) })).rejects.toThrow('quota')
  expect(first).toEqual(['t1'])
  expect(Object.keys(readBaselineCache(path))).toEqual(['t1'])

  const second: string[] = []
  const { card, reused } = await measureLiveTree({ tasks: TASKS, sourceRoot: root, model: 'm', map: MAP, path, measure: fakeMeasure(second) })
  expect(second).toEqual(['t2'])
  expect(reused).toBe(1)
  expect(card.outcomes.map((row) => row.taskId)).toEqual(['t1', 't2'])
  expect(card.unmeasured).toEqual([])
  expect(card.passRate).toBe(1)
})

test('reuse can be refused, and what is re-measured is still remembered', async () => {
  rememberBaselines([outcome('t1', { passed: false, detail: 'old' })], root, 'm', { map: MAP, path })
  const ran: string[] = []
  const { reused } = await measureLiveTree({ tasks: TASKS, sourceRoot: root, model: 'm', map: MAP, path, reuse: false, measure: fakeMeasure(ran) })
  expect(ran).toEqual(['t1', 't2'])
  expect(reused).toBe(0)
  expect(readBaselineCache(path).t1!.outcome.passed).toBe(true)
})

test('another model reuses nothing from this one', async () => {
  await measureLiveTree({ tasks: TASKS, sourceRoot: root, model: 'm', map: MAP, path, measure: fakeMeasure([]) })
  const ran: string[] = []
  const { reused } = await measureLiveTree({ tasks: TASKS, sourceRoot: root, model: 'other', map: MAP, path, measure: fakeMeasure(ran) })
  expect(reused).toBe(0)
  expect(ran).toEqual(['t1', 't2'])
})

test('with the cache off it only measures, and writes nothing', async () => {
  const before = process.env.ELIA_BASELINE_CACHE
  process.env.ELIA_BASELINE_CACHE = 'off'
  try {
    const ran: string[] = []
    const { reused } = await measureLiveTree({ tasks: TASKS, sourceRoot: root, model: 'm', map: MAP, path, measure: fakeMeasure(ran) })
    expect(ran).toEqual(['t1', 't2'])
    expect(reused).toBe(0)
    expect(readBaselineCache(path)).toEqual({})
  } finally {
    if (before === undefined) delete process.env.ELIA_BASELINE_CACHE
    else process.env.ELIA_BASELINE_CACHE = before
  }
})

test('a failure served from cache still carries what the agent did', () => {
  // Its directory is gone by then — it lived in the temp dir, and its path is
  // not kept — so the trace is the only evidence the proposer has left.
  rememberBaselines([outcome('t1', { passed: false, keptDir: '/tmp/gone', trace: '1. run_command … → ok' })], root, 'm', { map: MAP, path })
  const [hit] = lookupBaselines(['t1'], root, 'm', { map: MAP, cache: readBaselineCache(path) }).hits
  expect(hit!.keptDir).toBeUndefined()
  expect(hit!.trace).toBe('1. run_command … → ok')
})
