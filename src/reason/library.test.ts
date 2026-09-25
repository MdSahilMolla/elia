import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-library-test'

const { MIN_OBSERVATIONS, chooseHarness, libraryPath, meanAttempts, readLibrary, recordOutcome, renderLibrary, successLowerBound } =
  await import('./library.ts')
import type { HarnessOutcome, Library } from './library.ts'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-reason-library-'))
  path = libraryPath(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const outcome = (overrides: Partial<HarnessOutcome> = {}): HarnessOutcome => ({
  signature: 'repair/checked/single',
  harnessId: 'wide',
  verified: true,
  attemptsUsed: 2,
  cost: 2,
  elapsedMs: 100,
  at: Date.now(),
  ...overrides,
})

const libraryOf = (records: Library['records']): Library => ({ version: 1, records })
const record = (harnessId: string, runs: number, verifiedRuns: number, totalAttempts = runs) => ({
  signature: 'repair/checked/single',
  harnessId,
  runs,
  verifiedRuns,
  totalAttempts,
  totalCost: totalAttempts,
  totalElapsedMs: runs * 10,
  lastAt: 1,
})

test('a missing library reads as empty rather than throwing', () => {
  expect(readLibrary(path).records).toEqual([])
})

test('outcomes accumulate into one record per harness per signature', () => {
  recordOutcome(outcome(), path)
  recordOutcome(outcome({ verified: false, attemptsUsed: 4 }), path)
  recordOutcome(outcome({ harnessId: 'single', attemptsUsed: 1 }), path)

  const library = readLibrary(path)
  expect(library.records.length).toBe(2)
  const wide = library.records.find((entry) => entry.harnessId === 'wide')!
  expect(wide.runs).toBe(2)
  expect(wide.verifiedRuns).toBe(1)
  expect(meanAttempts(wide)).toBe(3)
})

test('the library survives a corrupted file', () => {
  recordOutcome(outcome(), path)
  writeFileSync(path, '{ not json')
  expect(readLibrary(path).records).toEqual([])
})

test('a perfect record on few runs scores below a near-perfect record on many', () => {
  // The whole reason for a lower bound rather than a mean: 3/3 is a worse bet
  // than 19/20, and a mean says the opposite.
  expect(successLowerBound({ runs: 3, verifiedRuns: 3 })).toBeLessThan(successLowerBound({ runs: 20, verifiedRuns: 19 }))
})

test('nothing is preferred until some harness has enough runs', () => {
  const library = libraryOf([record('wide', MIN_OBSERVATIONS - 1, MIN_OBSERVATIONS - 1)])
  const choice = chooseHarness('repair/checked/single', ['single', 'wide', 'deep'], library)

  expect(choice.exploring).toBe(true)
  expect(choice.reason).toContain('still measuring')
  // An unobserved harness is what gets tried, so the cells fill instead of one winning by default.
  expect(choice.harnessId).toBe('single')
})

test('once a harness is seasoned it is chosen, and the reason says why', () => {
  const library = libraryOf([record('wide', 10, 9), record('single', 10, 4), record('deep', 10, 9, 40)])
  const choice = chooseHarness('repair/checked/single', ['single', 'wide', 'deep'], library)

  expect(choice.exploring).toBe(false)
  expect(choice.harnessId).toBe('wide')
  expect(choice.reason).toContain('9/10')
})

test('a tie on success goes to the harness that spent fewer attempts', () => {
  const library = libraryOf([record('deep', 10, 9, 50), record('wide', 10, 9, 20)])
  expect(chooseHarness('repair/checked/single', ['wide', 'deep'], library).harnessId).toBe('wide')
})

test('a harness that has never run still gets picked up occasionally once others are seasoned', () => {
  // Three seasoned runs on wide and nothing on deep: the exploration slot fires
  // on the fourth, so a late-added harness is not locked out forever.
  const library = libraryOf([record('wide', 7, 7), record('single', 8, 4)])
  const choice = chooseHarness('repair/checked/single', ['single', 'wide', 'deep'], library)

  expect(choice.harnessId).toBe('deep')
  expect(choice.exploring).toBe(true)
})

test('the rendered library marks the records that are not yet worth trusting', () => {
  const rendered = renderLibrary(libraryOf([record('wide', 2, 2), record('single', 10, 3)]))

  expect(rendered).toContain('wide 2/2*')
  expect(rendered).toContain('single 3/10')
  expect(renderLibrary(libraryOf([]))).toContain('empty')
})

const { EXPLORATION_CAP, successUpperBound } = await import('./library.ts')

test('a harness with a few unlucky runs keeps its exploration turn while it could still win', () => {
  // single has run twice; wide is seasoned. Before, only harnesses with no runs
  // at all were ever explored, so single was locked out on two data points.
  const library = libraryOf([record('wide', 9, 8), record('single', 2, 1)])
  const choice = chooseHarness('repair/checked/single', ['single', 'wide'], library)

  expect(choice.harnessId).toBe('single')
  expect(choice.exploring).toBe(true)
  expect(choice.reason).toContain('too few to rule out beating wide')
})

test('a harness the evidence rules out stops being explored', () => {
  // 2/10 cannot plausibly beat 21/21: its upper bound is below wide's lower bound.
  expect(successUpperBound({ runs: 10, verifiedRuns: 2 })).toBeLessThan(successLowerBound({ runs: 21, verifiedRuns: 21 }))
  const library = libraryOf([record('wide', 21, 21), record('single', 10, 2)])
  const choice = chooseHarness('repair/checked/single', ['single', 'wide'], library)

  expect(choice.harnessId).toBe('wide')
  expect(choice.exploring).toBe(false)
})

test('two harnesses within noise of each other after many runs are left to the tie-break', () => {
  const library = libraryOf([record('wide', 41, 31, 82), record('deep', EXPLORATION_CAP, 22, 120)])
  // 71 runs is an exploration slot, and deep's interval still overlaps wide's —
  // but deep has had its share of runs.
  expect((41 + EXPLORATION_CAP) % 4).toBe(3)
  expect(successUpperBound({ runs: EXPLORATION_CAP, verifiedRuns: 22 })).toBeGreaterThan(successLowerBound({ runs: 41, verifiedRuns: 31 }))
  const choice = chooseHarness('repair/checked/single', ['wide', 'deep'], library)
  expect(choice.harnessId).toBe('wide')
  expect(choice.exploring).toBe(false)
})
