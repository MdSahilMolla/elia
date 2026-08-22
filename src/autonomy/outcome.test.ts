import { expect, test } from 'bun:test'
import { assessCompletion } from './outcome.ts'
import type { GoalGraphSnapshot } from './goalGraph.ts'

const graph = (statuses: Array<'completed' | 'ready'>, approvalStatus: 'approved' | 'pending' = 'approved'): GoalGraphSnapshot => ({
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

test('completion does not verify while a nested delegation remains unfinished', () => {
  const snapshot = graph(['completed'])
  snapshot.nodes.push({
    id: 'step:1/child:worker',
    kind: 'delegation',
    title: 'Nested worker',
    files: [],
    dependsOn: [],
    parentId: 'step:1',
    depth: 1,
    status: 'waiting-retry',
    attemptCount: 1,
    maxAttempts: 2,
    idempotencyKey: 'child-key',
    evidenceIds: [],
    createdAt: 0,
    updatedAt: 0,
  })
  const result = assessCompletion({ outcome: 'completed', graph: snapshot, verificationPassed: true, reviewPassed: true, planApproved: true })
  expect(result.state).toBe('partial')
  expect(result.blockers).toContain('1 of 2 planned work node(s) completed.')
})

test('completion does not verify while a durable action remains unresolved', () => {
  const snapshot = graph(['completed'])
  snapshot.actions.push({
    id: 'action:pending',
    nodeId: 'step:1',
    idempotencyKey: 'action-key',
    tool: 'browser',
    inputDigest: 'digest',
    state: 'human-review',
    attempts: 1,
    createdAt: 0,
    updatedAt: 0,
  })
  const result = assessCompletion({ outcome: 'completed', graph: snapshot, verificationPassed: true, reviewPassed: true, planApproved: true })
  expect(result.state).toBe('partial')
  expect(result.blockers).toContain('1 durable action(s) remain unresolved.')
})

test('completion distinguishes partial progress from proven completion', () => {
  const result = assessCompletion({ outcome: 'completed', graph: graph(['completed', 'ready']), verificationPassed: true, reviewPassed: false, planApproved: true })
  expect(result.state).toBe('partial')
  expect(result.confidence).toBe('medium')
  expect(result.blockers).toContain('1 of 2 planned work node(s) completed.')
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


test('completion does not verify after a blocked action-budget request', () => {
  const result = assessCompletion({
    outcome: 'completed',
    graph: graph(['completed']),
    verificationPassed: true,
    reviewPassed: true,
    planApproved: true,
    actionBudget: { maxActions: 1, consumed: 1, exhausted: true, blockedByBudget: 1 },
  })
  expect(result.state).toBe('partial')
  expect(result.blockers).toContain('The autonomous action budget was exhausted after 1 governed request(s).')
})
