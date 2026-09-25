import { describe, expect, test } from 'bun:test'
import { createSessionBus, getSessionBus } from './bus.ts'
import { makeSessionId, makeSessionName, type ContextDrop, type DelegationRecord, type SessionEvent } from './types.ts'

function taskRecord(id: string, targetSession: ReturnType<typeof makeSessionId>): DelegationRecord {
  return { id, source: 'cli', goal: `goal ${id}`, targetSession, mode: 'new-session', status: 'queued', createdAt: Date.now() }
}

describe('session bus', () => {
  test('create, get and list track sessions', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('alpha'))
    expect(a.status).toBe('running')
    expect(bus.get(a.id)).toBe(a)
    expect(bus.list()).toEqual([a])
    expect(bus.list()).toHaveLength(1)
  })

  test('names are branded and resolve() prefers id over exact name, rejecting ambiguous names', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('worker'))
    const b = bus.create(makeSessionName('worker'))
    const solo = bus.create(makeSessionName('solo'))
    expect(bus.resolve(a.id)).toBe(a)
    expect(bus.resolve(b.id)).toBe(b)
    expect(bus.resolve('worker')).toBeUndefined()
    expect(bus.resolve('solo')).toBe(solo)
    expect(bus.byName(makeSessionName('worker'))).toBeUndefined()
    expect(bus.byName(makeSessionName('solo'))).toBe(solo)
    expect(bus.get(makeSessionId('does-not-exist'))).toBeUndefined()
  })

  test('status transitions fire the matching events, blocked/errored carrying reason/error', () => {
    const bus = createSessionBus()
    const seen: SessionEvent[] = []
    bus.on((event) => seen.push(event))
    const a = bus.create(makeSessionName('t'))
    bus.setStatus(a.id, 'blocked', 'waiting on a secret')
    bus.setStatus(a.id, 'errored', 'segfault')
    bus.setStatus(a.id, 'done')
    expect(seen[0]).toMatchObject({ type: 'session:started', sessionId: a.id, name: 't' })
    expect(seen[1]).toMatchObject({ type: 'session:blocked', sessionId: a.id, reason: 'waiting on a secret' })
    expect(seen[2]).toMatchObject({ type: 'session:errored', sessionId: a.id, error: 'segfault' })
    expect(seen[3]).toMatchObject({ type: 'session:completed', sessionId: a.id })
  })

  test('on() returns an unsubscribe that stops delivery', () => {
    const bus = createSessionBus()
    let calls = 0
    const off = bus.on(() => {
      calls += 1
    })
    const a = bus.create(makeSessionName('x'))
    expect(calls).toBe(1)
    off()
    bus.setStatus(a.id, 'blocked', 'why')
    expect(calls).toBe(1)
  })

  test('fork isolates local memory while sharing frozen project arrays', () => {
    const bus = createSessionBus()
    const parent = bus.create(makeSessionName('parent'))
    bus.update(parent.id, {
      memorySlice: {
        lessons: Object.freeze(['shared-lesson']),
        projectNotes: Object.freeze(['shared-note']),
        localLessons: ['parent-local'],
        localNotes: ['parent-note'],
      },
    })
    const child = bus.fork(parent.id, makeSessionName('child'))
    expect(child.memorySlice.localLessons).toEqual(['parent-local'])
    expect(child.memorySlice.localNotes).toEqual(['parent-note'])
    expect(child.memorySlice.lessons).toBe(parent.memorySlice.lessons)
    expect(Object.isFrozen(child.memorySlice.lessons)).toBe(true)
    expect(Object.isFrozen(child.memorySlice.projectNotes)).toBe(true)

    child.memorySlice.localLessons.push('child-local')
    child.memorySlice.localNotes.push('child-note')
    expect(parent.memorySlice.localLessons).toEqual(['parent-local'])
    expect(parent.memorySlice.localNotes).toEqual(['parent-note'])
    expect(child.memorySlice.localLessons).toEqual(['parent-local', 'child-local'])
  })

  test('a child never inherits the parent worktree (isolation)', () => {
    const bus = createSessionBus()
    const parent = bus.create(makeSessionName('wt'), { worktree: 'H:/sessions/parent-wt' })
    const child = bus.fork(parent.id, makeSessionName('wt-child'))
    expect(child.worktree).toBeUndefined()
    const own = bus.create(makeSessionName('own'), { from: parent.id, worktree: 'H:/sessions/own-wt' })
    expect(own.worktree).toBe('H:/sessions/own-wt')
  })

  test('a session with unsatisfied dependencies starts BLOCKED and releases when the upstream is DONE', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    const b = bus.create(makeSessionName('b'), { dependencies: [{ on: a.id, satisfied: false }] })
    expect(b.status).toBe('blocked')
    expect(b.dependencies[0]!.satisfied).toBe(false)

    bus.setStatus(a.id, 'done')
    expect(b.dependencies[0]!.satisfied).toBe(true)
    expect(b.status).toBe('running')
  })

  test('a named checkpoint satisfies dependents on first emission only', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    const c = bus.create(makeSessionName('c'), { dependencies: [{ on: a.id, checkpoint: 'schema-final', satisfied: false }] })
    expect(c.status).toBe('blocked')

    bus.noteCheckpoint(a.id, 'schema-final', { table: 'users' })
    expect(a.checkpoints.get('schema-final')?.emittedAt).toBeGreaterThan(0)
    expect(a.checkpoints.get('schema-final')?.data).toEqual({ table: 'users' })
    expect(c.dependencies[0]!.satisfied).toBe(true)
    expect(c.status).toBe('running')

    bus.noteCheckpoint(a.id, 'schema-final', { table: 'orders' })
    expect(a.checkpoints.get('schema-final')?.data).toEqual({ table: 'users' })
  })

  test('a dependency created against an already-DONE upstream starts satisfied and RUNNING', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    bus.setStatus(a.id, 'done')
    const b = bus.create(makeSessionName('b'), { dependencies: [{ on: a.id, satisfied: false }] })
    expect(b.dependencies[0]!.satisfied).toBe(true)
    expect(b.status).toBe('running')
  })

  test('emitDrop delivers to subscribers of the drop name and unsubscribe stops delivery', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    const b = bus.create(makeSessionName('b'))
    const received: ContextDrop[] = []
    const off = bus.subscribeDrop(b.id, 'triage', (drop) => received.push(drop))
    const drop: ContextDrop = { id: 'drop-1', name: 'triage', fromSession: a.id, payload: { n: 1 }, emittedAt: Date.now() }
    bus.emitDrop(drop)
    expect(received).toEqual([drop])

    bus.emitDrop({ ...drop, name: 'other-topic', id: 'drop-other' })
    expect(received).toHaveLength(1)

    off()
    bus.emitDrop({ ...drop, id: 'drop-2' })
    expect(received).toHaveLength(1)
  })

  test('emitDrop also emits the cross:context-sync event', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    const synced: ContextDrop[] = []
    bus.on((event) => {
      if (event.type === 'cross:context-sync') synced.push(event.drop)
    })
    const drop: ContextDrop = { id: 'drop-c', name: 'design-notes', fromSession: a.id, payload: { sketch: true }, emittedAt: Date.now() }
    bus.emitDrop(drop)
    expect(synced).toEqual([drop])
  })

  test('task queue is append-only', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    const first = taskRecord('t1', a.id)
    const second = taskRecord('t2', a.id)
    bus.pushTask(a.id, first)
    bus.pushTask(a.id, second)
    expect(a.taskQueue).toEqual([first, second])
    expect(a.taskQueue).toHaveLength(2)
  })

  test('kill removes the session and emits session:completed', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    const completed: string[] = []
    bus.on((event) => {
      if (event.type === 'session:completed') completed.push(event.sessionId)
    })
    bus.kill(a.id)
    expect(completed).toEqual([a.id])
    expect(bus.get(a.id)).toBeUndefined()
    expect(bus.list()).toEqual([])
  })

  test('mutations update lastActivity', async () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    const before = a.lastActivity
    await Bun.sleep(5)
    bus.setStatus(a.id, 'blocked', 'pause')
    expect(a.lastActivity).toBeGreaterThan(before)
    await Bun.sleep(5)
    bus.pushTask(a.id, taskRecord('t3', a.id))
    expect(a.lastActivity).toBeGreaterThan(before)
  })

  test('activeSession is tracked through setActiveSession', () => {
    const bus = createSessionBus()
    const a = bus.create(makeSessionName('a'))
    expect(bus.activeSession).toBeUndefined()
    bus.setActiveSession(a.id)
    expect(bus.activeSession).toBe(a.id)
    bus.setActiveSession(undefined)
    expect(bus.activeSession).toBeUndefined()
  })
})

describe('singleton access', () => {
  test('getSessionBus returns one process-wide instance', () => {
    expect(getSessionBus()).toBe(getSessionBus())
    expect(getSessionBus()).toBe(getSessionBus())
  })

  test('createSessionBus produces a fresh, isolated instance per call', () => {
    const one = createSessionBus()
    const two = createSessionBus()
    expect(one).not.toBe(two)
    const a = one.create(makeSessionName('only-in-one'))
    expect(two.get(a.id)).toBeUndefined()
    expect(two.list()).toEqual([])
  })
})