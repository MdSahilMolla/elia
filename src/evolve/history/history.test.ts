import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCounts } from './verifyRun.ts'
import { isCandidateShape, partitionFiles, verifyCommandFor } from './harvest.ts'
import { checkTestsUntouched, promptFor, toBenchTask } from './suite.ts'
import { contentHash } from './materialize.ts'
import type { HistoryTaskSpec } from './types.ts'

const SPEC: HistoryTaskSpec = {
  id: 'hist-abc1234',
  sha: 'abc1234000000000000000000000000000000000',
  parent: 'def5678000000000000000000000000000000000',
  subject: 'Classify why a repair loop is stuck',
  testFiles: ['src/autonomy/stuck.test.ts'],
  sourceFiles: ['src/autonomy/stuck.ts'],
  verifyCommand: 'bun test --timeout=20000 src/autonomy/stuck.test.ts',
  evidence: { failingBefore: 1, passingAfter: 10 },
  weight: 2,
}

test('reads the totals Bun prints, from either stream', () => {
  // Bun writes this summary to stderr, and a run with several files prints a
  // per-file group before the totals.
  expect(parseCounts('bun test v1.3.14\n\n 10 pass\n 0 fail\n 18 expect() calls\n')).toEqual({ pass: 10, fail: 0 })
  expect(parseCounts(' 3 pass\n 1 fail\n\n 12 pass\n 2 fail\n')).toEqual({ pass: 12, fail: 2 })
  expect(parseCounts('no summary here')).toEqual({ pass: 0, fail: 0 })
})

test('parsing the summary is not stateful across calls', () => {
  // The pattern is a module-level /g regex; a leaked lastIndex would make the
  // second identical call disagree with the first.
  const output = ' 7 pass\n 0 fail\n'
  expect(parseCounts(output)).toEqual(parseCounts(output))
})

test('splits a commit into the work and the specification', () => {
  expect(
    partitionFiles(['src/autonomy/stuck.ts', 'src/autonomy/stuck.test.ts', 'docs/notes.md', 'src/ui/App.tsx']),
  ).toEqual({
    sourceFiles: ['src/autonomy/stuck.ts', 'src/ui/App.tsx'],
    testFiles: ['src/autonomy/stuck.test.ts'],
  })
})

test('only commits that changed both source and tests, and stayed small, become tasks', () => {
  const bounds = { maxSourceFiles: 3, maxTestFiles: 2 }
  expect(isCandidateShape({ sourceFiles: ['a.ts'], testFiles: ['a.test.ts'] }, bounds)).toBe(true)
  expect(isCandidateShape({ sourceFiles: [], testFiles: ['a.test.ts'] }, bounds)).toBe(false)
  expect(isCandidateShape({ sourceFiles: ['a.ts'], testFiles: [] }, bounds)).toBe(false)
  expect(isCandidateShape({ sourceFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], testFiles: ['a.test.ts'] }, bounds)).toBe(false)
})

test('test paths are passed to Bun unquoted, and paths that would need quoting are rejected', () => {
  // cmd /s hands quotes through verbatim on Windows, so a quoted path matches
  // no test file at all.
  expect(verifyCommandFor(['src/a.test.ts', 'src/b.test.ts'])).toBe('bun test --timeout=20000 src/a.test.ts src/b.test.ts')
  expect(isCandidateShape({ sourceFiles: ['a.ts'], testFiles: ['src/has space.test.ts'] }, { maxSourceFiles: 3, maxTestFiles: 2 })).toBe(false)
})

test('the prompt withholds the commit message and forbids touching the tests', () => {
  const prompt = promptFor(SPEC)
  // The subject names the chosen fix, so including it would turn diagnosis into
  // transcription.
  expect(prompt).not.toContain(SPEC.subject)
  expect(prompt).toContain('src/autonomy/stuck.test.ts')
  expect(prompt).toContain(SPEC.verifyCommand)
  expect(prompt).toMatch(/Do not edit, delete, skip, or weaken any\ntest file/)
})

test('editing or deleting the specification fails the task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-hist-test-'))
  try {
    const file = 'spec.test.ts'
    const original = 'expect(fix()).toBe(1)\n'
    writeFileSync(join(dir, file), original)
    const expected = new Map([[file, contentHash(original)]])

    expect(checkTestsUntouched(dir, expected)).toBeUndefined()

    writeFileSync(join(dir, file), 'expect(true).toBe(true)\n')
    expect(checkTestsUntouched(dir, expected)?.passed).toBe(false)
    expect(checkTestsUntouched(dir, expected)?.detail).toContain('edited the specification')

    rmSync(join(dir, file))
    expect(checkTestsUntouched(dir, expected)?.detail).toContain('deleted the specification')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a line-ending difference is not treated as tampering', () => {
  // The same test file checked out on Windows and on Linux must hash alike, or
  // every task fails as tampered on one of the two.
  expect(contentHash('a\r\nb\r\n')).toBe(contentHash('a\nb\n'))
})

test('check fails cleanly when setup never ran for this directory', () => {
  const task = toBenchTask(SPEC)
  expect(task.id).toBe('hist-abc1234')
  expect(task.weight).toBe(2)
  return task.check('C:/nonexistent-dir').then((result) => {
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('setup did not record')
  })
})

test('the generated tasks file, if present, only holds validated tasks', () => {
  const file = join(import.meta.dir, 'tasks.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return // Not harvested in this checkout; nothing to assert.
  }
  const specs = JSON.parse(raw) as HistoryTaskSpec[]
  for (const spec of specs) {
    // The harvester must never write a task it could not prove fails first and
    // passes after — that is the property the old suite lacked.
    expect(spec.evidence.failingBefore).toBeGreaterThan(0)
    expect(spec.evidence.passingAfter).toBeGreaterThan(0)
    expect(spec.testFiles.length).toBeGreaterThan(0)
    expect(spec.sourceFiles.length).toBeGreaterThan(0)
    expect(spec.id).toBe(`hist-${spec.sha.slice(0, 7)}`)
  }
})
