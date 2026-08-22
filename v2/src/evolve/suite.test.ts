import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskById } from './suite.ts'

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
