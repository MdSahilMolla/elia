import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace } from './admin.ts'
import { runWorkspaceServer, type RunningWorkspaceServer } from './server.ts'
import { collectEliaspaceSnapshot, renderEliaspacePanel, renderEliaspaceView } from './panel.ts'

const cleanup: Array<() => void> = []
const savedEnv = { server: process.env.ELIA_WORKSPACE_SERVER, token: process.env.ELIA_WORKSPACE_TOKEN }

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      fn()
    } catch {
      /* best effort */
    }
  }
  process.env.ELIA_WORKSPACE_SERVER = savedEnv.server
  process.env.ELIA_WORKSPACE_TOKEN = savedEnv.token
  if (savedEnv.server === undefined) delete process.env.ELIA_WORKSPACE_SERVER
  if (savedEnv.token === undefined) delete process.env.ELIA_WORKSPACE_TOKEN
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-panel-'))
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  const created = createWorkspace(store, { name: 'demo', ownerName: 'owner' })
  const server: RunningWorkspaceServer = runWorkspaceServer({ port: 0, store })
  cleanup.push(() => server.stop())
  cleanup.push(() => store.close())
  cleanup.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* windows lock */
    }
  })
  return { server, owner: created.ownerToken.plaintext }
}

test('with no token the snapshot is unconfigured and the panel shows the setup recipe', async () => {
  delete process.env.ELIA_WORKSPACE_SERVER
  delete process.env.ELIA_WORKSPACE_TOKEN
  const snap = await collectEliaspaceSnapshot()
  expect(snap.configured).toBe(false)
  expect(snap.reachable).toBe(false)
  expect(renderEliaspacePanel(snap)).toContain('elia workspace init')
})

test('with a reachable server the snapshot carries status and identity', async () => {
  const { server, owner } = fixture()
  process.env.ELIA_WORKSPACE_SERVER = server.url
  process.env.ELIA_WORKSPACE_TOKEN = owner

  const snap = await collectEliaspaceSnapshot()
  expect(snap.reachable).toBe(true)
  expect(snap.status?.workspace?.name).toBe('demo')
  expect(snap.caller?.role).toBe('owner')
  expect(renderEliaspacePanel(snap)).toContain('demo')

  expect(await renderEliaspaceView('members')).toContain('owner')
  expect(await renderEliaspaceView('connection')).toContain('ELIA_WORKSPACE_TOKEN')
})

test('an unreachable server yields a diagnostic panel, not a throw', async () => {
  process.env.ELIA_WORKSPACE_SERVER = 'ws://127.0.0.1:59999/workspace'
  process.env.ELIA_WORKSPACE_TOKEN = 'wst_whatever'
  const snap = await collectEliaspaceSnapshot()
  expect(snap.reachable).toBe(false)
  expect(renderEliaspacePanel(snap)).toMatch(/not reachable/i)
})
