import { describe, expect, test } from 'bun:test'
import { createSessionBus } from './bus.ts'
import { currentSessionIdForCost, runSessionPlusTaskRunner, withSessionCostTracking, wireCrossSessionDependencies } from './integration.ts'
import { makeSessionId, makeSessionName, type DelegationRecord, type SessionId } from './types.ts'

async function poll(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error('poll timed out')
}

function taskRecord(goal: string, targetSession: SessionId): DelegationRecord {
  return {
    id: `t-${goal.replace(/\W+/g, '-')}`,
    source: 'quickchat',
    goal,
    targetSession,
    mode: 'now',
    status: 'queued',
    createdAt: Date.now(),
    queuedAfterStep: -1,
  }
}



describe('runSessionPlusTaskRunner', () => {
  test('pops a queued task at a step boundary and tracks it active → done', async () => {
    const bus = createSessionBus()
    const session = bus.create(makeSessionName('worker'))
    const record = taskRecord('write the tests', session.id)
    bus.pushTask(session.id, record)

    let observedDuringRun: { activeAgents: number; status: string } | undefined
    await runSessionPlusTaskRunner(session.id, {
      bus,
      steps: 0,
      pollMs: 1,
      runTask: async (popped) => {
        observedDuringRun = { activeAgents: session.activeAgents, status: popped.status }
      },
    })

    expect(observedDuringRun).toEqual({ activeAgents: 1, status: 'active' })
    expect(record.status).toBe('done')
    expect(session.activeAgents).toBe(0)
    expect(session.taskQueue).toContain(record)
    expect(session.lastTask).toBe('done: write the tests')
    expect(session.status).toBe('done')
  })

  test('a blocked session unblocks and runs once its dependency fires', async () => {
    const bus = createSessionBus()
    const upstream = bus.create(makeSessionName('a'))
    const dependent = bus.create(makeSessionName('b'), { dependencies: [{ on: upstream.id, checkpoint: 'go', satisfied: false }] })

    const ran: string[] = []
    const runner = runSessionPlusTaskRunner(dependent.id, {
      bus,
      steps: 200,
      pollMs: 1,
      runTask: async (record) => {
        ran.push(record.id)
      },
    })

    await poll(() => bus.get(dependent.id)?.status === 'blocked')
    expect(dependent.status).toBe('blocked')

    bus.noteCheckpoint(upstream.id, 'go')
    expect(dependent.dependencies[0]!.satisfied).toBe(true)

    await poll(() => bus.get(dependent.id)?.status === 'running')
    expect(dependent.status).toBe('running')

    await runner
    expect(dependent.status).toBe('done')
    expect(ran).toEqual([])
  })

  test('an unknown handle id ends the runner immediately', async () => {
    const bus = createSessionBus()
    await expect(
      runSessionPlusTaskRunner('does-not-exist', { bus, steps: 0, pollMs: 1, runTask: async () => {} }),
    ).resolves.toBeUndefined()
  })
})

describe('wireCrossSessionDependencies', () => {
  test('arms a dependent session and starts it once the upstream checkpoint fires', async () => {
    const bus = createSessionBus()
    const upstream = bus.create(makeSessionName('a'))
    const dependent = bus.create(makeSessionName('b'), { dependencies: [{ on: upstream.id, checkpoint: 'auth-final', satisfied: false }] })

    const wiring = wireCrossSessionDependencies(bus, { pollMs: 1 })
    try {
      await poll(() => bus.get(dependent.id)?.status === 'blocked')
      bus.noteCheckpoint(upstream.id, 'auth-final')
      await poll(() => bus.get(dependent.id)?.status === 'running')
      expect(dependent.status).toBe('running')
    } finally {
      wiring.dispose()
      await wiring.drain()
    }
  })

  test('drain() settles after dispose() stops the armed runners', async () => {
    const bus = createSessionBus()
    const upstream = bus.create(makeSessionName('a'))
    const dependent = bus.create(makeSessionName('b'), { dependencies: [{ on: upstream.id, satisfied: false }] })
    const wiring = wireCrossSessionDependencies(bus, { pollMs: 1 })
    await poll(() => bus.get(dependent.id)?.status === 'blocked')
    wiring.dispose()
    await wiring.drain()
    expect(bus.get(dependent.id)).toBe(dependent)
  })
})

describe('withSessionCostTracking', () => {
  test('the cost tag is present inside and absent outside the wrapper', async () => {
    expect(currentSessionIdForCost()).toBeUndefined()

    const outer = makeSessionId('outer-session')
    const inner = makeSessionId('inner-session')
    let seenOuter: SessionId | undefined
    let seenNested: SessionId | undefined
    let seenAfterNested: SessionId | undefined

    await withSessionCostTracking(async () => {
      seenOuter = currentSessionIdForCost()
      await withSessionCostTracking(async () => {
        seenNested = currentSessionIdForCost()
      }, inner)
      seenAfterNested = currentSessionIdForCost()
    }, outer)

    expect(seenOuter).toBe(outer)
    expect(seenNested).toBe(inner)
    expect(seenAfterNested).toBe(outer)
    expect(currentSessionIdForCost()).toBeUndefined()
  })

  test('a synchronous fn is still tagged (wrapper returns the wrapped promise)', async () => {
    const sessionId = makeSessionId('sync-session')
    let captured: SessionId | undefined
    await withSessionCostTracking(async () => {
      captured = currentSessionIdForCost()
    }, sessionId)
    expect(captured).toBe(sessionId)
  })
})

