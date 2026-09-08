import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { addMember, createWorkspace, registerAgentIdentity } from './admin.ts'
import { runWorkspaceServer, type RunningWorkspaceServer } from './server.ts'
import { WorkspaceClient } from './client.ts'
import type { PersistedEvent } from './events.ts'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      fn()
    } catch {
      /* best effort */
    }
  }
})

const stubPlanner = async () => ({
  goal: 'ship it', understanding: 'fresh', assumptions: [], risks: [], verification: ['bun test'], outOfScope: [],
  steps: [
    { id: 'a', title: 'API', role: 'backend' as const, instructions: 'build api', files: ['api.ts'], dependsOn: [] },
    { id: 'b', title: 'Tests', role: 'tester' as const, instructions: 'test api', files: ['api.test.ts'], dependsOn: ['a'] },
  ],
})

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-srv-'))
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  const created = createWorkspace(store, { name: 'demo', ownerName: 'owner' })
  const contributor = addMember(store, { name: 'dev', role: 'contributor', actorId: created.ownerMemberId })
  const agent = registerAgentIdentity(store, { name: 'fe', role: 'frontend', actorId: created.ownerMemberId })
  const server: RunningWorkspaceServer = runWorkspaceServer({ port: 0, store, planner: stubPlanner })
  cleanup.push(() => server.stop())
  cleanup.push(() => store.close())
  cleanup.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* windows lock */
    }
  })
  return { store, server, owner: created.ownerToken.plaintext, contributor: contributor.token.plaintext, agent: agent.token.plaintext }
}

async function connect(server: RunningWorkspaceServer, token: string, onEvent?: (e: PersistedEvent) => void) {
  const client = await WorkspaceClient.connect({ url: server.url, token, onEvent })
  cleanup.push(() => client.close())
  return client
}

/** bun:test's `expect(p).rejects.toThrow` has been flaky here; catch explicitly. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return '(did not reject)'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test('a connection without a valid token is rejected', async () => {
  const { server } = await fixture()
  expect(await rejection(WorkspaceClient.connect({ url: server.url, token: 'wst_bogus' }, 2_000))).toMatch(/unauthor|closed|reach/i)
})

test('a valid token connects and receives a hello with its resolved identity', async () => {
  const { server, owner } = await fixture()
  const client = await connect(server, owner)
  expect(client.hello?.caller.role).toBe('owner')
  expect(client.hello?.caller.kind).toBe('member')
})

test('workspace.status reflects the store', async () => {
  const { server, owner } = await fixture()
  const client = await connect(server, owner)
  const status = await client.call<{ members: number; workspace: { name: string } }>('workspace.status')
  expect(status.workspace.name).toBe('demo')
  expect(status.members).toBe(2)
})

test('capability is enforced on the RPC surface', async () => {
  const { server, contributor } = await fixture()
  const client = await connect(server, contributor)
  expect(await rejection(client.call('member.add', { name: 'x', role: 'viewer' }))).toMatch(/permitted/i)
})

test('an owner can mint a member token that then connects', async () => {
  const { server, owner } = await fixture()
  const client = await connect(server, owner)
  const minted = await client.call<{ token: string }>('member.add', { name: 'qa', role: 'maintainer' })
  expect(minted.token.startsWith('wst_')).toBe(true)
  const second = await connect(server, minted.token)
  expect(second.hello?.caller.name).toBe('qa')
})

test('an event from one client is pushed live to another with no polling', async () => {
  const { server, owner, contributor } = await fixture()
  const received: PersistedEvent[] = []
  await connect(server, owner, (event) => received.push(event))
  const writer = await connect(server, contributor)

  await writer.call('message.post', { topic: 'auth', kind: 'claim', body: 'login API is done' })

  await Bun.sleep(100)
  const message = received.find((event) => event.type === 'AgentMessageCreated')
  expect(message).toBeDefined()
  expect(String(message!.payload.body)).toContain('login API is done')
})

test('an agent service token has only view and comment', async () => {
  const { server, agent } = await fixture()
  const client = await connect(server, agent)
  expect(client.hello?.caller.kind).toBe('agent')
  await client.call('message.post', { topic: 'progress', kind: 'info', body: 'working' })
  expect(await rejection(client.call('agent.register', { name: 'x', role: 'scout' }))).toMatch(/permitted/i)
})

test('presence tracks connected participants and clears on disconnect', async () => {
  const { server, owner } = await fixture()
  const a = await connect(server, owner)
  const status1 = await a.call<{ presence: unknown[] }>('workspace.status')
  expect(status1.presence.length).toBe(1)

  const b = await WorkspaceClient.connect({ url: server.url, token: owner })
  await Bun.sleep(50)
  const status2 = await a.call<{ presence: unknown[] }>('workspace.status')
  expect(status2.presence.length).toBe(2)

  b.close()
  await Bun.sleep(100)
  const status3 = await a.call<{ presence: unknown[] }>('workspace.status')
  expect(status3.presence.length).toBe(1)
})

test('not-yet-implemented methods report their milestone instead of failing opaquely', async () => {
  const { server, owner } = await fixture()
  const client = await connect(server, owner)
  expect(await rejection(client.call('task.assign', { taskId: 'x' }))).toMatch(/M4/)
})

test('objective.add plans a task graph; approval activates it and makes wave-1 tasks ready', async () => {
  const { server, owner, contributor } = await fixture()
  const owns = await connect(server, owner)
  const devs = await connect(server, contributor)

  const planned = await devs.call<{ objectiveId: string; steps: unknown[] }>('objective.add', { goal: 'build auth' })
  expect(planned.steps).toHaveLength(2)
  expect((await owns.call<{ objective: { status: string } }>('objective.show', { objectiveId: planned.objectiveId })).objective.status).toBe('awaiting-approval')

  // A contributor cannot approve.
  expect(await rejection(devs.call('objective.approve', { objectiveId: planned.objectiveId }))).toMatch(/permitted/i)

  await owns.call('objective.approve', { objectiveId: planned.objectiveId })
  const tasks = await owns.call<Array<{ title: string; status: string }>>('task.list', { objectiveId: planned.objectiveId })
  expect(tasks.find((t) => t.title === 'API')!.status).toBe('ready')
  expect(tasks.find((t) => t.title === 'Tests')!.status).toBe('pending')
})
