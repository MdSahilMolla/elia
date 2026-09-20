import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIELD_BENCH_TASKS } from './fieldSuite.ts'
import { BENCH_TASKS } from './suite.ts'
import { FAILURE_SHAPES } from './fieldEvidence.ts'
import { isImmutablePath } from './sandbox.ts'

const task = (id: string) => FIELD_BENCH_TASKS.find((candidate) => candidate.id === id)!

async function inTask<T>(id: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `elia-${id}-`))
  try {
    await task(id).setup(dir)
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the field tasks are in the set the loop is scored on, and immutable to it', () => {
  const ids = BENCH_TASKS.map((candidate) => candidate.id)
  for (const field of FIELD_BENCH_TASKS) expect(ids).toContain(field.id)
  expect(isImmutablePath('src/evolve/fieldSuite.ts')).toBe(true)
  // Every field shape a task was built for points at it, so the proposer is told the fix can score.
  const moved = new Set(FAILURE_SHAPES.flatMap((shape) => shape.benchTasks))
  for (const field of FIELD_BENCH_TASKS) expect(moved.has(field.id)).toBe(true)
})

test('the source count counts .ts and .d.ts under src, and not tests or files outside src', async () => {
  await inTask('field-count-sources', async (dir) => {
    writeFileSync(join(dir, 'answer.txt'), '11\n')
    expect((await task('field-count-sources').check(dir)).passed).toBe(false)
    writeFileSync(join(dir, 'answer.txt'), '9\n')
    expect((await task('field-count-sources').check(dir)).passed).toBe(true)
  })
})

test('the sub-package fix must be in the source, and general — not special-cased to the visible test', async () => {
  await inTask('field-subpackage-test', async (dir) => {
    const source = join(dir, 'packages/core/src/range.ts')
    expect((await task('field-subpackage-test').check(dir)).passed).toBe(false)

    const original = readFileSync(source, 'utf8')
    writeFileSync(source, original.replace('i < end', 'i <= end'))
    expect((await task('field-subpackage-test').check(dir)).passed).toBe(true)

    // Special-casing the two visible examples does not pass.
    writeFileSync(source, 'export function range(start: number, end: number): number[] {\n  if (start === 1 && end === 4) return [1, 2, 3, 4]\n  if (start === 3) return [3]\n  return []\n}\n')
    expect((await task('field-subpackage-test').check(dir)).passed).toBe(false)

    // Nor does weakening the test.
    writeFileSync(source, original.replace('i < end', 'i <= end'))
    writeFileSync(join(dir, 'packages/core/src/range.test.ts'), "import { test } from 'bun:test'\ntest('ok', () => {})\n")
    expect((await task('field-subpackage-test').check(dir)).detail).toContain('test was edited')
  })
})
