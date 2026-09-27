import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ACTION_APPROVAL_TTL_MS, EXECUTION_LEASE_TTL_MS, GoalGraphStore, actionKey, classifyFailure, isReportingTool, outstandingActions, readGoalGraphSnapshot, type GoalGraphOptions } from './goalGraph.ts'
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

  test('startAction is idempotent for the owning execution and refuses a live foreign owner', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    const action = graph.reserveAction({ name: 'run_command', input: { command: 'deploy --once' } }, 'step:build')
    expect(action.decision).toBe('execute')

    const first = graph.startAction(action.action.id)
    const repeated = graph.startAction(action.action.id)
    expect(repeated.state).toBe('running')
    expect(repeated.attempts).toBe(1)
    expect(repeated.id).toBe(first.id)

    // A *different, still-alive* elia process (this test's own pid) holds a
    // valid lease: the caller must refuse to stamp over it and start a second
    // execution of the same durable action.
    
    const graphPath = join(temporaryDirectories.at(-1)!, 'goal-graph.json')
    const snapshot = JSON.parse(readFileSync(graphPath, 'utf8'))
    const actionRecord = snapshot.actions.find((a: { id: string }) => a.id === action.action.id)
    actionRecord.leaseOwner = `${process.pid}:foreign-worker`
    actionRecord.leaseExpiresAt = Date.now() + 60_000
    writeFileSync(graphPath, JSON.stringify(snapshot))

    const reopened = GoalGraphStore.open({ runId: 'test-run', goal: 'ship a durable graph', dir: temporaryDirectories.at(-1)! })
    expect(() => reopened.startAction(action.action.id)).toThrow(/still being executed by a live owner/)
    expect(reopened.state().actions.find((a) => a.id === action.action.id)?.state).toBe('running')
  })

  test('startAction reclaims a stale lease from a dead owner but only once', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    const action = graph.reserveAction({ name: 'run_command', input: { command: 'deploy --once' } }, 'step:build')
    graph.startAction(action.action.id)

    // Simulate a crashed worker: its pid can never be reaped, so it reads dead.
    const graphPath = join(temporaryDirectories.at(-1)!, 'goal-graph.json')
    const snapshot = JSON.parse(readFileSync(graphPath, 'utf8'))
    const actionRecord = snapshot.actions.find((a: { id: string }) => a.id === action.action.id)
    actionRecord.leaseOwner = '2147483647:ghost'
    actionRecord.leaseExpiresAt = Date.now() - 5_000
    writeFileSync(graphPath, JSON.stringify(snapshot))

    const reopened = GoalGraphStore.open({ runId: 'test-run', goal: 'ship a durable graph', dir: temporaryDirectories.at(-1)! })
    const restarted = reopened.startAction(action.action.id)
    expect(restarted.state).toBe('running')
    expect(restarted.attempts).toBe(2)

    // The reclaimed slot is now held by a live owner again: no third start.
    expect(() => reopened.startAction(action.action.id)).not.toThrow()
    expect(reopened.state().actions.find((a) => a.id === action.action.id)?.attempts).toBe(2)
  })

  test('does not reclaim an expired lease whose owner process is still alive until the grace elapses', () => {
    const { graph, options } = createGraph()
    graph.seedProposal(proposal)
    graph.startNode('step:inspect')

    // Rewrite the persisted lease to look like a *different, still-running* elia
    // process (this test's own pid) whose lease just expired.
    const graphPath = join(options.dir, 'goal-graph.json')
    const snapshot = JSON.parse(readFileSync(graphPath, 'utf8'))
    const node = snapshot.nodes.find((n: { id: string }) => n.id === 'step:inspect')
    node.leaseOwner = `${process.pid}:foreign-worker`
    node.leaseExpiresAt = Date.now() - 1_000
    writeFileSync(graphPath, JSON.stringify(snapshot))

    // Just past expiry: the owner is alive, so it is given a grace window.
    expect(graph.reconcileStaleLeases(Date.now()).nodes).toEqual([])
    expect(graph.node('step:inspect')?.status).toBe('running')

    // Well past the grace: reclaimed even though the pid is alive (wedged worker).
    expect(graph.reconcileStaleLeases(Date.now() + EXECUTION_LEASE_TTL_MS * 4).nodes).toEqual(['step:inspect'])
    expect(graph.node('step:inspect')?.status).toBe('waiting-retry')
  })

  test('reserveAction does not reclaim an expired lease held by a live owner inside the grace window', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    const request = { name: 'run_command', input: { command: 'deploy --once' } }
    const reserved = graph.reserveAction(request, 'step:build')
    expect(reserved.decision).toBe('execute')
    graph.startAction(reserved.action.id)

    // A different, still-alive elia process (this test's own pid) holds a lease
    // that just expired. Reclaiming it now would hand a second worker `execute`
    // while the first is merely stalled past the TTL — the duplicate-outward-act
    // bug this guard exists for.
    const snapshot = JSON.parse(readFileSync(graph.path, 'utf8'))
    const record = snapshot.actions.find((a: { id: string }) => a.id === reserved.action.id)
    record.leaseOwner = `${process.pid}:foreign-worker`
    record.leaseExpiresAt = Date.now() - 1_000
    writeFileSync(graph.path, JSON.stringify(snapshot))

    const again = graph.reserveAction(request, 'step:build')
    expect(again.decision).toBe('human-review')
    expect(again.action.state).toBe('running')
    expect(again.action.leaseOwner).toBe(`${process.pid}:foreign-worker`)
    expect(again.action.leaseExpiresAt).toBeLessThanOrEqual(Date.now())
  })

  test('reserveAction reclaims an expired lease from a dead owner, or a live owner past the grace window', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    const request = { name: 'run_command', input: { command: 'deploy --once' } }
    const reserved = graph.reserveAction(request, 'step:build')
    graph.startAction(reserved.action.id)

    // Dead owner pid: expiry alone is enough to reclaim.
    let snapshot = JSON.parse(readFileSync(graph.path, 'utf8'))
    let record = snapshot.actions.find((a: { id: string }) => a.id === reserved.action.id)
    record.leaseOwner = '2147483647:ghost'
    record.leaseExpiresAt = Date.now() - 5_000
    writeFileSync(graph.path, JSON.stringify(snapshot))

    let again = graph.reserveAction(request, 'step:build')
    expect(again.decision).toBe('execute')
    expect(again.action.state).toBe('retryable')
    expect(again.action.leaseOwner).toBeUndefined()

    // Live owner, but well past LEASE_LIVE_OWNER_GRACE_MS (3× the TTL): reclaimed.
    snapshot = JSON.parse(readFileSync(graph.path, 'utf8'))
    record = snapshot.actions.find((a: { id: string }) => a.id === reserved.action.id)
    record.state = 'running'
    record.leaseOwner = `${process.pid}:wedged-worker`
    record.leaseExpiresAt = Date.now() - EXECUTION_LEASE_TTL_MS * 4
    writeFileSync(graph.path, JSON.stringify(snapshot))

    again = graph.reserveAction(request, 'step:build')
    expect(again.decision).toBe('execute')
    expect(again.action.state).toBe('retryable')
    expect(again.action.leaseOwner).toBeUndefined()
  })

  test('reserveAction reclaims an expired EXECUTION_OWNER lease with no live-owner grace', () => {
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    const request = { name: 'run_command', input: { command: 'deploy --once' } }
    const reserved = graph.reserveAction(request, 'step:build')
    graph.startAction(reserved.action.id)

    // EXECUTION_OWNER carries this process's own pid — alive — yet it is exempt
    // from the grace window (mirrors isLeaseGenuinelyStale), so an expired
    // lease is reclaimed immediately.
    const snapshot = JSON.parse(readFileSync(graph.path, 'utf8'))
    const record = snapshot.actions.find((a: { id: string }) => a.id === reserved.action.id)
    expect(record.leaseOwner.split(':')[0]).toBe(String(process.pid))
    record.leaseExpiresAt = Date.now() - 1
    writeFileSync(graph.path, JSON.stringify(snapshot))

    const again = graph.reserveAction(request, 'step:build')
    expect(again.decision).toBe('execute')
    expect(again.action.state).toBe('retryable')
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

  test('what an advisory worker was refused is not work the goal owes', () => {
    // Run 2026-09-15-cqd0-omdu: every step done, the render check passing, the
    // review approving — and still needs-attention, because the assumption
    // scout's exploratory reads outside its workspace were refused unattended
    // and sat as human-review holds under `check:assumptions`, which is not a
    // node of the goal at all.
    const { graph } = createGraph()
    graph.seedProposal(proposal)
    graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)
    const refused = graph.reserveAction({ name: 'read_file', input: { path: 'D:/elsewhere/notes.md' } }, 'check:assumptions')
    graph.requestApproval('action', refused.action.idempotencyKey, { name: 'read_file' }, 'reaches outside the workspace')
    graph.blockAction(refused.action.id, 'Action blocked by Elia’s unattended policy: read_file may access data outside the active workspace', true)
    for (const id of ['step:inspect', 'step:build']) {
      graph.startNode(id)
      graph.finishNode(id, { ok: true, report: 'done' })
    }
    graph.recordVerification(true, {})
    graph.recordReview(true, {})

    expect(outstandingActions(graph.state())).toEqual([])
    expect(graph.canCompleteGoal()).toBe(true)
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

test('a completed step carrying only settled local refusals is not re-run on resume', () => {
  // Run 2026-09-23-krum-r1ir: refused `pip install` calls (LOCAL_ONLY intents)
  // under a step that then completed. `needsResumption` once treated the
  // lingering human-review holds as outstanding, so the executor re-ran the
  // whole finished step every wave. It must now mirror `outstandingActions`.
  const { graph } = createGraph()
  graph.seedProposal(proposal)
  graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

  graph.startNode('step:inspect')
  const install = graph.reserveAction({ name: 'run_command', input: { command: 'pip install -e .' } }, 'step:inspect')
  graph.blockAction(install.action.id, 'approval required', true)
  graph.requestApproval('action', install.action.idempotencyKey, { name: 'run_command' }, 'local package install', 'unattended', 'shell.code-exec')
  graph.finishNode('step:inspect', { ok: true, report: 'done another way' })

  expect(outstandingActions(graph.state())).toEqual([])
  expect(graph.needsResumption('step:inspect')).toBe(false)
  const reopened = graph.startNode('step:inspect')
  expect(reopened.status).toBe('completed')
  expect(reopened.attemptCount).toBe(1) // not bumped by the resume-path re-entry

  // Contrast: an outward hold (curl, deploys) stays outstanding even after the
  // step completes, so the step stays resumable until a person answers.
  const graph2 = createGraph().graph
  graph2.seedProposal(proposal)
  graph2.resolveApproval(graph2.requestApproval('plan', 'proposal').id, true)
  graph2.startNode('step:inspect')
  const outward = graph2.reserveAction({ name: 'run_command', input: { command: 'curl -X POST https://example.com -d @data' } }, 'step:inspect')
  graph2.blockAction(outward.action.id, 'approval required', true)
  graph2.finishNode('step:inspect', { ok: true, report: 'done another way' })
  expect(outstandingActions(graph2.state())).toHaveLength(1)
  expect(graph2.needsResumption('step:inspect')).toBe(true)
  expect(graph2.startNode('step:inspect').attemptCount).toBe(2)
})

test('a step that failed fatally still stops for review on resume, whatever became of its actions', () => {
  // `startNode` lets a failed step run again without a person only when
  // `needsResumption` says so. A failed step nearly always carries a failed
  // action; counting that as "needs resumption" re-ran fatal failures.
  const { graph } = createGraph()
  graph.seedProposal(proposal)
  graph.resolveApproval(graph.requestApproval('plan', 'proposal').id, true)

  graph.startNode('step:inspect')
  const write = graph.reserveAction({ name: 'write_file', input: { path: 'src/a.ts' } }, 'step:inspect')
  graph.startAction(write.action.id)
  graph.finishAction(write.action.id, { ok: false, error: 'invariant violated: schema mismatch' })
  graph.finishNode('step:inspect', { ok: false, error: 'invariant violated: schema mismatch' })

  expect(graph.node('step:inspect')?.status).toBe('failed')
  expect(graph.state().actions[0]?.state).toBe('failed')
  expect(graph.needsResumption('step:inspect')).toBe(false)
  expect(() => graph.startNode('step:inspect')).toThrow('requires human review')
})

test('a rate limit is told to wait, while an ordinary transient failure retries almost immediately', () => {
  // A run once burned all five of its step retries re-hitting the same 429
  // within milliseconds, because retryAfter was computed and never read.
  expect(classifyFailure('Failed: 429 Rate limit reached: input token limit exceeded').retryAfter).toBe(30_000)
  expect(classifyFailure('Error: too many requests, rate limit hit').retryAfter).toBe(30_000)
  expect(classifyFailure('ECONNRESET while reading from the socket').retryAfter).toBe(1000)
})

describe('corrupt durable state does not crash and is not confused with "no state"', () => {
  test('readGoalGraphSnapshot returns undefined (not a throw) for a torn file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elia-goal-'))
    temporaryDirectories.push(directory)
    writeFileSync(join(directory, 'goal-graph.json'), '{ "runId": "test-run", "nodes": [ NOT VALID JSON')

    expect(() => readGoalGraphSnapshot(directory)).not.toThrow()
    expect(readGoalGraphSnapshot(directory)).toBeUndefined()
  })

  test('GoalGraphStore.open falls back to a fresh graph instead of throwing on a torn file', () => {
    // Regression: a corrupt goal-graph.json used to be swallowed with no trace
    // anywhere — `elia resume` would silently start over from a bare root node
    // and nothing recorded that state had actually been lost versus never
    // existing. The fallback-to-fresh behavior itself is intentional (a torn
    // file must not crash the run); what this locks in is that opening still
    // succeeds and produces a valid, usable graph rather than throwing.
    const directory = mkdtempSync(join(tmpdir(), 'elia-goal-'))
    temporaryDirectories.push(directory)
    writeFileSync(join(directory, 'goal-graph.json'), '{ this is not json at all')

    const options = { runId: 'test-run', goal: 'recover from a torn snapshot', dir: directory }
    let graph: GoalGraphStore | undefined
    expect(() => {
      graph = GoalGraphStore.open(options)
    }).not.toThrow()
    expect(graph!.state().runId).toBe('test-run')
    expect(graph!.state().nodes).toHaveLength(1)
  })

  test('a torn goal-graph.json is quarantined, not overwritten by the fresh-root persist', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elia-goal-'))
    temporaryDirectories.push(directory)
    // Cut off mid-write: the only copy of the recoverable records.
    const corruptBytes = '{ "runId": "test-run", "nodes": [ cut off mid-write'
    const graphPath = join(directory, 'goal-graph.json')
    writeFileSync(graphPath, corruptBytes)

    const store = GoalGraphStore.open({ runId: 'test-run', goal: 'recover from a torn snapshot', dir: directory })
    expect(store.state().runId).toBe('test-run')
    expect(store.state().nodes).toHaveLength(1)
    expect(store.openTornSnapshot?.path.startsWith(join(directory, 'goal-graph.json.corrupt-'))).toBe(true)
    // The corrupt bytes no longer live at goal-graph.json (open replaced it with
    // a fresh snapshot at the same path)...
    expect(readFileSync(graphPath, 'utf8')).not.toBe(corruptBytes)
    expect((JSON.parse(readFileSync(graphPath, 'utf8')) as { runId: string }).runId).toBe('test-run')
    // ...and the exact original bytes survive aside, untouched by that persist.
    const quarantined = readdirSync(directory).filter((name) => name.startsWith('goal-graph.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    const quarantinePath = join(directory, quarantined[0]!)
    expect(readFileSync(quarantinePath, 'utf8')).toBe(corruptBytes)

    // A later persist must not clobber the quarantine either.
    store.reserveAction({ name: 'run_command', input: { command: 'echo still here' } })
    expect(readFileSync(quarantinePath, 'utf8')).toBe(corruptBytes)
    expect(readdirSync(directory).filter((name) => name.startsWith('goal-graph.json.corrupt-'))).toHaveLength(1)
  })

  test('a valid goal-graph.json opens normally with no quarantine file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elia-goal-'))
    temporaryDirectories.push(directory)
    const options = { runId: 'test-run', goal: 'valid snapshot', dir: directory }
    const first = GoalGraphStore.open(options)
    first.reserveAction({ name: 'run_command', input: { command: 'bun test' } }, 'goal:root')

    const reopened = GoalGraphStore.open(options)
    expect(reopened.state().actions).toHaveLength(1)
    expect(reopened.openTornSnapshot).toBeUndefined()
    expect(readdirSync(directory).filter((name) => name.includes('.corrupt-'))).toEqual([])
  })
})

// Run 2026-09-13-l0av-rnq0 lost steps s2 and s3 to this exact message. It
// matched none of the classifier's spellings, so `retryAfter` stayed unset,
// the wave executor computed `backoffMs: 0`, and the single retry each step
// gets was spent re-sending a request of almost identical size — which failed
// identically. Both the class and the delay matter here.
const LIVE_413_TPM =
  '413 Request too large for model `openai/gpt-oss-120b` in organization `org_01jjz` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 42323, please reduce your message size and try again.'

test('a 413 token-per-minute failure in a worker report is retryable with a real delay', () => {
  const record = classifyFailure(LIVE_413_TPM, { source: 'report' })
  expect(record.class).toBe('retryable')
  expect(record.retryAfter).toBe(60_000)
})

test('a 413 token-per-minute failure as a thrown error is retryable, not fatal', () => {
  const record = classifyFailure(new Error(LIVE_413_TPM))
  expect(record.class).toBe('retryable')
  expect(record.retryAfter).toBe(60_000)
})

test('rate_limit_exceeded is retryable rather than fatal', () => {
  expect(classifyFailure(new Error('rate_limit_exceeded')).class).toBe('retryable')
})

// A capacity failure must not be read as a broken environment: "fix the
// environment or hand off" is the one recovery that cannot help here.
test('a context overflow is retryable, not an environment failure', () => {
  expect(classifyFailure(new Error('context_length_exceeded')).class).toBe('retryable')
})

// A reporting tool's whole effect is the value it captures in this process.
// Replaying its recorded result string returns "Verdict recorded." while
// capturing nothing, so `requireCriticVerdict` fails closed with "submit_verdict
// was never called" — on every review round after the first. Reproduced end to
// end: round 1 replayed=false, rounds 2 and 3 replayed=true with all three
// reviewers reported as silent, and the run exhausted its repair budget.
test('reporting tools are excluded from durable-action replay', () => {
  for (const name of ['submit_verdict', 'submit_acceptance', 'submit_proposal', 'submit_lessons', 'revise_plan']) {
    expect(isReportingTool(name)).toBe(true)
  }
})

// Tools that touch the world keep replay — that is what it is for.
test('world-touching tools still replay', () => {
  for (const name of ['write_file', 'edit_file', 'run_command', 'github', 'deployment', 'browser']) {
    expect(isReportingTool(name)).toBe(false)
  }
})

// The underlying behaviour the exclusion protects: an identical repeated call
// is otherwise served from the ledger without executing.
test('an identical completed action is otherwise replayed rather than re-executed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-replay-'))
  try {
    const graph = GoalGraphStore.open({ runId: 'replay-run', goal: 'g', dir })
    const request = { name: 'submit_verdict', input: { verdict: 'approve', summary: 'Looks correct.' } }
    const first = graph.reserveAction(request, 'goal:root')
    expect(first.decision).toBe('execute')
    graph.startAction(first.action.id)
    graph.finishAction(first.action.id, { ok: true, result: 'Verdict recorded.' })
    expect(graph.reserveAction(request, 'goal:root').decision).toBe('replay')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A governor refusal or a failed precondition that the worker then routed
// around is not outstanding work — its step completed. Counting it made the
// receipt list blockers no one could act on ("20 durable action(s) remain
// unresolved") and pushed finished runs to `needs-attention`. Five of the
// twenty in run 2026-09-13-l0av-rnq0 were exactly this shape.
test('a blocked action whose step completed is not outstanding', () => {
  const snapshot = {
    version: 2, runId: 'r', goal: 'g', rootId: 'goal:root', verificationCommands: [],
    nodes: [
      { id: 'goal:root', status: 'completed' },
      { id: 'step:s1', status: 'completed' },
      { id: 'step:s2', status: 'failed' },
    ],
    actions: [
      { id: 'a1', nodeId: 'step:s1', state: 'blocked' },
      { id: 'a2', nodeId: 'step:s2', state: 'blocked' },
      { id: 'a3', nodeId: 'step:s1', state: 'human-review' },
      { id: 'a4', nodeId: 'step:s1', state: 'planned' },
    ],
    evidence: [], approvals: [], updatedAt: 0,
  } as never

  const outstanding = outstandingActions(snapshot).map((action) => action.id)
  expect(outstanding).not.toContain('a1')
  // Its step failed, so it is still real outstanding work.
  expect(outstanding).toContain('a2')
  // A person was asked to decide; the step finishing around them is not an answer.
  expect(outstanding).toContain('a3')
  // Never started: genuinely unfinished.
  expect(outstanding).toContain('a4')
})

// A4-02: a durable approval survives a graph reopen (that is its purpose), but
// it may never fund a run in a DIFFERENT governance mode. Consent given to a
// supervised session with a person at the terminal is not consent for an
// unattended or scheduled execution.
test('a durable action approval only funds the governance mode that granted it', () => {
  const { graph } = createGraph()
  graph.seedProposal(proposal)
  const request = { name: 'run_command', input: { command: 'npm publish' } }
  const reserved = graph.reserveAction(request, 'step:build')
  const approval = graph.requestApproval('action', reserved.action.idempotencyKey, request, 'granted interactively', 'supervised')
  graph.resolveApproval(approval.id, true)

  expect(graph.isActionApproved(request, 'step:build', 'supervised')).toBe(true)
  expect(graph.isActionApproved(request, 'step:build', 'unattended')).toBe(false)
  // A caller that does not track modes (legacy shape) still sees the approval.
  expect(graph.isActionApproved(request, 'step:build')).toBe(true)
})

test('a durable action approval lapses after its time bound', () => {
  const { graph } = createGraph()
  graph.seedProposal(proposal)
  const request = { name: 'run_command', input: { command: 'npm publish' } }
  const reserved = graph.reserveAction(request, 'step:build')
  const approval = graph.requestApproval('action', reserved.action.idempotencyKey, request, undefined, 'unattended')
  const resolved = graph.resolveApproval(approval.id, true)

  expect(graph.isActionApproved(request, 'step:build', 'unattended')).toBe(true)
  // Advance the clock past the approval's TTL: the durable "yes" must not cash
  // out a later resume.
  setSystemTime((resolved.resolvedAt ?? 0) + ACTION_APPROVAL_TTL_MS + 1_000)
  try {
    expect(graph.isActionApproved(request, 'step:build', 'unattended')).toBe(false)
  } finally {
    setSystemTime()
  }
})

test('legacy approvals recorded without mode or expiry never fund a run (fail closed)', async () => {
  const { graph, options } = createGraph()
  graph.seedProposal(proposal)
  const request = { name: 'run_command', input: { command: 'npm publish' } }
  const reserved = graph.reserveAction(request, 'step:build')
  const approval = graph.requestApproval('action', reserved.action.idempotencyKey, request)
  graph.resolveApproval(approval.id, true)

  // Simulate a PRE-FIX snapshot on disk: the action approval is approved but
  // carries neither mode nor expiresAt. Reopen the graph exactly like a resume
  // would; the durable yes must not fund anything.
  const onDisk = JSON.parse(readFileSync(graph.path, 'utf8')) as { approvals: Array<Record<string, unknown>> }
  for (const record of onDisk.approvals) {
    delete record.mode
    delete record.expiresAt
  }
  writeFileSync(graph.path, JSON.stringify(onDisk, null, 2))
  const reopened = GoalGraphStore.open(options)

  expect(reopened.isActionApproved(request, 'step:build', 'unattended')).toBe(false)
  expect(reopened.isActionApproved(request, 'step:build', 'supervised')).toBe(false)
  // A caller that predates mode tracking also gets no credit: no expiresAt.
  expect(reopened.isActionApproved(request, 'step:build')).toBe(false)
})
