import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GoalGraphStore, classifyFailure, type GoalGraphOptions } from './goalGraph.ts'
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
    graph.startAction(first.action.id)
    graph.finishAction(first.action.id, { ok: true, result: 'deployed' })

    const replay = graph.reserveAction(request, 'step:build')
    expect(replay.decision).toBe('replay')
    expect(replay.action.result).toBe('deployed')

    const secondRequest = { name: 'browser', input: { action: 'click', target: 'Publish' } }
    const second = graph.reserveAction(secondRequest, 'step:build')
    graph.startAction(second.action.id)
    graph.blockAction(second.action.id, 'approval required', true)
    const approval = graph.requestApproval('action', second.action.idempotencyKey, { name: 'browser' }, 'publish changes page state')
    expect(graph.reserveAction(secondRequest, 'step:build').decision).toBe('human-review')
    graph.resolveApproval(approval.id, true)
    expect(graph.reserveAction(secondRequest, 'step:build').decision).toBe('execute')
  })

  test('classifies transient, authorization, environment, and human-review failures', () => {
    expect(classifyFailure('request timed out').class).toBe('retryable')
    expect(classifyFailure('approval required').class).toBe('authorization')
    expect(classifyFailure('ENOENT: no such file').class).toBe('environment')
    expect(classifyFailure('action partially completed').class).toBe('human-review')
  })
})
