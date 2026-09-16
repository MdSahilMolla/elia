import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-bench-lessons-test'

const { benchLessonBlock, BENCH_LESSONS_ENV } = await import('./benchLessons.ts')
const { rewriteLessons } = await import('../autonomy/lessons.ts')
const { loadTaskSpecs } = await import('./history/suite.ts')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-bench-lessons-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('no store configured means no lessons', async () => {
  expect(await benchLessonBlock('precise-edit', 'x', {})).toBe('')
})

test('a built-in task sees the whole store', async () => {
  const store = join(dir, 'lessons.md')
  rewriteLessons([{ at: Date.now(), text: 'run the suite with bun, not node' }], store)
  const block = await benchLessonBlock('precise-edit', 'edit a file', { [BENCH_LESSONS_ENV]: store })
  expect(block).toContain('run the suite with bun, not node')
})

test('a history task never sees a lesson written after its commit', async () => {
  const spec = loadTaskSpecs()[0]
  if (!spec) return // no harvested tasks in this checkout
  const store = join(dir, 'lessons.md')
  rewriteLessons(
    [
      { at: Date.UTC(2000, 0, 1), text: 'an old fact about the repo' },
      { at: Date.now() + 60_000, text: 'the answer key, written later' },
    ],
    store,
  )
  const block = await benchLessonBlock(spec.id, 'fix the tests', { [BENCH_LESSONS_ENV]: store })
  expect(block).not.toContain('the answer key')
  expect(block).toContain('an old fact about the repo')
})
