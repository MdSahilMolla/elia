import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EXECUTION_LEASE_TTL_MS, GoalGraphStore, classifyFailure, type GoalGraphOptions } from './goalGraph.ts'
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
})
