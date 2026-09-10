import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-efficacy-test'

const { recordLessonExposure, loadEfficacy, lessonLift, MIN_EXPOSURES, renderEfficacyLine } = await import('./lessonEfficacy.ts')

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-eff-'))
  path = join(dir, 'lessons-efficacy.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a lesson accrues one exposure per run it was injected into', () => {
  recordLessonExposure('run-1', ['k1', 'k2'], { verify: 'pass', clean: true }, path)
  recordLessonExposure('run-2', ['k1'], { verify: 'fail', clean: false }, path)
  const counts = loadEfficacy(path)
  expect(counts.get('k1')).toEqual({ exposures: 2, cleanRuns: 1, verifyPasses: 1 })
  expect(counts.get('k2')).toEqual({ exposures: 1, cleanRuns: 1, verifyPasses: 1 })
})

test('recordLessonExposure with no keys writes nothing', () => {
  recordLessonExposure('run-1', [], { verify: 'pass', clean: true }, path)
  expect(loadEfficacy(path).size).toBe(0)
})

test('lessonLift is undefined below the minimum exposure count', () => {
  for (let i = 0; i < MIN_EXPOSURES - 1; i += 1) {
    recordLessonExposure(`run-${i}`, ['k'], { verify: 'pass', clean: true }, path)
  }
  expect(lessonLift('k', loadEfficacy(path), 0.5)).toBeUndefined()
})

test('lessonLift is positive when the with-lesson clean rate beats the baseline', () => {
  for (let i = 0; i < MIN_EXPOSURES; i += 1) {
    recordLessonExposure(`run-${i}`, ['k'], { verify: 'pass', clean: true }, path)
  }
  const lift = lessonLift('k', loadEfficacy(path), 0.6)
  expect(lift).toBeCloseTo(0.4)
})

test('lessonLift is non-positive when the lesson underperforms the baseline', () => {
  for (let i = 0; i < MIN_EXPOSURES; i += 1) {
    recordLessonExposure(`run-${i}`, ['k'], { verify: 'fail', clean: false }, path)
  }
  expect(lessonLift('k', loadEfficacy(path), 0.5)).toBeLessThanOrEqual(0)
})

test('the efficacy log tolerates a corrupt line', () => {
  recordLessonExposure('run-1', ['k'], { verify: 'pass', clean: true }, path)
  appendFileSync(path, 'not json\n')
  recordLessonExposure('run-2', ['k'], { verify: 'pass', clean: true }, path)
  expect(loadEfficacy(path).get('k')?.exposures).toBe(2)
})

test('renderEfficacyLine summarises how many lessons show no lift', () => {
  for (let i = 0; i < MIN_EXPOSURES; i += 1) {
    recordLessonExposure(`good-${i}`, ['good'], { verify: 'pass', clean: true }, path)
    recordLessonExposure(`bad-${i}`, ['bad'], { verify: 'fail', clean: false }, path)
  }
  const line = renderEfficacyLine(0.5, path)
  expect(line).toContain('2 lesson(s)')
  expect(line).toContain('1 showing no lift')
})
