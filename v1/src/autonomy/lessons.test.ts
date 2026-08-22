import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// lessons.ts reads paths from config.ts, which resolves a provider on import.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-lessons-test'

const { appendLessons, loadLessons, renderLessons } = await import('./lessons.ts')

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-lessons-'))
  path = join(dir, 'lessons.md')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('lessons round-trip through the file', () => {
  appendLessons(['tests need bun, not node', 'src/generated is generated — do not edit'], path)

  expect(loadLessons(path).map((lesson) => lesson.text)).toEqual([
    'tests need bun, not node',
    'src/generated is generated — do not edit',
  ])
})

test('the file gets a header the first time and not again', () => {
  appendLessons(['first'], path)
  appendLessons(['second'], path)

  const content = Bun.file(path)
  expect(loadLessons(path).length).toBe(2)
  return content.text().then((text) => {
    expect(text.match(/# Lessons/g)?.length).toBe(1)
  })
})

test('a repeated lesson is not stored twice', () => {
  appendLessons(['tests need bun'], path)
  appendLessons(['tests need bun'], path)

  expect(loadLessons(path).length).toBe(1)
})

test('duplicate detection ignores case', () => {
  appendLessons(['Tests Need Bun'], path)
  appendLessons(['tests need bun'], path)

  expect(loadLessons(path).length).toBe(1)
})

test('newlines are flattened, so one lesson stays one line', () => {
  appendLessons(['a lesson\nspanning\nlines'], path)

  expect(loadLessons(path)[0]!.text).toBe('a lesson spanning lines')
})

test('empty and whitespace-only lessons are dropped', () => {
  appendLessons(['   ', '', 'real one'], path)

  expect(loadLessons(path).map((lesson) => lesson.text)).toEqual(['real one'])
})

test('an empty list writes nothing at all', () => {
  appendLessons([], path)

  expect(loadLessons(path)).toEqual([])
  expect(renderLessons(path)).toBe('')
})

test('a missing file loads as no lessons rather than throwing', () => {
  expect(loadLessons(join(dir, 'never-written.md'))).toEqual([])
})

test('the timestamp comment is stripped from the lesson text but recorded', () => {
  appendLessons(['a timed lesson'], path)

  const lesson = loadLessons(path)[0]!
  expect(lesson.text).toBe('a timed lesson')
  expect(lesson.at).toBeGreaterThan(0)
})

test('rendering produces a prompt section only when there is something to say', () => {
  expect(renderLessons(path)).toBe('')

  appendLessons(['the build needs --target=node'], path)
  const rendered = renderLessons(path)

  expect(rendered).toContain('What earlier runs learned')
  expect(rendered).toContain('the build needs --target=node')
})
