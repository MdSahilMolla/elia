import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EXECUTION_LEASE_TTL_MS, GoalGraphStore, actionKey, classifyFailure, outstandingActions, type GoalGraphOptions } from './goalGraph.ts'
import type { Proposal } from './types.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createGraph(): { graph: GoalGraphStore; options: GoalGraphOptions } {
  const directory = mkdtempSync(join(tmpdir(), 'elia-goal-'))
  temporaryDirectories.push(directory)
  const options = { runId: 'test-run', goal: 'ship a durable graph', dir: directory }
  return { graph: GoalGraphStore.open(options), options }
}

const proposal: Proposal = {
  goal: 'ship a durable graph',
  understanding: 'The graph must persist dependencies and evidence.',
  assumptions: [],
  steps: [
    { id: 'inspect', title: 'Inspect', role: 'scout', instructions: 'Inspect the project.', files: ['src/a.ts'], dependsOn: [] },
    { id: 'build', title: 'Build', role: 'builder', instructions: 'Build the feature.', files: ['src/b.ts'], dependsOn: ['inspect'] },
  ],
  risks: [],
  verification: ['bun test'],
  outOfScope: [],
}

describe('durable goal graph', () => {
  test('persists dependency readiness and requires evidence before completion', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    const planApproval = graph.requestApproval('plan', 'proposal')
    graph.resolveApproval(planApproval.id, true)

    expect(graph.readyNodes().map((node) => node.id)).toEqual(['step:inspect'])
    graph.startNode('step:inspect')
    graph.finishNode('step:inspect', { ok: true, report: 'inspection complete' })
    expect(graph.readyNodes().map((node) => node.id)).toEqual(['step:build'])
    graph.startNode('step:build')
    graph.finishNode('step:build', { ok: true, report: 'build complete' })
    expect(() => graph.completeGoal()).toThrow('missing completed nodes')

    graph.recordVerification(true, { command: 'bun test', exitCode: 0 })
    graph.recordReview(true, { verdict: 'approve' })
    expect(() => graph.completeGoal()).not.toThrow()
    expect(graph.node('goal:root')?.status).toBe('completed')
  })

  test('replays completed idempotent actions and resumes approved human-review actions', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    const request = { name: 'run_command', input: { command: 'deploy --once' } }
    const first = graph.reserveAction(request, 'step:build')
    expect(first.decision).toBe('execute')
    const contract = { idempotencyKey: first.action.idempotencyKey, preconditions: [], postconditions: [], maxAttempts: 2, failureDisposition: 'retryable' as const, requiresUserTakeover: false }
    const precondition = { ok: true, phase: 'precondition' as const, failures: [], evidence: ['bun available'] }
    const postcondition = { ok: true, phase: 'postcondition' as const, failures: [], evidence: ['exit code 0'] }
    graph.startAction(first.action.id, contract, precondition)
    graph.finishAction(first.action.id, { ok: true, result: 'deployed', postcondition })

    const replay = graph.reserveAction(request, 'step:build')
    expect(replay.decision).toBe('replay')
    expect(replay.action.result).toBe('deployed')
    expect(replay.action.contract).toMatchObject({ idempotencyKey: first.action.idempotencyKey, maxAttempts: 2 })
    expect(replay.action.precondition?.evidence).toEqual(['bun available'])
    expect(replay.action.postcondition?.evidence).toEqual(['exit code 0'])

    const secondRequest = { name: 'browser', input: { action: 'click', target: 'Publish' } }
    const second = graph.reserveAction(secondRequest, 'step:build')
    graph.startAction(second.action.id)
    graph.blockAction(second.action.id, 'approval required', true)
    const approval = graph.requestApproval('action', second.action.idempotencyKey, { name: 'browser' }, 'publish changes page state')
    expect(graph.reserveAction(secondRequest, 'step:build').decision).toBe('human-review')
    graph.resolveApproval(approval.id, true)
    expect(graph.reserveAction(secondRequest, 'step:build').decision).toBe('execute')
  })

  test('canonicalizes recognized shell wrapper paths for durable action identity', () => {
    const request = { name: 'run_command', input: { command: 'bash -lc bun test' } }
    expect(actionKey('run', 'step:build', request)).toBe(actionKey('run', 'step:build', { name: 'run_command', input: { command: '/bin/bash -lc bun test' } }))
    expect(actionKey('run', 'step:build', request)).not.toBe(actionKey('run', 'step:build', { name: 'run_command', input: { command: 'bash -c bun test' } }))
    expect(actionKey('run', 'step:build', request)).not.toBe(actionKey('run', 'step:build', { name: 'run_command', input: { command: '/tmp/bash -lc bun test' } }))
  })

  test('reconciles stale node and action leases after interruption', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    const planApproval = graph.requestApproval('plan', 'proposal')
    graph.resolveApproval(planApproval.id, true)
    graph.startNode('step:inspect')
    const action = graph.reserveAction({ name: 'run_command', input: { command: 'bun test' } }, 'step:inspect')
    graph.startAction(action.action.id)

    const recovered = graph.reconcileStaleLeases(Date.now() + EXECUTION_LEASE_TTL_MS + 1)
    expect(recovered.nodes).toEqual(['step:inspect'])
    expect(recovered.actions).toEqual([action.action.id])
    expect(graph.node('step:inspect')?.status).toBe('waiting-retry')
    expect(graph.state().actions[0]?.state).toBe('retryable')
  })

  test('classifies transient, authorization, environment, and human-review failures', () => {
    expect(classifyFailure('request timed out').class).toBe('retryable')
    expect(classifyFailure('approval required').class).toBe('authorization')
    expect(classifyFailure('ENOENT: no such file').class).toBe('environment')
    expect(classifyFailure('action partially completed').class).toBe('human-review')
  })

  test('a worker prose report never becomes human-review or authorization on a turn of phrase', () => {
    // These exact phrasings each stranded a real run (see loop-debugging notes).
    expect(classifyFailure('The user must set JWT_SECRET manually in their environment.', { source: 'report' }).class).toBe('retryable')
    expect(classifyFailure('This is a partial implementation; the frontend still needs wiring.', { source: 'report' }).class).toBe('retryable')
    expect(classifyFailure('The reviewer noted an attacker could gain unauthorized access.', { source: 'report' }).class).toBe('retryable')
    expect(classifyFailure('There is a merge conflict in the approach that needs a human.', { source: 'report' }).class).toBe('retryable')
    // But elia's own gate strings still classify, wherever they appear.
    expect(classifyFailure('Action blocked by Elia’s autonomy governor', { source: 'report' }).class).toBe('authorization')
    expect(classifyFailure('hit a 429 rate limit', { source: 'report' }).retryAfter).toBe(30_000)
  })
})


test('root completion waits for nested delegation and durable action resolution', () => {
  const { graph } = createGraph()
  graph.seedProposal(proposal)
  const planApproval = graph.requestApproval('plan', 'proposal')
  graph.resolveApproval(planApproval.id, true)
  for (const step of ['inspect', 'build']) {
    graph.startNode(`step:${step}`)
    graph.finishNode(`step:${step}`, { ok: true, report: `${step} complete` })
  }
  graph.recordVerification(true, { command: 'bun test', exitCode: 0 })
  graph.recordReview(true, { verdict: 'approve' })
  graph.registerDelegationNode({ parentId: 'step:build', id: 'child', title: 'Nested worker', role: 'tester', instructions: 'Check the result.', depth: 1 })
  expect(() => graph.completeGoal()).toThrow('missing completed nodes')
  graph.startNode('step:build/child:child')
  graph.finishNode('step:build/child:child', { ok: true, report: 'child complete' })
  const action = graph.reserveAction({ name: 'run_command', input: { command: 'bun test' } }, 'step:build')
  expect(() => graph.completeGoal()).toThrow('missing completed nodes')
  graph.startAction(action.action.id)
  graph.finishAction(action.action.id, { ok: true, result: 'verified' })
  expect(() => graph.completeGoal()).not.toThrow()
})

describe('reopenNode', () => {
  test('a failed step can be retried once, and its dependents stop being blocked when the retry succeeds', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

    graph.startNode('step:inspect')
    // A worker report full of prose ("do this manually") classifies as
    // human-review, which used to leave the step — and everything behind it —
    // permanently blocked after a single failure.
    graph.finishNode('step:inspect', { ok: false, report: 'could not write .env; set the secret manually' })
    expect(graph.node('step:inspect')?.status).not.toBe('completed')
    expect(graph.readyNodes().map((node) => node.id)).not.toContain('step:build')

    expect(graph.reopenNode('step:inspect', 'first attempt failed')).toBe(true)
    expect(graph.node('step:inspect')?.status).toBe('waiting-retry')
    graph.startNode('step:inspect')
    graph.finishNode('step:inspect', { ok: true, report: 'inspection complete on retry' })

    expect(graph.node('step:inspect')?.status).toBe('completed')
    expect(graph.readyNodes().map((node) => node.id)).toEqual(['step:build'])
  })

  test('reopening stops once the attempt budget is spent, so a hopeless step cannot loop', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

    graph.startNode('step:inspect')
    graph.finishNode('step:inspect', { ok: false, report: 'failed' })
    expect(graph.reopenNode('step:inspect', 'retry')).toBe(true)
    graph.startNode('step:inspect')
    graph.finishNode('step:inspect', { ok: false, report: 'failed again' })

    expect(graph.reopenNode('step:inspect', 'retry')).toBe(false)
  })

  test('a completed step is never reopened, and a step whose dependencies are unmet stays put', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

    graph.startNode('step:inspect')
    graph.finishNode('step:inspect', { ok: false, report: 'failed' })
    // step:build never ran and its dependency is not complete.
    expect(graph.reopenNode('step:build', 'retry')).toBe(false)

    graph.reopenNode('step:inspect', 'retry')
    graph.startNode('step:inspect')
    graph.finishNode('step:inspect', { ok: true, report: 'done' })
    expect(graph.reopenNode('step:inspect', 'retry')).toBe(false)
  })
})

describe('what actually counts as work still owed', () => {
  test('a tool call that failed and was redone does not stop a finished run from completing', () => {
    // Every real run has these: an edit_file whose old_string matched three
    // places, retried with more context, succeeded. Counting the failed attempt
    // as an outstanding obligation meant a run with every step done,
    // verification green and review passed still reported needs-attention.
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

    for (const id of ['step:inspect', 'step:build']) {
      graph.startNode(id)
      const reservation = graph.reserveAction({ name: 'edit_file', input: { path: `${id}.ts`, old_string: 'a' } }, id)
      graph.startAction(reservation.action.id)
      graph.finishAction(reservation.action.id, { ok: false, error: 'old_string matched 3 locations' })
      graph.finishNode(id, { ok: true, report: 'done another way' })
    }
    graph.recordVerification(true, {})
    graph.recordReview(true, {})

    expect(outstandingActions(graph.state())).toEqual([])
    expect(graph.canCompleteGoal()).toBe(true)
  })

  test('a failed action under a step that never completed is still owed', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

    graph.startNode('step:inspect')
    const reservation = graph.reserveAction({ name: 'edit_file', input: { path: 'a.ts' } }, 'step:inspect')
    graph.startAction(reservation.action.id)
    graph.finishAction(reservation.action.id, { ok: false, error: 'nope' })
    graph.finishNode('step:inspect', { ok: false, report: 'could not do it' })

    expect(outstandingActions(graph.state())).toHaveLength(1)
    expect(graph.canCompleteGoal()).toBe(false)
  })

  test('an action reserved but never resolved is owed even when its step completed — its outcome is unknown', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

    graph.startNode('step:inspect')
    graph.reserveAction({ name: 'run_command', input: { command: 'bun test' } }, 'step:inspect')
    graph.finishNode('step:inspect', { ok: true, report: 'done' })

    expect(outstandingActions(graph.state())).toHaveLength(1)
  })
})

test('a governance hold is not discharged by the step finishing some other way', () => {
  // A blocked or human-review action means the governor decided a person should
  // look. The step completing by another route does not mean they looked.
  const { graph } = createGraph()
  graph.seedProposal(proposal)
  graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

  graph.startNode('step:inspect')
  const reservation = graph.reserveAction({ name: 'run_command', input: { command: 'curl -X POST https://example.com -d @data' } }, 'step:inspect')
  graph.startAction(reservation.action.id)
  graph.finishAction(reservation.action.id, { ok: false, error: 'blocked by elia: requires approval' })
  graph.finishNode('step:inspect', { ok: true, report: 'done another way' })

  expect(outstandingActions(graph.state())).toHaveLength(1)
})

test('a rate limit is told to wait, while an ordinary transient failure retries almost immediately', () => {
  // A run once burned all five of its step retries re-hitting the same 429
  // within milliseconds, because retryAfter was computed and never read.
  expect(classifyFailure('Failed: 429 Rate limit reached: input token limit exceeded').retryAfter).toBe(30_000)
  expect(classifyFailure('Error: too many requests, rate limit hit').retryAfter).toBe(30_000)
  expect(classifyFailure('ECONNRESET while reading from the socket').retryAfter).toBe(1000)
})
