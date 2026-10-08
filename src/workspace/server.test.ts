import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { addMember, createWorkspace, registerAgentIdentity } from './admin.ts'
import { runWorkspaceServer, type RunningWorkspaceServer } from './server.ts'
import { WorkspaceClient } from './client.ts'
import type { PersistedEvent } from './events.ts'
import type { MeshSupervisorOptions } from '../mesh/index.ts'

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
  // mesh: false — these tests exercise the coordination server alone. The file
  // plane is gated by ELIA_WORKSPACE_MESH, but pinning it off keeps a developer
  // who has that variable set from spawning a real sidecar mid-test.
  const server: RunningWorkspaceServer = runWorkspaceServer({ port: 0, store, planner: stubPlanner, mesh: false })
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

test('a token in the ?token= query string is refused, even a valid one', async () => {
  const { server, owner } = await fixture()
  const http = server.url.replace(/^ws/, 'http')
  const viaQuery = await fetch(`${http}?token=${encodeURIComponent(owner)}`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
  expect(viaQuery.status).toBe(400)
  expect(await viaQuery.text()).toContain('Authorization: Bearer')

  // ...while the same token in the header (what WorkspaceClient sends) connects.
  const client = await connect(server, owner)
  expect(client.hello?.caller.role).toBe('owner')
})

test('a browser Origin is refused unless explicitly allowed', async () => {
  const { server, owner } = await fixture()
  const http = server.url.replace(/^ws/, 'http')
  const base = {
    Authorization: `Bearer ${owner}`,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  }
  // Default server allows no Origin: any browser is refused, good or bad.
  const crossOrigin = await fetch(`${http}`, { headers: { ...base, Origin: 'https://evil.example' } })
  expect(crossOrigin.status).toBe(403)
  const stillNotAllowed = await fetch(`${http}`, { headers: { ...base, Origin: 'https://good.example' } })
  expect(stillNotAllowed.status).toBe(403)

  // An explicit allowlist admits only the listed Origin (the bearer token still
  // has to be valid for the handshake to proceed).
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-origin-'))
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  createWorkspace(store, { name: 'origin', ownerName: 'owner' })
  const allowed = runWorkspaceServer({ port: 0, store, planner: stubPlanner, allowedOrigins: ['https://good.example'], mesh: false })
  cleanup.push(() => allowed.stop())
  cleanup.push(() => store.close())
  const allowedHttp = allowed.url.replace(/^ws/, 'http')
  const evilOnAllowed = await fetch(`${allowedHttp}`, { headers: { ...base, Origin: 'https://evil.example' } })
  expect(evilOnAllowed.status).toBe(403)
  const admitted = await fetch(`${allowedHttp}`, { headers: { ...base, Origin: 'https://good.example' } })
  expect(admitted.status).not.toBe(403) // sailed past the Origin gate (a WS handshake follows)
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

test('an unknown RPC method is rejected with a clear error', async () => {
  const { server, owner } = await fixture()
  const client = await connect(server, owner)
  expect(await rejection(client.call('does.not.exist' as never, {}))).toMatch(/unknown workspace RPC method/i)
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

test('a refused token says so, rather than claiming nothing is listening', async () => {
  // The two failures look identical from the client: a WebSocket that is
  // rejected with 401 and one that never connected. Reporting "cannot reach" for
  // a bad token sends the reader to look at the network, which is working.
  const { server } = await fixture()
  const message = await rejection(WorkspaceClient.connect({ url: server.url, token: 'wst_bogus' }, 2_000))
  expect(message).toMatch(/401|token/i)
})

test('the server applies an inbound control frame from a peer that named none', async () => {
  // A sidecar tells a host its peers' ids, and tells a member only the host's
  // certificate fingerprint — so a member's `ready` frame carries no peers at
  // all. Replication used to be started only once a peer id was known, which
  // meant a member had no handle to apply anything with: the mesh looked
  // connected and every relayed event was dropped.
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-inbound-'))
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  const created = createWorkspace(store, { name: 'demo', ownerName: 'owner' })
  cleanup.push(() => store.close())
  cleanup.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* windows lock */
    }
  })

  let meshOptions: MeshSupervisorOptions | undefined
  const server: RunningWorkspaceServer = runWorkspaceServer({
    port: 0,
    store,
    planner: stubPlanner,
    mesh: true,
    startMesh: (supervisorOptions) => {
      meshOptions = supervisorOptions
      return { decision: { start: true, reason: 'required' }, done: Promise.resolve(), stop: () => {}, sendControl: () => true }
    },
  })
  cleanup.push(() => server.stop())
  const ready = meshOptions!.onReady!
  const control = meshOptions!.onControl!

  // A member-style ready frame: role member, host fingerprint, and — the point of
  // the test — no peers, which is exactly what a member's sidecar sends.
  ready({
    protocol: 1,
    workspaceId: created.workspaceId,
    peerId: 'p1',
    role: 'member',
    root: dir,
    listenAddr: '',
    fingerprint: 'fp-local',
    hostFingerprint: 'fp-host',
    // Empty on purpose: a member's sidecar has nobody joined into it, so it has
    // no peers to list. That empty list is what used to disable replication.
    peers: [],
  })

  const before = store.events().length
  control({
    node: 'nd_peer',
    events: [{
      id: 'evt_inbound_1',
      type: 'NodeHeartbeat',
      actorKind: 'system',
      actorId: 'workspace-server',
      actorNode: 'nd_peer',
      payload: { id: 'nd_peer', name: 'peer', kind: 'mesh' },
      at: '2026-01-01T00:00:00.000Z',
    }],
  })

  expect(store.events().length).toBe(before + 1)
  expect(store.events().at(-1)!.id).toBe('evt_inbound_1')
  expect(store.replicationError()).toBeUndefined()
})
