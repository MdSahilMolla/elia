import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-efficacy-test'

const { recordLessonExposure, loadEfficacy, lessonLift, MIN_EXPOSURES, renderEfficacyLine, exposedCorrs } = await import('./lessonEfficacy.ts')

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

test('exposedCorrs returns only the corrs of runs that saw this lesson key', () => {
  recordLessonExposure('run-1', ['k1', 'k2'], { verify: 'pass', clean: true }, path)
  recordLessonExposure('run-2', ['k1'], { verify: 'fail', clean: false }, path)
  recordLessonExposure('run-3', ['k2'], { verify: 'pass', clean: true }, path)
  expect(exposedCorrs('k1', path)).toEqual(new Set(['run-1', 'run-2']))
  expect(exposedCorrs('k2', path)).toEqual(new Set(['run-1', 'run-3']))
  expect(exposedCorrs('unseen-key', path)).toEqual(new Set())
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

const { lessonTrials, MIN_HELD_OUT } = await import('./lessonEfficacy.ts')

/** One run of a randomized trial: `key` either shown or held out, with the run's outcome. */
function trialRun(corr: string, key: string, shown: boolean, clean: boolean): void {
  recordLessonExposure(corr, shown ? [key] : [], { verify: clean ? 'pass' : 'fail', clean, heldOut: shown ? [] : [key] }, path)
}

test('a run whose only lesson was held out is still recorded', () => {
  trialRun('run-1', 'k', false, true)
  expect(exposedCorrs('k', path)).toEqual(new Set())
  expect(loadEfficacy(path).size).toBe(0)
})

test('lessonTrials needs enough held-out runs before judging', () => {
  for (let i = 0; i < 30; i += 1) trialRun(`s-${i}`, 'k', true, true)
  for (let i = 0; i < MIN_HELD_OUT - 1; i += 1) trialRun(`h-${i}`, 'k', false, false)
  expect(lessonTrials(path).has('k')).toBe(false)
})

test('lessonTrials calls a lesson helpful only when shown beats held out by a clear margin', () => {
  for (let i = 0; i < 30; i += 1) trialRun(`s-${i}`, 'good', true, i % 10 !== 0) // 90% clean
  for (let i = 0; i < 12; i += 1) trialRun(`h-${i}`, 'good', false, i % 3 === 0) // 33% clean
  for (let i = 0; i < 30; i += 1) trialRun(`s2-${i}`, 'noise', true, i % 2 === 0) // 50%
  for (let i = 0; i < 12; i += 1) trialRun(`h2-${i}`, 'noise', false, i % 2 === 1) // 50%
  const trials = lessonTrials(path)
  expect(trials.get('good')?.verdict).toBe('helps')
  expect(trials.get('good')?.lift).toBeCloseTo(0.9 - 4 / 12)
  expect(trials.get('noise')?.verdict).toBe('unclear')
})

test('lessonTrials flags a lesson whose held-out runs go clearly better', () => {
  for (let i = 0; i < 30; i += 1) trialRun(`s-${i}`, 'bad', true, i % 5 === 0) // 20%
  for (let i = 0; i < 12; i += 1) trialRun(`h-${i}`, 'bad', false, true) // 100%
  expect(lessonTrials(path).get('bad')?.verdict).toBe('hurts')
})

test('lessonTrials ignores shown runs from before holdout existed', () => {
  // A long pre-holdout history of dirty runs must not drag the shown arm down:
  // those runs were never split by a coin flip.
  for (let i = 0; i < 100; i += 1) recordLessonExposure(`old-${i}`, ['k'], { verify: 'fail', clean: false }, path)
  for (let i = 0; i < 10; i += 1) trialRun(`s-${i}`, 'k', true, true)
  for (let i = 0; i < 10; i += 1) trialRun(`h-${i}`, 'k', false, true)
  const trial = lessonTrials(path).get('k')
  expect(trial?.shown.runs).toBe(10)
  expect(trial?.verdict).toBe('unclear')
})

test('lessonTrials excludes unverified and judgment-only runs', () => {
  for (let i = 0; i < MIN_HELD_OUT; i += 1) {
    recordLessonExposure(`none-${i}`, ['k'], { verify: 'none', clean: true, heldOut: [] }, path)
    recordLessonExposure(`skipped-${i}`, [], { verify: 'skipped', clean: false, heldOut: ['k'] }, path)
    recordLessonExposure(`judgment-${i}`, ['k'], { verify: 'pass', regime: 'judgment', clean: true, heldOut: [] }, path)
  }
  expect(lessonTrials(path).has('k')).toBe(false)
})

test('lessonTrials excludes non-randomized injected rules from a new-format trial', () => {
  for (let i = 0; i < MIN_HELD_OUT; i += 1) {
    recordLessonExposure(`shown-${i}`, ['user-rule', 'project'], { verify: 'pass', clean: true, heldOut: [], trialKeys: ['project'] }, path)
    recordLessonExposure(`held-${i}`, ['user-rule'], { verify: 'fail', clean: false, heldOut: ['project'], trialKeys: ['project'] }, path)
  }
  const trials = lessonTrials(path)
  expect(trials.has('user-rule')).toBe(false)
  expect(trials.get('project')).toMatchObject({ shown: { runs: MIN_HELD_OUT, clean: MIN_HELD_OUT }, heldOut: { runs: MIN_HELD_OUT, clean: 0 } })
})

test('renderEfficacyLine reports randomized verdicts', () => {
  for (let i = 0; i < 30; i += 1) trialRun(`s-${i}`, 'good', true, true)
  for (let i = 0; i < 12; i += 1) trialRun(`h-${i}`, 'good', false, false)
  expect(renderEfficacyLine(0.5, path)).toContain('Randomized trials: 1 judged, 1 proven to help, 0 proven to hurt')
})
