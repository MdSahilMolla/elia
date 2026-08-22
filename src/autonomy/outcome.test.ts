import { expect, test } from 'bun:test'
import { assessCompletion } from './outcome.ts'

const graph = (statuses: Array<'completed' | 'ready'>, approvalStatus: 'approved' | 'pending' = 'approved') => ({
  version: 2,
  runId: 'outcome-test',
  goal: 'test goal',
  rootId: 'goal:root',
  verificationCommands: ['bun test'],
  nodes: statuses.map((status, index) => ({
    id: `step:${index + 1}`,
    kind: 'step' as const,
    title: `step ${index + 1}`,
    files: [],
    dependsOn: [],
    status,
    attemptCount: 1,
    maxAttempts: 2,
    idempotencyKey: `key-${index + 1}`,
    evidenceIds: [],
    createdAt: 0,
    updatedAt: 0,
  })),
  actions: [],
  evidence: [],
  approvals: [{ id: 'approval:plan', kind: 'plan' as const, subject: 'proposal', status: approvalStatus, at: 0 }],
  updatedAt: 0,
})

test('completion is high-confidence only when plan, steps, verification, and review all pass', () => {
  const result = assessCompletion({ outcome: 'completed', graph: graph(['completed', 'completed']), verificationPassed: true, reviewPassed: true, planApproved: true })
  expect(result.state).toBe('verified')
  expect(result.confidence).toBe('high')
  expect(result.blockers).toHaveLength(0)
})

test('completion distinguishes partial progress from proven completion', () => {
  const result = assessCompletion({ outcome: 'completed', graph: graph(['completed', 'ready']), verificationPassed: true, reviewPassed: false, planApproved: true })
  expect(result.state).toBe('partial')
  expect(result.confidence).toBe('medium')
  expect(result.blockers).toContain('1 of 2 planned step(s) completed.')
})

test('completion reports approval blocks and interrupted runs as actionable', () => {
  const blocked = assessCompletion({ outcome: 'needs-attention', graph: graph(['ready'], 'pending'), verificationPassed: false, reviewPassed: false, planApproved: false })
  expect(blocked.state).toBe('blocked')
  expect(blocked.pendingApprovals).toBe(1)
  expect(blocked.nextActions[0]).toContain('approval')

  const aborted = assessCompletion({ outcome: 'aborted', graph: graph(['completed']), verificationPassed: false, reviewPassed: false, planApproved: true })
  expect(aborted.state).toBe('aborted')
  expect(aborted.nextActions[0]).toContain('Resume')
})
