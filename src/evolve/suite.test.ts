import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allBenchTasks, BENCH_TASKS, firstDifference, taskById } from './suite.ts'
import { resetTaskSpecCache } from './history/suite.ts'
import type { HistoryTaskSpec } from './history/types.ts'

/**
 * A benchmark task whose own `check()` is wrong is worse than no benchmark at
 * all — it would silently corrupt every generation's signal. These tests don't
 * run a real agent; they simulate "unsolved" and "correctly solved" states by
 * hand and confirm `check()` tells the two apart, plus the specific traps each
 * new task is designed to catch.
 */

let dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `elia-suite-test-${prefix}-`))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  resetTaskSpecCache()
})

const HISTORY_SPEC: HistoryTaskSpec = {
  id: 'hist-abc1234',
  sha: 'abc1234000000000000000000000000000000000',
  parent: 'def5678000000000000000000000000000000000',
  subject: 'A harvested fix',
  testFiles: ['src/example.test.ts'],
  sourceFiles: ['src/example.ts'],
  verifyCommand: 'bun test src/example.test.ts',
  evidence: { failingBefore: 1, passingAfter: 1 },
  weight: 2,
}

test('allBenchTasks grows the benchmark with whatever elia bench --harvest has validated, instead of staying fixed', () => {
  resetTaskSpecCache()
  const withNoHistory = tempDir('no-history')
  const emptyFile = join(withNoHistory, 'tasks.json')
  writeFileSync(emptyFile, '[]')
  expect(allBenchTasks(emptyFile)).toHaveLength(BENCH_TASKS.length)

  resetTaskSpecCache()
  const withHistory = tempDir('with-history')
  const historyFile = join(withHistory, 'tasks.json')
  writeFileSync(historyFile, JSON.stringify([HISTORY_SPEC]))
  const grown = allBenchTasks(historyFile)
  expect(grown).toHaveLength(BENCH_TASKS.length + 1)
  expect(grown.map((t) => t.id)).toContain('hist-abc1234')
})

test('multi-bug-hunt: fails on the unsolved state', async () => {
  const task = taskById('multi-bug-hunt')!
  const dir = tempDir('multi-bug-hunt-unsolved')
  await task.setup(dir)
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
})

test('multi-bug-hunt: fails when only one of the two bugs is fixed', async () => {
  const task = taskById('multi-bug-hunt')!
  const dir = tempDir('multi-bug-hunt-partial')
  await task.setup(dir)

  // Fix only the mutation bug; leave the median bug in place.
  writeFileSync(
    join(dir, 'src/stats.ts'),
    `export function mean(values: number[]): number {
  if (values.length === 0) return 0
  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

export function sortedAscending(values: number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

export function median(values: number[]): number {
  const sorted = sortedAscending(values)
  const mid = Math.floor(sorted.length / 2)
  return sorted[mid]!
}
`,
  )

  const result = await task.check(dir)
  expect(result.passed).toBe(false)
})

test('multi-bug-hunt: passes once both unrelated bugs are fixed', async () => {
  const task = taskById('multi-bug-hunt')!
  const dir = tempDir('multi-bug-hunt-solved')
  await task.setup(dir)

  writeFileSync(
    join(dir, 'src/stats.ts'),
    `export function mean(values: number[]): number {
  if (values.length === 0) return 0
  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

export function sortedAscending(values: number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

export function median(values: number[]): number {
  const sorted = sortedAscending(values)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2
  return sorted[mid]!
}
`,
  )

  const result = await task.check(dir)
  expect(result.passed).toBe(true)
}, 15_000)

test('multi-bug-hunt: rejects a solution that tampers with the test file', async () => {
  const task = taskById('multi-bug-hunt')!
  const dir = tempDir('multi-bug-hunt-tampered')
  await task.setup(dir)
  writeFileSync(join(dir, 'tests/stats.test.ts'), 'import { test } from "bun:test"\ntest("noop", () => {})\n')

  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toContain('modified')
})

test('distractor-rename: fails on the unsolved state', async () => {
  const task = taskById('distractor-rename')!
  const dir = tempDir('distractor-unsolved')
  await task.setup(dir)
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
})

test('distractor-rename: fails if the unrelated decoy in schema.ts is touched', async () => {
  const task = taskById('distractor-rename')!
  const dir = tempDir('distractor-decoy-touched')
  await task.setup(dir)

  // Correctly rename the real target, but also (wrongly) touch the decoy.
  writeFileSync(
    join(dir, 'src/form.ts'),
    `export function validateInput(value: string): boolean {
  return value.trim().length > 0
}

export function submit(value: string): string {
  if (!validateInput(value)) throw new Error('invalid')
  return value.trim()
}
`,
  )
  writeFileSync(
    join(dir, 'src/formUtils.ts'),
    `import { validateInput } from './form.ts'

export function isFormReady(value: string): boolean {
  return validateInput(value)
}
`,
  )
  writeFileSync(
    join(dir, 'src/schema.ts'),
    `export function validateInput(schema: Record<string, unknown>): boolean {
  return typeof schema === 'object' && schema !== null
}

export function assertSchema(schema: Record<string, unknown>): void {
  if (!validateInput(schema)) throw new Error('invalid schema')
}
`,
  )

  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toContain('schema.ts')
})

test('distractor-rename: fails on a partial rename (formUtils.ts left stale)', async () => {
  const task = taskById('distractor-rename')!
  const dir = tempDir('distractor-partial')
  await task.setup(dir)

  writeFileSync(
    join(dir, 'src/form.ts'),
    `export function validateInput(value: string): boolean {
  return value.trim().length > 0
}

export function submit(value: string): string {
  if (!validateInput(value)) throw new Error('invalid')
  return value.trim()
}
`,
  )
  // formUtils.ts left referencing the old name.

  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toContain('formUtils.ts')
})

test('distractor-rename: passes when only the real target is renamed and the decoy is untouched', async () => {
  const task = taskById('distractor-rename')!
  const dir = tempDir('distractor-solved')
  await task.setup(dir)

  writeFileSync(
    join(dir, 'src/form.ts'),
    `export function validateInput(value: string): boolean {
  return value.trim().length > 0
}

export function submit(value: string): string {
  if (!validateInput(value)) throw new Error('invalid')
  return value.trim()
}
`,
  )
  writeFileSync(
    join(dir, 'src/formUtils.ts'),
    `import { validateInput } from './form.ts'

export function isFormReady(value: string): boolean {
  return validateInput(value)
}
`,
  )

  const result = await task.check(dir)
  expect(result.passed).toBe(true)
})

test('scope-discipline: passes only when the exact target file changes', async () => {
  const task = taskById('scope-discipline')!
  const dir = tempDir('scope-discipline-solved')
  await task.setup(dir)
  writeFileSync(join(dir, 'src/api.ts'), `export function statusCode(): number {\n  return 201\n}\n`)
  expect((await task.check(dir)).passed).toBe(true)
})

test('scope-discipline: fails when an unrelated file changes', async () => {
  const task = taskById('scope-discipline')!
  const dir = tempDir('scope-discipline-forbidden')
  await task.setup(dir)
  writeFileSync(join(dir, 'src/api.ts'), `export function statusCode(): number {\n  return 201\n}\n`)
  writeFileSync(join(dir, 'src/constants.ts'), 'export const API_VERSION = \'v2\'\n')
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toContain('unrelated')
})

test('parallel-scan: fails on the unsolved state (no answer.txt)', async () => {
  const task = taskById('parallel-scan')!
  const dir = tempDir('parallel-scan-unsolved')
  await task.setup(dir)
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
})

test('parallel-scan: fails on a wrong answer', async () => {
  const task = taskById('parallel-scan')!
  const dir = tempDir('parallel-scan-wrong')
  await task.setup(dir)
  writeFileSync(join(dir, 'answer.txt'), 'billing')
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
})

test('parallel-scan: passes on the correct highest-timeout service', async () => {
  const task = taskById('parallel-scan')!
  const dir = tempDir('parallel-scan-solved')
  await task.setup(dir)
  writeFileSync(join(dir, 'answer.txt'), 'search')
  const result = await task.check(dir)
  expect(result.passed).toBe(true)
})

test('parallel-scan: setup writes ten independent config files', async () => {
  const task = taskById('parallel-scan')!
  const dir = tempDir('parallel-scan-setup')
  await task.setup(dir)
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(join(dir, 'config')).length).toBe(10)
})

const SOLVED_LIMITS = `export function alpha(value: number): number {
  const limit = 100
  return Math.min(value, limit)
}

export function beta(value: number): number {
  const limit = 250
  return Math.min(value, limit)
}

export function gamma(value: number): number {
  const limit = 100
  return Math.min(value, limit)
}
`

async function checkPreciseEdit(content: string) {
  const task = taskById('precise-edit')!
  const dir = tempDir('precise-edit')
  await task.setup(dir)
  writeFileSync(join(dir, 'src', 'limits.ts'), content)
  return task.check(dir)
}

test('precise-edit: the exact edit passes, and an untouched file still says so', async () => {
  expect(await checkPreciseEdit(SOLVED_LIMITS)).toEqual({ passed: true, detail: 'only beta changed, byte-for-byte' })
  const unchanged = await checkPreciseEdit(SOLVED_LIMITS.replace('const limit = 250', 'const limit = 100'))
  expect(unchanged).toEqual({ passed: false, detail: 'expected limits [100,250,100], found [100,100,100] (file unchanged)' })
})

test('precise-edit: the right limits in reformatted bytes fail, and the detail names the first line that differs', async () => {
  // A whole-file rewrite that re-indented alpha with a tab: every limit is
  // right, and the detail used to read "expected [100,250,100], found [100,250,100]".
  const result = await checkPreciseEdit(SOLVED_LIMITS.replace('  const limit = 100\n  return Math.min(value, limit)\n}\n\nexport function beta', '\tconst limit = 100\n  return Math.min(value, limit)\n}\n\nexport function beta'))
  expect(result.passed).toBe(false)
  expect(result.detail).toBe('limits are right [100,250,100], but the file is not byte-for-byte what was asked — line 2: expected "  const limit = 100", found "\\tconst limit = 100"')
})

test('precise-edit: a CRLF rewrite and a lost trailing newline are named, not hidden', async () => {
  const crlf = await checkPreciseEdit(SOLVED_LIMITS.replace(/\n/g, '\r\n'))
  expect(crlf.passed).toBe(false)
  expect(crlf.detail).toContain('line 1: expected "export function alpha(value: number): number {", found "export function alpha(value: number): number {\\r"')

  const noNewline = await checkPreciseEdit(SOLVED_LIMITS.trimEnd())
  expect(noNewline.passed).toBe(false)
  expect(noNewline.detail).toBe('limits are right [100,250,100], but the file is not byte-for-byte what was asked — only the trailing newline differs')
})

test('firstDifference clips a long line and reports a file that ends early', () => {
  const long = 'x'.repeat(200)
  expect(firstDifference('a\nb\n', `a\n${long}\n`)).toBe(`line 2: expected "b", found "${'x'.repeat(80)}…"`)
  expect(firstDifference('a\nb\nc', 'a\nb')).toBe('line 3: expected "c", found (end of file)')
  expect(firstDifference('same', 'same')).toBe('no difference')
})
