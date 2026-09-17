import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reach-test'

const { REACH_OUT_ENV, absorbReachFile, moduleId, overlap, reachCoverage, readReach, recordReach, relevantTasks } = await import('./reach.ts')

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-reach-'))
  path = join(dir, 'reach.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('the recorder and the map agree on the environment variable', () => {
  // reachRecorder.ts spells the name out rather than importing it, so that the
  // preload stays dependency-free. This is the thing that keeps them in step.
  const recorder = readFileSync(join(import.meta.dir, 'reachRecorder.ts'), 'utf8')
  expect(recorder).toContain(`process.env.${REACH_OUT_ENV}`)
})

test('a loaded path becomes a repo-relative module id', () => {
  const root = join(dir, 'tree')
  expect(moduleId(join(root, 'src', 'agentLoop.ts'), root)).toBe('src/agentLoop.ts')
  expect(moduleId('src/agentLoop.ts', root)).toBe('src/agentLoop.ts')
})

test('paths outside the tree and inside node_modules are not module ids', () => {
  const root = join(dir, 'tree')
  expect(moduleId(join(dir, 'elsewhere', 'x.ts'), root)).toBeUndefined()
  expect(moduleId(join(root, 'node_modules', 'pkg', 'index.ts'), root)).toBeUndefined()
  expect(moduleId('', root)).toBeUndefined()
})

test('recordings union across runs and never shrink', () => {
  // The model can steer one run down a path another never takes, so a module
  // seen once stays in the set forever. Anything else would let a lucky run
  // shrink a task's footprint and make a real regression look unreachable.
  recordReach('t1', ['src/a.ts', 'src/b.ts'], path)
  recordReach('t1', ['src/b.ts', 'src/c.ts'], path)

  const map = readReach(path)
  expect(map.t1!.modules).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  expect(map.t1!.runs).toBe(2)
})

test('a task that loads a changed file is relevant; one that cannot is inert', () => {
  recordReach('touches', ['src/agentLoop.ts', 'src/tools/edit.ts'], path)
  recordReach('elsewhere', ['src/agentLoop.ts', 'src/tools/webSearch.ts'], path)

  const split = relevantTasks(['src/tools/edit.ts'], ['touches', 'elsewhere'], readReach(path))
  expect(split.relevant).toEqual(['touches'])
  expect(split.inert).toEqual(['elsewhere'])
  expect(split.unknown).toEqual([])
})

test('a task with no recording is relevant to everything', () => {
  // Fail open: never skip a task on the strength of evidence that does not exist.
  recordReach('known', ['src/a.ts'], path)
  const split = relevantTasks(['src/zzz.ts'], ['known', 'never-run'], readReach(path))
  expect(split.relevant).toEqual(['never-run'])
  expect(split.unknown).toEqual(['never-run'])
  expect(split.inert).toEqual(['known'])
})

test('an empty diff leaves every task relevant', () => {
  recordReach('known', ['src/a.ts'], path)
  expect(relevantTasks([], ['known'], readReach(path)).inert).toEqual([])
})

test('windows-style changed paths match forward-slash recordings', () => {
  recordReach('t', ['src/tools/edit.ts'], path)
  const changed = ['src', 'tools', 'edit.ts'].join(String.fromCharCode(92))
  expect(relevantTasks([changed], ['t'], readReach(path)).relevant).toEqual(['t'])
})

test('overlap counts how much of the diff a task carries', () => {
  recordReach('wide', ['src/a.ts', 'src/b.ts', 'src/c.ts'], path)
  recordReach('narrow', ['src/a.ts'], path)
  const map = readReach(path)
  expect(overlap('wide', ['src/a.ts', 'src/b.ts'], map)).toBe(2)
  expect(overlap('narrow', ['src/a.ts', 'src/b.ts'], map)).toBe(1)
  expect(overlap('unknown', ['src/a.ts'], map)).toBe(0)
})

test('a recorder output file folds into the map, normalised', () => {
  const root = join(dir, 'tree')
  const out = join(dir, 'out.txt')
  writeFileSync(out, [join(root, 'src', 'a.ts'), join(root, 'node_modules', 'p', 'i.ts'), ''].join('\n'))
  absorbReachFile('t', out, root, path)
  expect(readReach(path).t!.modules).toEqual(['src/a.ts'])
})

test('a missing or corrupt map costs pruning, not correctness', () => {
  expect(readReach(join(dir, 'nope.json'))).toEqual({})
  writeFileSync(path, 'not json at all')
  expect(readReach(path)).toEqual({})
  // Every task then reads as unknown, and an unknown task is always run.
  expect(relevantTasks(['src/a.ts'], ['t'], readReach(path)).relevant).toEqual(['t'])
})

test('coverage reports how much of the suite has been recorded', () => {
  recordReach('a', ['src/a.ts'], path)
  expect(reachCoverage(['a', 'b', 'c'], readReach(path))).toEqual({ recorded: 1, total: 3 })
})
