import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ContextDrop,
  CreateHandleOptions,
  DelegationRecord,
  SessionBus,
  SessionEvent,
  SessionHandle,
  SessionId,
  SessionName,
  SessionStatus,
} from './types.ts'
import { makeSessionId, makeSessionName } from './types.ts'
import {
  loadDropPayload,
  publishDrop,
  resetSessionBusForTests,
  runContextDrop,
  runContextSubscribe,
  setSessionBusForTests,
} from './contextDrop.ts'

const MEMORY = { lessons: [], projectNotes: [], localLessons: [], localNotes: [] }

function dropHandle(id: SessionId, name: SessionName): SessionHandle {
  return {
    id,
    name,
    status: 'idle',
    taskQueue: [],
    memorySlice: { ...MEMORY },
    lastActivity: Date.now(),
    activeAgents: 0,
    sharedContext: {},
    dependencies: [],
    checkpoints: new Map(),
  }
}

interface DropRecorder {
  bus: SessionBus
  drops: ContextDrop[]
  events: SessionEvent[]
  subscriptions: Array<{ target: SessionId; name: string; cb: (drop: ContextDrop) => void }>
}

function makeDropBus(active: SessionId | undefined, members: Array<[SessionId, SessionName]> = []): DropRecorder {
  const drops: ContextDrop[] = []
  const events: SessionEvent[] = []
  const subscriptions: Array<{ target: SessionId; name: string; cb: (drop: ContextDrop) => void }> = []
  const byId = new Map(members.map(([id, name]) => [id, dropHandle(id, name)] as [SessionId, SessionHandle]))
  let activeId: SessionId | undefined = active

  const dispatch = (drop: ContextDrop): void => {
    for (const entry of subscriptions) {
      if (entry.target === drop.fromSession && entry.name === drop.name) entry.cb(drop)
    }
  }

  const bus: SessionBus = {
    get activeSession(): SessionId | undefined {
      return activeId
    },
    setActiveSession(id): void {
      activeId = id
    },
    create(_name: SessionName, _opts?: CreateHandleOptions): SessionHandle {
      throw new Error('fake bus: create not supported in this test')
    },
    fork(_from: SessionId, _name: SessionName): SessionHandle {
      throw new Error('fake bus: fork not supported in this test')
    },
    get(id): SessionHandle | undefined {
      return byId.get(id)
    },
    byName(name): SessionHandle | undefined {
      for (const entry of byId.values()) if (entry.name === name) return entry
      return undefined
    },
    resolve(ref): SessionHandle | undefined {
      return byId.get(ref as SessionId) ?? this.byName(ref as SessionName)
    },
    list(): SessionHandle[] {
      return [...byId.values()]
    },
    update(): void {},
    setStatus(_id: SessionId, _status: SessionStatus, _reason?: string): void {},
    pushTask(_id: SessionId, _record: DelegationRecord): void {},
    noteCheckpoint(_id: SessionId, _name: string, _data?: unknown): void {},
    emitDrop(drop): void {
      drops.push(drop)
      dispatch(drop)
      events.push({ type: 'cross:context-sync', sessionId: drop.fromSession, drop })
      for (const listener of listeners) listener({ type: 'cross:context-sync', sessionId: drop.fromSession, drop })
    },
    subscribeDrop(target: SessionId, dropName: string, cb: (drop: ContextDrop) => void): () => void {
      const entry = { target, name: dropName, cb }
      subscriptions.push(entry)
      return () => {
        const index = subscriptions.indexOf(entry)
        if (index >= 0) subscriptions.splice(index, 1)
      }
    },
    emit(event): void {
      events.push(event)
    },
    on(listener): () => void {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    kill(): void {},
  }
  const listeners: Array<(event: SessionEvent) => void> = []
  return { bus, drops, events, subscriptions }
}

/** Polls for async/from-timer callback delivery that some buses defer to. */
async function until(check: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: condition was not met in time')
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
}

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-context-drop-test-'))
  writeFileSync(join(dir, 'payload.json'), JSON.stringify({ phase: 'next', who: 'leaf' }))
  writeFileSync(join(dir, 'note.txt'), 'plain text payload')
  writeFileSync(join(dir, 'broken.json'), 'this is } not json')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('publishDrop records the drop on the bus and triggers the cross:context-sync event', () => {
  const active = makeSessionId('sess-act')
  const { bus, drops, events } = makeDropBus(active)

  const drop = publishDrop({ name: 'deploy-plan', payload: { phase: 'next' }, fromSession: active, bus })

  expect(drop.id.length).toBeGreaterThan(0)
  expect(drop.name).toBe('deploy-plan')
  expect(drop.fromSession).toBe(active)
  expect(drop.emittedAt).toBeGreaterThan(0)
  expect(drops).toEqual([drop])
  expect(events.filter((event) => event.type === 'cross:context-sync')).toHaveLength(1)
})

test('subscribeDrop runs the callback on a matching emit and unsubscribe stops delivery', async () => {
  const active = makeSessionId('sess-act')
  const { bus } = makeDropBus(active)
  const seen: unknown[] = []

  const unsubscribe = bus.subscribeDrop(active, 'cfg', (drop) => {
    seen.push(drop.payload)
  })

  bus.emitDrop({ id: 'd1', name: 'cfg', fromSession: active, payload: { x: 1 }, emittedAt: 1 })
  bus.emitDrop({ id: 'd2', name: 'other', fromSession: active, payload: { x: 99 }, emittedAt: 2 })
  await until(() => seen.length === 1)
  expect(seen).toEqual([{ x: 1 }])

  unsubscribe()
  bus.emitDrop({ id: 'd3', name: 'cfg', fromSession: active, payload: { x: 3 }, emittedAt: 3 })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  expect(seen).toEqual([{ x: 1 }])
})

test('loadDropPayload parses JSON files and returns raw text for others', async () => {
  expect(await loadDropPayload(join(dir, 'payload.json'))).toEqual({ phase: 'next', who: 'leaf' })
  expect(await loadDropPayload(join(dir, 'note.txt'))).toBe('plain text payload')
})

test('loadDropPayload throws friendly errors for missing and malformed files', async () => {
  await expect(loadDropPayload(join(dir, 'missing.json'))).rejects.toThrow(/Could not read the context-drop payload file/)
  await expect(loadDropPayload(join(dir, 'broken.json'))).rejects.toThrow(/not valid JSON/)
})

test('runContextDrop resolves the default from the bus activeSession', async () => {
  const active = makeSessionId('sess-act')
  const { bus, drops } = makeDropBus(active)
  setSessionBusForTests(bus)
  try {
    await runContextDrop({ name: 'deploy-plan', payloadPath: join(dir, 'payload.json'), quiet: true })
    expect(drops).toHaveLength(1)
    expect(drops[0]?.name).toBe('deploy-plan')
    expect(drops[0]?.fromSession).toBe(active)
    expect(drops[0]?.payload).toEqual({ phase: 'next', who: 'leaf' })
  } finally {
    resetSessionBusForTests()
  }
})

test('runContextDrop accepts an explicit fromSession ref', async () => {
  const sourceId = makeSessionId('sess-src')
  const { bus, drops } = makeDropBus(undefined, [[sourceId, makeSessionName('feat/leaf')]])
  setSessionBusForTests(bus)
  try {
    await runContextDrop({ name: 'cfg', fromSession: 'feat/leaf', quiet: true })
    expect(drops[0]?.fromSession).toBe(sourceId)
  } finally {
    resetSessionBusForTests()
  }
})

test('runContextDrop errors when no session can be resolved', async () => {
  const { bus } = makeDropBus(undefined)
  setSessionBusForTests(bus)
  try {
    await expect(runContextDrop({ name: 'cfg', quiet: true })).rejects.toThrow(/No active session/)
    await expect(runContextDrop({ name: 'cfg', fromSession: 'ghost', quiet: true })).rejects.toThrow(
      /Unknown session "ghost"/,
    )
  } finally {
    resetSessionBusForTests()
  }
})

test('runContextSubscribe registers a subscription against the active session', async () => {
  const active = makeSessionId('sess-act')
  const { bus, subscriptions } = makeDropBus(active)
  setSessionBusForTests(bus)
  try {
    await runContextSubscribe({ name: 'prices', fromSession: active, quiet: true })
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]?.target).toBe(active)
    expect(subscriptions[0]?.name).toBe('prices')
    expect(typeof subscriptions[0]?.cb).toBe('function')
  } finally {
    resetSessionBusForTests()
  }
})

test('runContextSubscribe targets the resolved ref when no session is active', async () => {
  const subscriberId = makeSessionId('sess-sub')
  const { bus, subscriptions } = makeDropBus(undefined, [[subscriberId, makeSessionName('feat/watch')]])
  setSessionBusForTests(bus)
  try {
    await runContextSubscribe({ name: 'prices', fromSession: 'feat/watch', quiet: true })
    expect(subscriptions[0]?.target).toBe(subscriberId)
  } finally {
    resetSessionBusForTests()
  }
})