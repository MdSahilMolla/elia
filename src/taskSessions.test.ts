import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { inferTaskKind, TaskSessionStore } from './taskSessions.ts'

test('infers browser work separately from coding work', () => {
  expect(inferTaskKind('Open the website', 'navigate Chrome to the login page')).toBe('browser')
  expect(inferTaskKind('Fix the parser', 'update the TypeScript implementation')).toBe('code')
})

test('classifies unseen domain work before execution', () => {
  expect(inferTaskKind('Forecast runway', 'calculate DCF and unit economics')).toBe('finance')
  expect(inferTaskKind('Analyze events', 'profile the CSV and run regression')).toBe('data')
  expect(inferTaskKind('Release service', 'prepare deployment rollback and SLO checks')).toBe('production')
  expect(inferTaskKind('Send update', 'draft an email to stakeholders')).toBe('communication')
  expect(inferTaskKind('Sync records', 'build a webhook workflow')).toBe('automation')
})

test('tracks pending, running, and completed task state', () => {
  const store = new TaskSessionStore()
  const session = store.create('code', 'Fix parser', 'Queued')
  expect(session.status).toBe('pending')

  store.update(session.id, { status: 'running', action: 'run tests', detail: 'bun test', stepsCompleted: 1, progress: 0.4, nextAction: 'inspect failures' })
  expect(store.get(session.id)?.status).toBe('running')
  expect(store.get(session.id)?.startedAt).toBeDefined()
  expect(store.get(session.id)?.attempts).toBe(1)
  expect(store.get(session.id)?.progress).toBe(0.4)
  expect(store.get(session.id)?.nextAction).toBe('inspect failures')
  store.update(session.id, { status: 'running', action: 'heartbeat', detail: 'still running', progress: 0.6 })
  expect(store.get(session.id)?.attempts).toBe(1)

  store.update(session.id, { status: 'done', action: 'Finished', detail: 'All checks passed' })
  const finished = store.get(session.id)
  expect(finished?.status).toBe('done')
  expect(finished?.finishedAt).toBeDefined()
  expect(finished?.stepsCompleted).toBe(1)
  expect(finished?.progress).toBe(1)
})

test('persists explicit waiting metadata without exposing unbounded text', () => {
  const store = new TaskSessionStore()
  const session = store.create('production', 'Deploy service', 'Queued', { acceptanceCriteria: ['health check passes'], verificationCommands: ['bun test'] })
  store.update(session.id, { status: 'waiting-approval', action: 'Awaiting approval', blockedReason: 'production deployment requires exact approval', nextAction: 'ask for deployment approval', progress: 4 })
  const saved = store.get(session.id)
  expect(saved?.status).toBe('waiting-approval')
  expect(saved?.blockedReason).toContain('exact approval')
  expect(saved?.nextAction).toBe('ask for deployment approval')
  expect(saved?.progress).toBe(1)
  expect(saved?.acceptanceCriteria).toEqual(['health check passes'])
  expect(saved?.verificationCommands).toEqual(['bun test'])
})

test('invokes registered task controls and unregisters them', () => {
  const store = new TaskSessionStore()
  const session = store.create('code', 'Cancelable work', 'Queued', { parentId: 'step:frontend', depth: 1, role: 'tester' })
  let cancelled = 0
  const unregister = store.registerControls(session.id, { cancel: () => { cancelled += 1 } })
  expect(store.control(session.id, 'cancel')).toBe(true)
  expect(cancelled).toBe(1)
  unregister()
  expect(store.control(session.id, 'cancel')).toBe(false)
  expect(store.get(session.id)?.parentId).toBe('step:frontend')
  expect(store.get(session.id)?.depth).toBe(1)
  expect(store.get(session.id)?.role).toBe('tester')
})

test('persists and reloads task sessions while ignoring malformed history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elia-task-sessions-'))
  const file = join(dir, 'tasks.json')
  try {
    const store = new TaskSessionStore()
    const original = store.create('browser', 'Read account page', 'Queued', { parentId: 'step:web', depth: 1, role: 'accessibility' })
    store.update(original.id, { status: 'paused', action: 'Awaiting confirmation' })
    await Bun.write(file, JSON.stringify([...store.list(), { invalid: true }]))

    const loaded = new TaskSessionStore()
    await loaded.load(file)
    expect(loaded.get(original.id)?.status).toBe('paused')
    expect(loaded.get(original.id)?.parentId).toBe('step:web')
    expect(loaded.get(original.id)?.depth).toBe(1)
    expect(loaded.get(original.id)?.role).toBe('accessibility')
    expect(loaded.list()).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
