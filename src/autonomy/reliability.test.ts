import { expect, test } from 'bun:test'
import type { CalibrationEntry } from './calibration.ts'
import { signalFromEntries } from './reliability.ts'

function entry(contradictions: string[]): CalibrationEntry {
  return {
    at: new Date().toISOString(),
    runId: Math.random().toString(36).slice(2),
    reportedState: 'verified',
    confidence: 'high',
    facts: {
      verificationPassed: true,
      reviewPassed: true,
      completedSteps: 3,
      totalSteps: 3,
      unresolvedActions: 0,
      pendingApprovals: 0,
      blockedByBudget: 0,
    },
    contradictions,
  }
}

const clean = () => entry([])
const bad = () => entry(['reported verified but verification did not pass'])
const honestFailure = (): CalibrationEntry => ({ ...entry([]), reportedState: 'failed', confidence: 'low' })

test('too little history says so and changes nothing', () => {
  const s = signalFromEntries([clean(), bad()])
  expect(s.tier).toBe('insufficient-history')
  expect(s.extraReviewers).toBe(0)
  expect(s.strictCompletion).toBe(false)
})

test('a clean record is sound', () => {
  const s = signalFromEntries(Array.from({ length: 10 }, clean))
  expect(s.tier).toBe('clean')
  expect(s.extraReviewers).toBe(0)
})

test('moderate over-claiming puts the project on watch', () => {
  // 2 of 10 = 20%
  const s = signalFromEntries([...Array.from({ length: 8 }, clean), bad(), bad()])
  expect(s.tier).toBe('watch')
  expect(s.extraReviewers).toBe(1)
  expect(s.strictCompletion).toBe(true)
})

test('frequent over-claiming marks the project unreliable', () => {
  // 5 of 10 = 50%
  const s = signalFromEntries([...Array.from({ length: 5 }, clean), ...Array.from({ length: 5 }, bad)])
  expect(s.tier).toBe('unreliable')
  expect(s.extraReviewers).toBe(2)
  expect(s.note).toContain('unproven')
})

test('only the most recent runs count — old failures age out', () => {
  const old = Array.from({ length: 20 }, bad)
  const recent = Array.from({ length: 15 }, clean)
  const s = signalFromEntries([...old, ...recent])
  expect(s.sampled).toBe(15)
  expect(s.tier).toBe('clean')
})

test('honestly-reported failures still move the project off "clean" when few runs actually verify', () => {
  // Regression: a project whose runs mostly fail but never over-claim used to
  // read as tier "clean" ("track record is sound") with zero extra scrutiny,
  // because contradictionRate alone was 0. 7 of 8 honest failures, 1 verified
  // — 12.5% of these 8 runs verified, well under LOW_SUCCESS_THRESHOLD.
  const s = signalFromEntries([...Array.from({ length: 7 }, honestFailure), clean()])
  expect(s.contradictionRate).toBe(0)
  expect(s.successRate).toBeCloseTo(0.125, 3)
  expect(s.tier).not.toBe('clean')
  expect(s.tier).toBe('watch')
  expect(s.extraReviewers).toBeGreaterThan(0)
  expect(s.note).toContain('honest')
})

test('successRate is exposed even on an otherwise-clean record', () => {
  const s = signalFromEntries(Array.from({ length: 10 }, clean))
  expect(s.successRate).toBe(1)
  expect(s.note).toContain('10/10')
})
