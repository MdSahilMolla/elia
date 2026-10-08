import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace, registerAgentIdentity } from './admin.ts'
import { mintAgentToken } from './identity.ts'
import { runWorkspaceServer, type RunningWorkspaceServer } from './server.ts'
import { WorkspaceClient } from './client.ts'
import { runAgentRuntime, type AgentExecutor } from './agentRuntime.ts'
import { agentInstanceId, dispatchAgentRpc } from './rpcAgents.ts'
import { resolveCaller } from './identity.ts'
import type { Proposal } from '../autonomy/types.ts'

const TIMEOUT = 20_000

const cleanup: Array<() => void | Promise<void>> = []
const runtimeProcs: Array<{ controller: AbortController; done: Promise<void> }> = []

afterEach(async () => {
  for (const proc of runtimeProcs.splice(0)) {
    proc.controller.abort()
    await Promise.race([proc.done, Bun.sleep(400)])
  }
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn()
    } catch {
      /* best effort */
    }
  }
})

const authPlan = async (): Promise<Proposal> => ({
  goal: 'Build authentication', understanding: 'fresh', assumptions: [], risks: [], verification: ['bun test'], outOfScope: [],
  steps: [
    { id: 'api', title: 'Auth API', role: 'backend', instructions: 'build POST /login', files: ['api/auth.ts'], dependsOn: [] },
    { id: 'ui', title: 'Login form', role: 'frontend', instructions: 'build the form', files: ['ui/Login.tsx'], dependsOn: [] },
    { id: 'tests', title: 'Auth tests', role: 'tester', instructions: 'test the API', files: ['api/auth.test.ts'], dependsOn: ['api'] },
  ],
})

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-rt-'))
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  const created = createWorkspace(store, { name: 'demo', ownerName: 'owner' })
  for (const spec of [
    { name: 'be', role: 'backend', paths: ['api/**'] },
    { name: 'fe', role: 'frontend', paths: ['ui/**'] },
    { name: 'qa', role: 'tester', paths: ['api/**'] },
  ] as const) {
    registerAgentIdentity(store, { name: spec.name, role: spec.role, pathScopes: [...spec.paths], actorId: created.ownerMemberId })
  }
  const server: RunningWorkspaceServer = runWorkspaceServer({ port: 0, store, planner: authPlan, sweepMs: 300, mesh: false })
  cleanup.push(() => server.stop())
  cleanup.push(() => store.close())
  cleanup.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* windows lock */
    }
  })
  const owner = await WorkspaceClient.connect({ url: server.url, token: created.ownerToken.plaintext })
  cleanup.push(() => owner.close())

  const startRuntime = (name: string, executor: AgentExecutor): void => {
    const token = mintAgentToken(store, { identityId: store.agentIdentity(name)!.id, label: `test:${name}`, actorId: created.ownerMemberId }).plaintext
    const controller = new AbortController()
    const done = runAgentRuntime({ serverUrl: server.url, token, executor, signal: controller.signal }).catch(() => {})
    runtimeProcs.push({ controller, done })
  }

  return { store, server, owner, created, startRuntime }
}

async function poll(check: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(40)
  }
  throw new Error('poll timed out')
}

/**
 * First diagnostics record with `scope` appended past `offset`. Polls because the
 * write is best-effort and lands on a later microtask than the failing call.
 */
async function waitForRecord(
  path: string,
  offset: number,
  scope: string,
  timeoutMs = 8_000,
): Promise<{ message: string; context?: Record<string, unknown> } | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      for (const line of readFileSync(path, 'utf8').slice(offset).split('\n')) {
        if (!line.trim()) continue
        const record = JSON.parse(line)
        if (record.scope === scope) return record
      }
    } catch {
      // not written yet
    }
    await Bun.sleep(25)
  }
  return undefined
}

test('two independent tasks run in parallel; a dependent task waits, then auto-starts', async () => {
  const { store, owner, startRuntime } = await fixture()
  const started: string[] = []
  const finished: string[] = []
  const executor: AgentExecutor = async (job) => {
    started.push(job.task.title)
    await job.progress('working')
    await Bun.sleep(70)
    finished.push(job.task.title)
    return { ok: true, report: `done ${job.task.title}`, filesChanged: job.task.files }
  }
  for (const name of ['be', 'fe', 'qa']) startRuntime(name, executor)
  await Bun.sleep(150)

  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'auth' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })

  await poll(() => started.length >= 2)
  // wave-1 tasks start before the wave-2 task
  expect(new Set(started.slice(0, 2))).toEqual(new Set(['Auth API', 'Login form']))

  await poll(() => finished.includes('Auth tests'))
  expect(finished.indexOf('Auth API')).toBeLessThan(started.indexOf('Auth tests'))

  await poll(() => store.objective(planned.objectiveId)!.status === 'completed')
  expect(store.tasks({ objectiveId: planned.objectiveId }).every((t) => t.status === 'done')).toBe(true)
}, TIMEOUT)

test('a failing task is retried, then escalated to a human approval', async () => {
  const { store, owner, startRuntime } = await fixture()
  let attempts = 0
  const executor: AgentExecutor = async (job) => {
    if (job.task.title === 'Auth API') {
      attempts += 1
      return { ok: false, report: 'exit code 1: compilation failed' }
    }
    return { ok: true, report: 'done', filesChanged: job.task.files }
  }
  startRuntime('be', executor)
  await Bun.sleep(150)

  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'auth' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })

  await poll(() => attempts >= 2)
  await poll(() => store.approvals('pending').some((a) => a.kind === 'review'))
  expect(store.approvals('pending').find((a) => a.kind === 'review')!.reason).toMatch(/needs a human/i)
}, TIMEOUT)

test('once mode never claims a second task after a TaskAssigned races the first claim (regression)', async () => {
  const { store, server, owner, created } = await fixture()
  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'auth' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })
  await poll(() => store.tasks({ objectiveId: planned.objectiveId }).length === 3)
  const tasks = store.tasks({ objectiveId: planned.objectiveId })
  const apiTask = tasks.find((t) => t.title === 'Auth API')!
  const loginTask = tasks.find((t) => t.title === 'Login form')!

  let executorCalls = 0
  let releaseGate: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  const executor: AgentExecutor = async (job) => {
    executorCalls += 1
    if (job.task.id === apiTask.id) await gate
    return { ok: true, report: `done ${job.task.title}`, filesChanged: job.task.files }
  }

  const identity = store.agentIdentity('be')!
  const agentId = agentInstanceId(identity.id)
  const token = mintAgentToken(store, { identityId: identity.id, label: 'test:be-once', actorId: created.ownerMemberId }).plaintext
  const controller = new AbortController()
  const done = runAgentRuntime({ serverUrl: server.url, token, executor, signal: controller.signal, once: true })
  runtimeProcs.push({ controller, done })

  // Wait for the runtime to actually start executing the first (gated) task.
  await poll(() => executorCalls >= 1)

  // Simulate the race the bug depends on: a `TaskAssigned` event for this same
  // agent fires while it is still busy on the first task — this is what sets
  // `pendingClaim` inside `runAgentRuntime`'s `onEvent` handler.
  await owner.call('task.assign', { taskId: loginTask.id, agent: 'be' })
  await poll(() => store.task(loginTask.id)!.status === 'assigned')
  expect(store.task(loginTask.id)!.assigneeId).toBe(agentId)

  // Let the first task finish, then let the runtime close (once mode).
  releaseGate?.()
  await done

  // The fix: `once` mode must not re-invoke `claimNext` for the deferred claim,
  // so the raced second task is never touched by this (closing) runtime — it
  // stays `assigned`, never started, and the executor ran exactly once.
  expect(executorCalls).toBe(1)
  expect(store.task(loginTask.id)!.status).toBe('assigned')
  expect(['done', 'in-review']).toContain(store.task(apiTask.id)!.status)
}, TIMEOUT)

test('agent.control stop aborts the in-flight job and rejects a zombie heartbeat (regression)', async () => {
  const { store, owner, created, startRuntime } = await fixture()
  let sawAbort = false
  const executor: AgentExecutor = async (job) => {
    await job.progress('working')
    await new Promise<void>((resolve) => {
      if (job.signal.aborted) {
        sawAbort = true
        resolve()
        return
      }
      job.signal.addEventListener('abort', () => {
        sawAbort = true
        resolve()
      }, { once: true })
    })
    return { ok: false, report: 'aborted' }
  }
  startRuntime('be', executor)
  await Bun.sleep(150)

  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'auth' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })
  await poll(() => store.tasks({ objectiveId: planned.objectiveId }).some((t) => t.title === 'Auth API' && t.status === 'in-progress'))
  const apiTask = store.tasks({ objectiveId: planned.objectiveId }).find((t) => t.title === 'Auth API')!

  await owner.call('agent.control', { agent: 'be', action: 'stop' })

  // The executor's own AbortSignal must fire — the whole point is not to let it
  // keep working on a task that has already been handed back to the pool.
  await poll(() => sawAbort)
  await poll(() => store.task(apiTask.id)!.status === 'ready')

  // A second caller authenticated as the same (now-stopped) agent identity —
  // standing in for a zombie runtime that never got the memo — must be refused
  // when it tries to heartbeat a task that is no longer its own. Dispatched
  // directly (bypassing the WebSocket round trip) to isolate the RPC-layer
  // guard from transport-level timing.
  const identity = store.agentIdentity('be')!
  const zombieToken = mintAgentToken(store, { identityId: identity.id, label: 'zombie', actorId: created.ownerMemberId }).plaintext
  const zombieCaller = resolveCaller(store, zombieToken)!
  await expect(
    dispatchAgentRpc(
      { store, caller: zombieCaller, connectionId: 'test-zombie', requestShutdown: () => {} },
      'agent.progress',
      { taskId: apiTask.id },
    ),
  ).rejects.toThrow(/cancelled|no longer accepting/i)
}, TIMEOUT)

test('a failure the runtime cannot report is recorded, leaving the task visibly orphaned', async () => {
  // #1271: `agent.complete` is what releases the task lease, appends TaskFailed,
  // and returns the agent to idle. When it rejects, the task stays in-progress
  // with its lease held and its agent still working, while runOne resolves
  // normally and the runtime claims the next task. Before this, that was
  // completely silent: the only eventual symptom was the store's missed-heartbeat
  // watchdog, which blames a heartbeat that never went out.
  const { store, server, owner, startRuntime } = await fixture()

  let releaseGate: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  const executor: AgentExecutor = async () => {
    await gate
    throw new Error('executor blew up')
  }
  startRuntime('be', executor)
  await Bun.sleep(150)

  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'auth' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })

  await poll(() => store.tasks({ objectiveId: planned.objectiveId }).some((t) => t.status === 'in-progress'))
  const taskId = store.tasks({ objectiveId: planned.objectiveId }).find((t) => t.status === 'in-progress')!.id

  // Take the server away so the terminal `agent.complete` cannot land. The log
  // is redirected to a temp file because the default path is derived from the cwd
  // captured when statePaths.ts was first imported, and several suites chdir into
  // temp directories — so under a full-suite run the default can resolve
  // somewhere a later test deletes, and every diagnostics write is best-effort.
  server.stop()

  const logPath = join(mkdtempSync(join(tmpdir(), 'elia-diag-')), 'diagnostics.ndjson')
  process.env.ELIA_DIAGNOSTICS_PATH = logPath
  releaseGate?.()

  try {
    const record = await waitForRecord(logPath, 0, 'workspace.agentRuntime.completeFailed')
    expect(record).toBeDefined()
    // `taskId` is asserted loosely on purpose: logSwallowedError runs every context
    // value through redactRecord, and elia's own `tsk_<hex>_<slug>` ids trip its
    // entropy heuristic, so the id comes back as `t[REDACTED]`. That collision is
    // worth knowing about but is a change to the secret detector, not to this
    // issue — the record existing, being scoped, and carrying the report is the
    // part that was previously missing entirely.
    expect(typeof record!.context!.taskId).toBe('string')
    expect(String(record!.context!.report)).toContain('executor blew up')
  } finally {
    delete process.env.ELIA_DIAGNOSTICS_PATH
  }

  // The orphan itself: still in-progress, lease unreleased. This is the state
  // that used to have no explanation attached to it anywhere.
  expect(store.task(taskId)!.status).toBe('in-progress')
}, TIMEOUT)

test('an out-of-scope task is never assigned to an agent that cannot touch its files', async () => {
  const { store, owner, startRuntime } = await fixture()
  const executor: AgentExecutor = async (job) => ({ ok: true, report: 'done', filesChanged: job.task.files })
  startRuntime('fe', executor) // only ui/** — cannot take the api task
  await Bun.sleep(150)

  const planned = await owner.call<{ objectiveId: string }>('objective.add', { goal: 'auth' })
  await owner.call('objective.approve', { objectiveId: planned.objectiveId })

  await poll(() => store.tasks({ objectiveId: planned.objectiveId, status: 'done' }).some((t) => t.title === 'Login form'))
  await Bun.sleep(300)
  const api = store.tasks({ objectiveId: planned.objectiveId }).find((t) => t.title === 'Auth API')!
  expect(['ready', 'pending']).toContain(api.status)
  expect(api.assigneeId).toBeUndefined()
}, TIMEOUT)
