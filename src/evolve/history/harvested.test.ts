import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { growHarvest, harvestedFileFor, mergeTasks, readHarvested, TASKS_FILE, type HarvestOptions, type HarvestResult } from './harvest.ts'
import { loadTaskSpecs, resetTaskSpecCache } from './suite.ts'
import type { HistoryTaskSpec } from './types.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-harvested-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function spec(sha: string): HistoryTaskSpec {
  return {
    id: `hist-${sha.slice(0, 7)}`,
    sha,
    parent: `${sha}-parent`,
    subject: `work ${sha}`,
    testFiles: ['src/x.test.ts'],
    sourceFiles: ['src/x.ts'],
    verifyCommand: 'bun test --timeout=20000 src/x.test.ts',
    evidence: { failingBefore: 1, passingAfter: 3 },
    weight: 2,
  }
}

/** A stand-in for `harvest` that proves whatever it is offered from a fixed pool, recording what it was told to skip. */
function fakeHarvest(pool: { sha: string; ok: boolean; reason?: string }[], seen: Array<ReadonlySet<string>>) {
  return async (options: HarvestOptions = {}): Promise<HarvestResult> => {
    const skip = options.skip ?? new Set<string>()
    seen.push(skip)
    const offered = pool.filter((entry) => !skip.has(entry.sha))
    return {
      tasks: offered.filter((entry) => entry.ok).map((entry) => spec(entry.sha)),
      rejected: offered.filter((entry) => !entry.ok).map((entry) => ({ sha: entry.sha, subject: '', reason: entry.reason ?? 'tests already pass on the parent tree' })),
      considered: offered.length,
    }
  }
}

test('growing the benchmark appends proven tasks to state, never re-proves, and forgets timeouts', async () => {
  const file = join(dir, '.evolution', 'harvested-tasks.json')
  const seen: Array<ReadonlySet<string>> = []
  const pool = [
    { sha: 'aaaaaaa1', ok: true },
    { sha: 'bbbbbbb2', ok: true },
    { sha: 'ccccccc3', ok: false },
    { sha: 'ddddddd4', ok: false, reason: 'tests timed out on the parent tree' },
    { sha: 'eeeeeee5', ok: true },
  ]
  const run = fakeHarvest(pool, seen)

  // A tracked task is never re-proved.
  const first = await growHarvest({ tracked: [spec('eeeeeee5')], file, run, now: 1 })
  expect(first.added.map((task) => task.sha)).toEqual(['aaaaaaa1', 'bbbbbbb2'])
  expect(seen[0]!.has('eeeeeee5')).toBe(true)
  expect(readHarvested(file).tasks).toHaveLength(2)
  // The lasting refusal is remembered; the timeout is not, because it may pass next time.
  expect(readHarvested(file).rejected.map((entry) => entry.sha)).toEqual(['ccccccc3'])

  const second = await growHarvest({ tracked: [spec('eeeeeee5')], file, run, now: 2 })
  expect(second.added).toEqual([])
  expect(second.considered).toBe(1) // only the timed-out commit is offered again
  expect(second.harvested).toBe(2)
})

test('nothing proved and nothing refused writes nothing', async () => {
  const file = join(dir, 'harvested.json')
  await growHarvest({ tracked: [], file, run: fakeHarvest([], []) })
  expect(existsSync(file)).toBe(false)
})

test('the harvested file is found from an evolve sandbox, so a candidate is measured on the baseline\'s tasks', () => {
  const live = join(dir, 'live')
  const sandbox = join(live, '.evolution', 'gen-7')
  mkdirSync(sandbox, { recursive: true })
  const env = { NODE_ENV: 'production' }
  expect(harvestedFileFor(live, env)).toBeUndefined()

  const file = join(live, '.evolution', 'harvested-tasks.json')
  writeFileSync(file, JSON.stringify({ tasks: [spec('aaaaaaa1')], rejected: [] }))
  expect(harvestedFileFor(live, env)).toBe(file)
  expect(harvestedFileFor(sandbox, env)).toBe(file)
  // A root that is not inside `.evolution` does not look above itself.
  expect(harvestedFileFor(join(dir, 'elsewhere'), env)).toBeUndefined()
  // Under bun test the benchmark is the tracked set; an explicit path or `off` wins over both.
  expect(harvestedFileFor(live, { NODE_ENV: 'test' })).toBeUndefined()
  expect(harvestedFileFor(live, { ELIA_HARVESTED_TASKS: 'off' })).toBeUndefined()
  expect(harvestedFileFor(live, { NODE_ENV: 'test', ELIA_HARVESTED_TASKS: file })).toBe(file)
})

test('a corrupt harvested file adds no tasks', () => {
  const file = join(dir, 'bad.json')
  writeFileSync(file, '{not json')
  expect(readHarvested(file)).toEqual({ tasks: [], rejected: [] })
  writeFileSync(file, JSON.stringify({ tasks: [{ nope: true }, spec('aaaaaaa1')], rejected: 'x' }))
  expect(readHarvested(file).tasks.map((task) => task.sha)).toEqual(['aaaaaaa1'])
  expect(readHarvested(file).rejected).toEqual([])
})

test('the benchmark loads the tracked tasks plus the harvested ones, without duplicates', () => {
  const tracked = JSON.parse(readFileSync(TASKS_FILE, 'utf8')) as HistoryTaskSpec[]
  const file = join(dir, 'harvested.json')
  writeFileSync(file, JSON.stringify({ tasks: [spec('fffffff6'), tracked[0]!], rejected: [] }))
  const previous = process.env.ELIA_HARVESTED_TASKS
  process.env.ELIA_HARVESTED_TASKS = file
  resetTaskSpecCache()
  try {
    const loaded = loadTaskSpecs()
    expect(loaded).toHaveLength(tracked.length + 1)
    expect(loaded.at(-1)!.id).toBe('hist-fffffff')
    // A caller pointing at its own file gets exactly that file.
    resetTaskSpecCache()
    const own = join(dir, 'tasks.json')
    writeFileSync(own, JSON.stringify([spec('1111111a')]))
    expect(loadTaskSpecs(own).map((task) => task.sha)).toEqual(['1111111a'])
  } finally {
    if (previous === undefined) delete process.env.ELIA_HARVESTED_TASKS
    else process.env.ELIA_HARVESTED_TASKS = previous
    resetTaskSpecCache()
  }
})

test('a harvest adds to the tracked set instead of replacing it', () => {
  const existing = [spec('aaa1111'), spec('bbb2222')]
  const merged = mergeTasks(existing, [spec('bbb2222'), spec('ccc3333')])
  expect(merged.map((task) => task.id)).toEqual(['hist-aaa1111', 'hist-bbb2222', 'hist-ccc3333'])
})
