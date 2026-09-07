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
