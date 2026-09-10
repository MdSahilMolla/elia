import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// lessons.ts reads paths from config.ts, which resolves a provider on import.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-lessons-test'

const { appendLessons, consumeInjectedLessonKeys, loadLessons, renderLessons, renderLessonsWithKeys, retireLessons } = await import('./lessons.ts')
const { recordLessonExposure } = await import('./lessonEfficacy.ts')

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

test('loadLessons attaches a stable key derived from the text', () => {
  appendLessons(['tests need bun, not node'], path)
  const key1 = loadLessons(path)[0]?.key
  expect(key1).toBeTruthy()
  // whitespace / case differences do not change the key
  appendLessons(['  TESTS   need BUN, not node  '], join(dir, 'other.md'))
  expect(loadLessons(join(dir, 'other.md'))[0]?.key).toBe(key1!)
})

test('renderLessonsWithKeys exposes the injected keys and stashes them for the recorder', () => {
  appendLessons(['a', 'b'], path)
  const rendered = renderLessonsWithKeys(path)
  expect(rendered.keys).toHaveLength(2)
  expect(rendered.text).toContain('- a')
  // the module-local stash mirrors the returned keys
  expect(consumeInjectedLessonKeys()).toEqual(rendered.keys)
  // draining leaves it empty
  expect(consumeInjectedLessonKeys()).toEqual([])
})

test('retireLessons drops a lesson with enough exposures and no lift, keeps one with lift', () => {
  appendLessons(['helpful lesson', 'dead weight lesson'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const [helpful, dead] = loadLessons(path).map((l) => l.key!)
  // baseline clean rate 0.5; "helpful" runs clean every time, "dead" never does.
  for (let i = 0; i < 6; i += 1) {
    recordLessonExposure(`run-h-${i}`, [helpful!], { verify: 'pass', clean: true }, efficacyPath)
    recordLessonExposure(`run-d-${i}`, [dead!], { verify: 'pass', clean: false }, efficacyPath)
  }
  const result = retireLessons(0.5, { lessonsPath: path, efficacyPath })
  expect(result.retired).toEqual(['dead weight lesson'])
  expect(loadLessons(path).map((l) => l.text)).toEqual(['helpful lesson'])
})

test('retireLessons is a no-op below the minimum exposure count', () => {
  appendLessons(['unproven lesson'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const key = loadLessons(path)[0]!.key!
  recordLessonExposure('run-1', [key], { verify: 'fail', clean: false }, efficacyPath)
  expect(retireLessons(0.9, { lessonsPath: path, efficacyPath }).retired).toEqual([])
  expect(loadLessons(path)).toHaveLength(1)
})

test('retireLessons never removes more than the shrink ceiling in one pass', () => {
  appendLessons(['l1', 'l2', 'l3'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  for (const lesson of loadLessons(path)) {
    for (let i = 0; i < 6; i += 1) recordLessonExposure(`r-${lesson.key}-${i}`, [lesson.key!], { verify: 'fail', clean: false }, efficacyPath)
  }
  // all three are dead weight, but that is 100% of the file — refuse.
  const result = retireLessons(0.9, { lessonsPath: path, efficacyPath })
  expect(result.retired).toEqual([])
  expect(result.skippedReason).toContain('ceiling')
  expect(loadLessons(path)).toHaveLength(3)
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

test('lessons keep optional source and confidence provenance', () => {
  appendLessons([{ text: 'use bun test', source: 'repair', confidence: 0.9 }], path)
  const lesson = loadLessons(path)[0]!
  expect(lesson.text).toBe('use bun test')
  expect(lesson.source).toBe('repair')
  expect(lesson.confidence).toBeCloseTo(0.9)
  expect(renderLessons(path)).toContain('source: repair')
})
