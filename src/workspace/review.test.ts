import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace, registerAgentIdentity } from './admin.ts'
import { mintAgentToken } from './identity.ts'
import { runWorkspaceServer, type RunningWorkspaceServer } from './server.ts'
import { WorkspaceClient } from './client.ts'
import { runAgentRuntime, type AgentExecutor } from './agentRuntime.ts'
import type { Proposal } from '../autonomy/types.ts'

const TIMEOUT = 20_000
const cleanup: Array<() => void | Promise<void>> = []
const procs: Array<{ c: AbortController; done: Promise<void> }> = []

afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.c.abort()
    await Promise.race([p.done, Bun.sleep(400)])
  }
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn()
    } catch {
      /* best effort */
    }
  }
})

const onePlan = async (): Promise<Proposal> => ({
  goal: 'Ship the endpoint', understanding: 'x', assumptions: [], risks: [], verification: [], outOfScope: [],
  steps: [{ id: 'api', title: 'Auth API', role: 'backend', instructions: 'build it', files: ['api/auth.ts'], dependsOn: [] }],
})

async function fixture(opts: { withReviewer?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-rev-'))
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  const created = createWorkspace(store, { name: 'demo', ownerName: 'owner' })
  registerAgentIdentity(store, { name: 'be', role: 'backend', pathScopes: ['api/**'], actorId: created.ownerMemberId })
  if (opts.withReviewer) registerAgentIdentity(store, { name: 'sec', role: 'security', actorId: created.ownerMemberId })
  const server: RunningWorkspaceServer = runWorkspaceServer({ port: 0, store, planner: onePlan, sweepMs: 300 })
  cleanup.push(() => server.stop())
  cleanup.push(() => store.close())
  cleanup.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* windows */
    }
  })
  const owner = await WorkspaceClient.connect({ url: server.url, token: created.ownerToken.plaintext })
  cleanup.push(() => owner.close())

  const start = (name: string, executor: AgentExecutor): void => {
    const token = mintAgentToken(store, { identityId: store.agentIdentity(name)!.id, label: name, actorId: created.ownerMemberId }).plaintext
    const c = new AbortController()
    procs.push({ c, done: runAgentRuntime({ serverUrl: server.url, token, executor, signal: c.signal }).catch(() => {}) })
  }
  return { store, server, owner, created, start }
}

async function poll(check: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(40)
  }
  throw new Error('poll timed out')
}

test('a build task with a reviewer available goes in-review, then a human approval completes it', async () => {
  const { store, owner, start } = await fixture({ withReviewer: false })
  // No reviewer agent, but the build agent requests review explicitly.
  const build: AgentExecutor = async (job) => ({ ok: true, report: `built ${job.task.title}`, filesChanged: job.task.files })
  // Force the review gate: register a reviewer identity so agent.complete opens one.
  registerAgentIdentity(store, { name: 'crit', role: 'critic', actorId: store.members()[0]!.id })
  start('be', build)
  await Bun.sleep(150)

  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'x' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })

  await poll(() => store.tasks({ objectiveId: planned.objectiveId, status: 'in-review' }).length === 1)
  const task = store.tasks({ objectiveId: planned.objectiveId })[0]!

  await owner.call('review.submit', { taskId: task.id, verdict: 'approve' })
  await poll(() => store.task(task.id)!.status === 'done')
  expect(store.objective(planned.objectiveId)!.status).toBe('completed')
}, TIMEOUT)

test('a human "revise" verdict sends the task back to the queue with the notes attached', async () => {
  const { store, owner, start } = await fixture()
  registerAgentIdentity(store, { name: 'crit', role: 'critic', actorId: store.members()[0]!.id })
  let build = 0
  const executor: AgentExecutor = async (job) => {
    build += 1
    return { ok: true, report: `attempt ${build}`, filesChanged: job.task.files }
  }
  start('be', executor)
  await Bun.sleep(150)

  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'x' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })
  await poll(() => store.tasks({ objectiveId: planned.objectiveId, status: 'in-review' }).length === 1)
  const task = store.tasks({ objectiveId: planned.objectiveId })[0]!

  await owner.call('review.submit', { taskId: task.id, verdict: 'revise', notes: 'use argon2, not sha256' })
  await poll(() => build >= 2) // the task was sent back and re-run
  const back = store.events({ types: ['AgentMessageCreated'], objectiveId: planned.objectiveId })
    .find((event) => String(event.payload.body).includes('review sent'))
  expect(String(back?.payload.body)).toContain('argon2')
  const verdict = store.events({ types: ['ReviewCompleted'], objectiveId: planned.objectiveId })[0]!
  expect(verdict.payload.passed).toBe(false)
}, TIMEOUT)

test('a connected reviewer agent auto-reviews an in-review task and its verdict completes the work', async () => {
  const { store, owner, start } = await fixture({ withReviewer: true })
  const build: AgentExecutor = async (job) => ({ ok: true, report: 'built the API', filesChanged: job.task.files })
  const review: AgentExecutor = async () => ({ ok: true, report: 'APPROVED — the flow is sound', verdict: undefined } as never)
  start('be', build)
  start('sec', async (job) => (job.pack.mode === 'review' ? review(job) : { ok: true, report: 'n/a' }))
  await Bun.sleep(150)

  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'x' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })

  await poll(() => store.objective(planned.objectiveId)!.status === 'completed', 15_000)
  const task = store.tasks({ objectiveId: planned.objectiveId })[0]!
  expect(task.status).toBe('done')
  const reviews = store.events({ types: ['ReviewCompleted'], objectiveId: planned.objectiveId })
  expect(reviews).toHaveLength(1)
  expect(reviews[0]!.payload.passed).toBe(true)
}, TIMEOUT)
