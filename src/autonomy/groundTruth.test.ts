import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCompletion, type CompletionFacts } from './calibration.ts'
import {
  noteTurnClaim,
  readGroundTruth,
  renderGroundTruthLines,
  resetPendingTurnClaimForTests,
  resolveOutcomeProbes,
  resolveTurnClaim,
  scoreGroundTruth,
  type GroundTruthEntry,
} from './groundTruth.ts'
import type { CompletionAssessment } from './outcome.ts'
import type { OutcomeRecord } from './outcomesClosure.ts'
import { signalFromEntries } from './reliability.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-truth-'))
  resetPendingTurnClaimForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const verifiedHigh: CompletionAssessment = { state: 'verified', confidence: 'high', summary: '', evidence: [], blockers: [], nextActions: [], completedSteps: 2, totalSteps: 2, pendingApprovals: 0 }
const facts: CompletionFacts = { verificationPassed: true, reviewPassed: true, completedSteps: 2, totalSteps: 2, unresolvedActions: 0, pendingApprovals: 0, blockedByBudget: 0 }

function probe(runId: string, status: OutcomeRecord['status'], failure?: string): OutcomeRecord {
  return { id: `o-${runId}`, title: 't', runId, createdAt: 0, dueAt: 0, status, probe: { kind: 'file-exists', path: 'x' }, attempts: 1, ...(failure ? { failure } : {}) }
}

function truth(claim: string, stated: number, held: boolean, evidence: GroundTruthEntry['evidence'] = 'outcome-probe'): GroundTruthEntry {
  return { at: '', claimId: Math.random().toString(36), source: 'run', claim, stated, held, evidence }
}

test('a decided probe scores the confidence its run claimed', () => {
  recordCompletion('run-a', verifiedHigh, facts, dir)
  recordCompletion('run-b', verifiedHigh, facts, dir)
  const recorded = resolveOutcomeProbes([probe('run-a', 'verified'), probe('run-b', 'failed', 'expected file does not exist: x')], dir)
  expect(recorded).toBe(2)
  const entries = readGroundTruth(dir)
  expect(entries.map((e) => [e.claimId, e.claim, e.stated, e.held])).toEqual([
    ['run-a', 'verified/high', 0.9, true],
    ['run-b', 'verified/high', 0.9, false],
  ])
  expect(entries[1]!.detail).toContain('does not exist')
})

test('pending, inconclusive, and unclaimed probes say nothing', () => {
  recordCompletion('run-a', verifiedHigh, facts, dir)
  const recorded = resolveOutcomeProbes([probe('run-a', 'pending'), probe('run-a', 'inconclusive'), probe('run-unknown', 'failed')], dir)
  expect(recorded).toBe(0)
  expect(readGroundTruth(dir)).toEqual([])
})

test('a disputed turn is a claim that did not hold; moving on counts as held', () => {
  noteTurnClaim('turn-1', 'pass', 3, true)
  expect(resolveTurnClaim("that's wrong, the button doesn't work", dir)).toMatchObject({ claim: 'verify:pass', held: false, evidence: 'user-reaction' })
  noteTurnClaim('turn-2', 'pass', 1, true)
  expect(resolveTurnClaim('great, now add a dark mode', dir)).toMatchObject({ held: true })
  expect(readGroundTruth(dir)).toHaveLength(2)
})

test('turns that changed nothing or ended badly are not claims', () => {
  noteTurnClaim('turn-1', 'pass', 0, true)
  expect(resolveTurnClaim("you're wrong", dir)).toBeUndefined()
  noteTurnClaim('turn-2', 'pass', 2, false)
  expect(resolveTurnClaim("you're wrong", dir)).toBeUndefined()
  // A claim is resolved once, by the very next message.
  noteTurnClaim('turn-3', 'pass', 2, true)
  resolveTurnClaim('ok', dir)
  expect(resolveTurnClaim("you're wrong", dir)).toBeUndefined()
})

test('the score shows the gap between stated and observed success', () => {
  const entries = [
    ...Array.from({ length: 6 }, (_, i) => truth('verified/high', 0.9, i < 3)),
    ...Array.from({ length: 2 }, () => truth('verified/low', 0.35, false)),
    truth('verify:pass', 0.85, false, 'user-reaction'),
  ]
  const score = scoreGroundTruth(entries, 'outcome-probe')
  expect(score.resolved).toBe(8)
  expect(score.held).toBe(3)
  expect(score.worstClaim).toBe('verified/high')
  expect(score.worstGap).toBeCloseTo(0.4)
  // verified/low has 2 samples, below the bucket floor, so it cannot be the worst gap.
  expect(score.buckets.find((b) => b.claim === 'verified/low')?.count).toBe(2)
  expect(score.brier).toBeGreaterThan(0)
})

test('overconfidence seen by outcome probes tightens the next run, even on a clean verdict record', () => {
  const overconfident = Array.from({ length: 6 }, (_, i) => truth('verified/high', 0.9, i < 2))
  const signal = signalFromEntries([], overconfident)
  expect(signal.strictCompletion).toBe(true)
  expect(signal.tier).toBe('watch')
  expect(signal.extraReviewers).toBe(1)
  expect(signal.overconfidence).toBeGreaterThan(0.5)
  expect(signal.note).toContain('verified/high')
})

test('weak user-reaction evidence and well-calibrated claims change nothing', () => {
  const weak = Array.from({ length: 6 }, () => truth('verify:pass', 0.85, false, 'user-reaction'))
  expect(signalFromEntries([], weak).strictCompletion).toBe(false)
  const calibrated = Array.from({ length: 10 }, (_, i) => truth('verified/high', 0.9, i < 9))
  expect(signalFromEntries([], calibrated).strictCompletion).toBe(false)
})

test('the runs report says which evidence each line rests on', () => {
  noteTurnClaim('turn-1', 'pass', 1, true)
  resolveTurnClaim('it does not work', dir)
  const lines = renderGroundTruthLines(dir)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('user reaction, weak')
  expect(lines[0]).toContain('0/1 claims held')
})
