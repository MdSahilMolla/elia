import { afterAll, describe, expect, test } from 'bun:test'
import { delegateTask } from './session/delegation.ts'
import { runSessionPlusTaskRunner, wireCrossSessionDependencies } from './session/integration.ts'
import { createSessionBus } from './session/bus.ts'
import { makeSessionName, type SessionEvent } from './session/types.ts'

async function poll(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error('poll timed out')
}

describe('parallel sessions + cross-session delegation (e2e, pure logic)', () => {
  const aborters: AbortController[] = []
  let unsubscribedEvents: (() => void) | undefined
  const wirings: ReturnType<typeof wireCrossSessionDependencies>[] = []
  const events: SessionEvent[] = []

  const noopTask = async () => {}

  afterAll(async () => {
    unsubscribedEvents?.()
    for (const wiring of wirings) wiring.dispose()
    for (const aborter of aborters) aborter.abort()
    await Promise.all(wirings.map((wiring) => wiring.drain()))
  })

  test('a new-session delegation spawns an isolated third session that completes without blocking B', async () => {
    const bus = createSessionBus()
    unsubscribedEvents?.()
    unsubscribedEvents = bus.on((event) => events.push(event))

    // Abort controllers let the long-lived runners be torn down deterministically.
    const acA = new AbortController()
    aborters.push(acA)

    // A: the feature session. B: forked from A with isolated local memory.
    const a = bus.create(makeSessionName('feat/rate-limit'))
    const b = bus.fork(a.id, makeSessionName('bugfix/queue'))
    expect(b.memorySlice).not.toBe(a.memorySlice)
    expect(b.memorySlice.localLessons).toEqual([])
    expect(b.memorySlice.localNotes).toEqual([])

    // Fork isolation: A mutating its private scratch must never leak into B.
    a.memorySlice.localLessons.push('response cache the schema')
    expect(b.memorySlice.localLessons).toEqual([])

    // B is dependency-tracked: it parks in 'blocked' until A fires its checkpoint.
    bus.update(b.id, { dependencies: [{ on: a.id, checkpoint: 'rate-limit-schema', satisfied: false }] })

    // Run both task runners. A runs explicitly for its own plan; B's runner is
    // armed by wireCrossSessionDependencies, which bootstraps dependent sessions.
    const aRunner = runSessionPlusTaskRunner(a.id, { bus, runTask: noopTask, pollMs: 2, signal: acA.signal })
    const wiring = wireCrossSessionDependencies(bus, { runTask: noopTask, pollMs: 2 })
    wirings.push(wiring)

    await poll(() => bus.get(b.id)?.status === 'blocked')
    expect(b.status).toBe('blocked')

    // A's schema checkpoint satisfies B's dependency; B's parked runner resumes.
    bus.noteCheckpoint(a.id, 'rate-limit-schema')
    await poll(() => bus.get(b.id)?.status === 'running')
    expect(b.status).toBe('running')

    // A new-session delegation: a THIRD session auto-<slug> is spawned with
    // the task queued as its first job. Never touches B.
    const { record } = await delegateTask({ bus, goal: 'add connection pooling', mode: 'new-session', target: a.id, source: 'cli' })

    const spawned = bus.byName(makeSessionName('auto-add-connection-pooling'))
    expect(spawned).toBeDefined()
    expect(bus.list()).toHaveLength(3)
    if (!spawned) throw new Error('expected an auto-add-connection-pooling session to exist')
    expect(spawned.taskQueue.map((r) => r.id)).toContain(record.id)
    expect(spawned.taskQueue.find((r) => r.id === record.id)!.status).toBe('queued')

    // The spawned session's runner pops the queued record at its step boundary,
    // completes it, and then finishes (bounded steps budget).
    await runSessionPlusTaskRunner(spawned.id, { bus, runTask: noopTask, steps: 0, pollMs: 2 })
    expect(bus.get(spawned.id)?.status).toBe('done')
    const completed = spawned.taskQueue.find((r) => r.id === record.id)!
    expect(completed.status).toBe('done')

    // B was never blocked, descheduled or touched by the delegation or by C's run.
    expect(b.status).toBe('running')

    // At least one cross-session event was observed by the subscription.
    expect(events.some((event) => event.type === 'session:started')).toBe(true)

    // Tear down the long-lived runners deterministically.
    acA.abort()
    await aRunner
    wiring.dispose()
    wirings.splice(wirings.indexOf(wiring), 1)
    await wiring.drain()
  })
})