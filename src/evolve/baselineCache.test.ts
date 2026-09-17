import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-baseline-cache-test'

const { MAX_AGE_MS, baselineCacheEnabled, fingerprint, lookupBaselines, readBaselineCache, rememberBaselines } = await import('./baselineCache.ts')
import type { ReachMap } from './reach.ts'
import type { TaskOutcome } from './fitness.ts'

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
