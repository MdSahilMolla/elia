import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectContradictions, readCalibrationLog, recordCompletion, renderCalibrationLine, summarizeCalibration, type CompletionFacts } from './calibration.ts'
import type { CompletionAssessment } from './outcome.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-calib-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const clean: CompletionFacts = {
  verificationPassed: true,
  reviewPassed: true,
  completedSteps: 3,
  totalSteps: 3,
  unresolvedActions: 0,
  pendingApprovals: 0,
  blockedByBudget: 0,
}

function completion(state: CompletionAssessment['state'], confidence: CompletionAssessment['confidence']): CompletionAssessment {
  return { state, confidence, summary: '', evidence: [], blockers: [], nextActions: [], completedSteps: clean.completedSteps, totalSteps: clean.totalSteps, pendingApprovals: 0 }
}

test('a genuinely verified run has no contradictions', () => {
  expect(detectContradictions('verified', 'high', clean)).toEqual([])
})

test('verified while facts say otherwise is flagged every way it can be wrong', () => {
  expect(detectContradictions('verified', 'high', { ...clean, verificationPassed: false })).toContain('reported verified but verification did not pass')
  expect(detectContradictions('verified', 'high', { ...clean, unresolvedActions: 2 })[0]).toContain('unresolved durable action')
  expect(detectContradictions('verified', 'high', { ...clean, completedSteps: 1 })[0]).toContain('1/3 steps complete')
  expect(detectContradictions('verified', 'high', { ...clean, blockedByBudget: 4 })).toContain('reported verified after the action budget was exhausted')
})

test('high confidence on a non-verified state is a contradiction', () => {
  expect(detectContradictions('partial', 'high', clean)).toContain('high confidence on a non-verified state (partial)')
})

test('recordCompletion appends one JSON line per run and readCalibrationLog reads them back', () => {
  recordCompletion('run-a', completion('verified', 'high'), clean, dir)
  recordCompletion('run-b', completion('partial', 'medium'), { ...clean, completedSteps: 1, verificationPassed: false }, dir)

  const raw = readFileSync(join(dir, '.elia', 'runs', 'completion-calibration.ndjson'), 'utf8').trim().split('\n')
  expect(raw).toHaveLength(2)

  const entries = readCalibrationLog(dir)
  expect(entries.map((e) => e.runId)).toEqual(['run-a', 'run-b'])
  expect(entries[0]!.contradictions).toEqual([])
})

test('summarizeCalibration buckets by state/confidence and counts contradictions', () => {
  recordCompletion('r1', completion('verified', 'high'), clean, dir)
  recordCompletion('r2', completion('verified', 'high'), { ...clean, unresolvedActions: 1 }, dir)
  recordCompletion('r3', completion('partial', 'medium'), { ...clean, completedSteps: 1 }, dir)

  const summary = summarizeCalibration(readCalibrationLog(dir))
  expect(summary.total).toBe(3)
  expect(summary.contradicting).toBe(1)
  expect(summary.byState['verified/high']).toEqual({ count: 2, contradicting: 1 })
})

test('renderCalibrationLine is empty with no log and a one-liner once there is one', () => {
  expect(renderCalibrationLine(dir)).toBe('')
  recordCompletion('r1', completion('verified', 'high'), { ...clean, verificationPassed: false }, dir)
  expect(renderCalibrationLine(dir)).toContain('1 with a verdict/facts contradiction (100%)')
})

test('a corrupt log line is skipped, not fatal', () => {
  recordCompletion('r1', completion('verified', 'high'), clean, dir)
  const path = join(dir, '.elia', 'runs', 'completion-calibration.ndjson')
  const { appendFileSync } = require('node:fs') as typeof import('node:fs')
  appendFileSync(path, 'not json\n')
  recordCompletion('r2', completion('partial', 'low'), clean, dir)
  expect(readCalibrationLog(dir).map((e) => e.runId)).toEqual(['r1', 'r2'])
})
