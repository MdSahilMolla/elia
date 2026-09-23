import { expect, test } from 'bun:test'
import { assessCompletion, mapCompletionToVerify } from './outcome.ts'
import type { GoalGraphSnapshot } from './goalGraph.ts'

test('mapCompletionToVerify: an escalated run\'s real verdict reaches outcomes.jsonl instead of always "none"', () => {
  // Regression for: every autonomous (escalated) turn permanently recorded
  // verify:"none" in .elia/outcomes.jsonl regardless of the autonomous
  // pipeline's actual completion verdict, because index.ts only ever
  // reassigned verifyResult inside its non-escalated fast-path verify gate.
  expect(mapCompletionToVerify('verified')).toEqual({ verify: 'pass', aborted: false })
  expect(mapCompletionToVerify('partial')).toEqual({ verify: 'fail', aborted: false })
  expect(mapCompletionToVerify('blocked')).toEqual({ verify: 'fail', aborted: false })
  expect(mapCompletionToVerify('failed')).toEqual({ verify: 'fail', aborted: false })
})

test('mapCompletionToVerify: an aborted run is flagged aborted, not silently "clean"', () => {
  // Regression for: an aborted escalated run left verifyResult at its 'none'
  // default with aborted:false, which the lesson-efficacy "clean turn" check
  // (verify is pass/none/skipped AND not aborted) read as a clean example.
  expect(mapCompletionToVerify('aborted')).toEqual({ verify: undefined, aborted: true })
})

test('mapCompletionToVerify: no completion state (non-escalated turn) leaves the caller untouched', () => {
  expect(mapCompletionToVerify(undefined)).toEqual({ verify: undefined, aborted: false })
})

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

// Run 2026-09-23-krum-r1ir, a Python CLI: all 5 steps done, 23 tests green,
// review passed — and needs-attention, held by three refused `pip install`s the
// steps had finished without. A refused deploy in the same place must still hold.
function withRefusal(stepStatus: 'completed' | 'ready', command: string, intent: string): GoalGraphSnapshot {
  const snapshot = graph([stepStatus])
  snapshot.actions.push({
    id: 'action:refused', nodeId: 'step:1', idempotencyKey: 'refused-key', tool: 'run_command', inputDigest: 'digest',
    state: 'human-review', attempts: 1, createdAt: 0, updatedAt: 0,
  })
  snapshot.approvals.push({
    id: 'approval:action:refused', kind: 'action', subject: 'refused-key', status: 'pending',
    request: { name: 'run_command', input: { command } }, reason: 'refused unattended', intent, at: 0, mode: 'unattended',
  })
  return snapshot
}

test('a refused package install that a finished step did without is a follow-up, not a blocker', () => {
  const result = assessCompletion({ outcome: 'completed', graph: withRefusal('completed', 'pip install -e .', 'shell.code-exec'), verificationPassed: true, reviewPassed: true, planApproved: true })
  expect(result.state).toBe('verified')
  expect(result.blockers).toHaveLength(0)
  expect(result.pendingApprovals).toBe(0)
  expect(result.nextActions.some((action) => action.includes('`pip install -e .`'))).toBe(true)
})

test('a refused outward act still holds the run, however the step finished', () => {
  for (const [command, intent] of [['vercel --prod', 'shell'], ['vercel --yes --prod 2>&1', 'shell.composed'], ['git push origin main', 'shell.unknown']]) {
    const result = assessCompletion({ outcome: 'completed', graph: withRefusal('completed', command!, intent!), verificationPassed: true, reviewPassed: true, planApproved: true })
    expect(result.state).toBe('blocked')
    expect(result.pendingApprovals).toBe(1)
  }
  // An approval from before intents were recorded has nothing to read, so it holds too.
  const legacy = withRefusal('completed', 'pip install -e .', 'shell.code-exec')
  delete legacy.approvals[1]!.intent
  expect(assessCompletion({ outcome: 'completed', graph: legacy, verificationPassed: true, reviewPassed: true, planApproved: true }).state).toBe('blocked')
})

test('a refused install still counts while the step that wanted it is unfinished', () => {
  const result = assessCompletion({ outcome: 'needs-attention', graph: withRefusal('ready', 'pip install -e .', 'shell.code-exec'), verificationPassed: false, reviewPassed: false, planApproved: true })
  expect(result.blockers).toContain('1 durable action(s) remain unresolved.')
  expect(result.pendingApprovals).toBe(1)
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

// Regression: run 2026-09-10-754n-8z17 had 4 of 4 steps completed and
// verification passing, and was still reported "failed" — purely because the
// structured review had not finished. Reporting completed, verified work as a
// failure is the mirror image of claiming unverified work succeeded.
test('completed and verified work is not reported as failed when review is outstanding', () => {
  const assessment = assessCompletion({
    graph: graph(['completed', 'completed', 'completed', 'completed']),
    outcome: 'needs-attention',
    planApproved: true,
    verificationPassed: true,
    reviewPassed: false,
  })
  expect(assessment.state).not.toBe('failed')
  expect(assessment.state).toBe('partial')
  expect(assessment.completedSteps).toBe(4)
  expect(assessment.totalSteps).toBe(4)
  expect(assessment.summary).toContain('verification passed')
  // The review is still reported as an outstanding blocker, not hidden.
  expect(assessment.blockers.join(' ')).toContain('review')
})

test('work that did not complete is still a failure', () => {
  const assessment = assessCompletion({
    graph: graph(['completed', 'ready']),
    outcome: 'needs-attention',
    planApproved: true,
    verificationPassed: false,
    reviewPassed: false,
  })
  expect(assessment.state).toBe('failed')
})

test('everything green is still verified, not merely partial', () => {
  const assessment = assessCompletion({
    graph: graph(['completed', 'completed']),
    outcome: 'completed',
    planApproved: true,
    verificationPassed: true,
    reviewPassed: true,
  })
  expect(assessment.state).toBe('verified')
})
