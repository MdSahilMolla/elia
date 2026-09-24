import { describe, expect, test } from 'bun:test'
import {
  delegateTask,
  delegateToFromQueue,
  findRecord,
  popNextTask,
  quickchatStatus,
  slugifyGoal,
  trackDelegation,
} from './delegation.ts'
import { createSessionBus } from './bus.ts'
import { makeSessionName, type CreateHandleOptions, type DelegationRecord, type DelegationStatus, type SessionBus, type SessionHandle, type SessionId, type SessionName } from './types.ts'
import { handleQuickchatDelegate } from '../quickchat/delegation-router.ts'

/**
 * Append-only verification harness: the real `createSessionBus` wrapped so that
 * every taskQueue (initial or from an update patch) is a Proxy which throws on
 * splice/pop/shift/sort/unshift/reverse/fill/copyWithin and on overwriting or
 * skipping queue slots. Any of those lands in `trace.violations` — but only
 * calling splice etc. throws inside a test; for robustness the tests assert the
 * violations list is empty after each flow.
 */
interface TrackedTrace {
  pushes: Array<{ id: SessionId; record: DelegationRecord }>
  queuePatches: Array<{ id: SessionId; queue: Array<{ id: string; status: DelegationStatus }> }>
  violations: string[]
}

const APPEND_ONLY_METHODS = ['splice', 'pop', 'shift', 'unshift', 'sort', 'reverse', 'fill', 'copyWithin'] as const

function appendOnlyQueue(records: readonly DelegationRecord[], trace: TrackedTrace): DelegationRecord[] {
  const target = [...records]
  const violation = (name: string): never => {
    trace.violations.push(`taskQueue.${name}`)
    throw new Error(`append-only violation: taskQueue.${name} is not allowed`)
  }
  const wrapped = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && (APPEND_ONLY_METHODS as readonly string[]).includes(prop)) {
        return () => violation(String(prop))
      }
      const value = Reflect.get(t, prop, receiver)
      return typeof value === 'function' ? value.bind(t) : value
    },
    set(t, prop, value) {
      if (prop === 'length') {
        if (typeof value === 'number' && value < t.length) {
          trace.violations.push('taskQueue.length shrink')
          return false
        }
        return Reflect.set(t, prop, value)
      }
      const index = typeof prop === 'string' ? Number(prop) : Number.NaN
      if (Number.isInteger(index)) {
        if (index === t.length) return Reflect.set(t, prop, value)
        trace.violations.push(`taskQueue[${index}] overwrite/out-of-order`)
        return false
      }
      return Reflect.set(t, prop, value)
    },
  })
  return wrapped as unknown as DelegationRecord[]
}

function trackedBus(): { bus: SessionBus; trace: TrackedTrace } {
  const inner = createSessionBus()
  const trace: TrackedTrace = { pushes: [], queuePatches: [], violations: [] }

  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      if (prop === 'create') {
        return (name: SessionName, opts: CreateHandleOptions = {}) => {
          const handle = value.call(target, name, opts)
          handle.taskQueue = appendOnlyQueue(handle.taskQueue, trace)
          return handle
        }
      }
      if (prop === 'pushTask') {
        return (id: SessionId, record: DelegationRecord) => {
          trace.pushes.push({ id, record })
          return value.call(target, id, record)
        }
      }
      if (prop === 'update') {
        return (id: SessionId, patch: { taskQueue?: DelegationRecord[] }) => {
          if (patch.taskQueue) {
            trace.queuePatches.push({ id, queue: patch.taskQueue.map((r) => ({ id: r.id, status: r.status })) })
            patch.taskQueue = appendOnlyQueue(patch.taskQueue, trace)
          }
          return value.call(target, id, patch)
        }
      }
      return value
    },
  })
  return { bus: proxy as unknown as SessionBus, trace }
}

function seedSession(bus: SessionBus, name: string, opts: CreateHandleOptions = {}): SessionHandle {
  return bus.create(makeSessionName(name), opts)
}

describe('delegateTask · after-step', () => {
  test('quiet-queues into the active session by default', async () => {
    const { bus, trace } = trackedBus()
    expect(bus.activeSession).toBeUndefined()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)

    const { record, confirmation } = await delegateTask({ goal: 'write the readme', mode: 'after-step', bus })

    expect(record.mode).toBe('after-step')
    expect(record.status).toBe('queued')
    expect(record.source).toBe('quickchat')
    expect(record.targetSession).toBe(active.id)
    expect(record.queuedAfterStep).toBe(0)
    expect(confirmation).toBe('Queued in session main after step 0')
    expect(active.taskQueue).toHaveLength(1)
    expect(active.taskQueue[0]?.id).toBe(record.id)
    expect(trace.pushes).toHaveLength(1)
    expect(trace.pushes[0]?.record.id).toBe(record.id)
    expect(trace.violations).toEqual([])
  })

  test('honors planStepCount in queuedAfterStep and the confirmation', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)

    const { record, confirmation } = await delegateTask({ goal: 'rebuild the cache', mode: 'after-step', planStepCount: 4, bus })

    expect(record.queuedAfterStep).toBe(4)
    expect(confirmation).toBe('Queued in session main after step 4')
    expect(active.taskQueue[0]?.queuedAfterStep).toBe(4)
  })

  test('an explicit target beats the active session', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'active')
    const other = seedSession(bus, 'other')
    bus.setActiveSession(active.id)

    const { record } = await delegateTask({ goal: 'refactor the router', mode: 'after-step', target: other.id, bus })

    expect(record.targetSession).toBe(other.id)
    expect(other.taskQueue).toHaveLength(1)
    expect(active.taskQueue).toHaveLength(0)
  })

  test('a cli-source record records cli', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)
    const { record } = await delegateTask({ goal: 'from the terminal', mode: 'after-step', source: 'cli', bus })
    expect(record.source).toBe('cli')
  })

  test('throws a friendly error when there is no active session', async () => {
    const { bus } = trackedBus()
    await expect(delegateTask({ goal: 'fix auth', mode: 'after-step', bus })).rejects.toThrow(/no active session/i)
    await expect(delegateTask({ goal: 'fix auth now', mode: 'now', bus })).rejects.toThrow(/no active session/i)
  })

  test('throws on an empty goal', async () => {
    const { bus } = trackedBus()
    await expect(delegateTask({ goal: '   ', mode: 'after-step', bus })).rejects.toThrow(/goal/i)
  })
})

describe('delegateTask · now', () => {
  test('queues with queuedAfterStep -1 and a "current step" confirmation', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)

    const { record, confirmation } = await delegateTask({ goal: 'apply the hotfix', mode: 'now', bus })

    expect(record.mode).toBe('now')
    expect(record.queuedAfterStep).toBe(-1)
    expect(confirmation).toBe('Queued in session main after the current step')
    expect(active.taskQueue[0]?.queuedAfterStep).toBe(-1)
  })

  test('popNextTask returns it on the very next call', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)
    const { record } = await delegateTask({ goal: 'apply the hotfix', mode: 'now', bus })

    const popped = popNextTask(active, { bus })
    expect(popped?.id).toBe(record.id)
    expect(popped?.status).toBe('active')
    expect(active.taskQueue[0]?.status).toBe('active')
    expect(popNextTask(active, { bus })).toBeUndefined()
  })

  test('a now record pops even mid-step, ahead of a later after-step head', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)
    const later = await delegateTask({ goal: 'later work', mode: 'after-step', target: active.id, planStepCount: 5, bus })
    const urgent = await delegateTask({ goal: 'hotfix', mode: 'now', target: active.id, bus })

    const popped = popNextTask(active, { bus, interruptAfterStep: true })
    expect(popped?.id).toBe(urgent.record.id)
    expect(popped?.id).not.toBe(later.record.id)
    expect(active.taskQueue.map((r) => r.id)).toEqual([later.record.id, urgent.record.id])
  })
})

describe('delegateTask · new-session', () => {
  test('spawns a forked session named auto-<slug> and queues into it', async () => {
    const { bus, trace } = trackedBus()
    const parent = seedSession(bus, 'parent')
    parent.memorySlice.localNotes.push('parent-private-note')
    bus.setActiveSession(parent.id)

    const { record, confirmation, spawned } = await delegateTask({
      goal: 'Add null check to parseConfig in src/config.ts',
      mode: 'new-session',
      bus,
    })

    expect(confirmation).toBe('Spawned session auto-add-null-check-to-parseconfig-in-src-config-ts')
    expect(spawned).toBeDefined()
    expect(record.mode).toBe('new-session')
    expect(record.status).toBe('queued')
    const spawnedId = spawned ?? expect.unreachable('expected a spawned session id')
    expect(record.targetSession).toBe(spawnedId)
    expect(record.spawnedName).toBe(makeSessionName('auto-add-null-check-to-parseconfig-in-src-config-ts'))
    expect(record.spawnedName?.length).toBeLessThanOrEqual(48 + 'auto-'.length)

    const child = bus.get(spawned!)
    expect(child).toBeDefined()
    expect(child?.name).toBe(makeSessionName('auto-add-null-check-to-parseconfig-in-src-config-ts'))
    expect(child?.memorySlice.localNotes).toEqual(['parent-private-note'])
    expect(child?.memorySlice.localNotes).not.toBe(parent.memorySlice.localNotes)
    expect(child?.memorySlice.lessons).toBe(parent.memorySlice.lessons)
    expect(child?.taskQueue.some((r) => r.id === record.id)).toBe(true)
    expect(parent.taskQueue).toHaveLength(0)
    expect(trace.pushes[0]?.id).toBe(spawned)
  })

  test('spawns even with no active session (pristine fork)', async () => {
    const { bus } = trackedBus()
    const { record, confirmation, spawned } = await delegateTask({ goal: 'Scout around', mode: 'new-session', bus })
    expect(confirmation).toBe('Spawned session auto-scout-around')
    expect(spawned).toBe(record.targetSession)
    expect(bus.get(spawned!)?.memorySlice.localNotes).toEqual([])
  })

  test('uses a caller-supplied slugify', async () => {
    const { bus } = trackedBus()
    const { record, confirmation } = await delegateTask({ goal: 'any goal', mode: 'new-session', bus, slugify: () => 'custom-slug' })
    expect(confirmation).toBe('Spawned session auto-custom-slug')
    expect(record.spawnedName).toBe(makeSessionName('auto-custom-slug'))
  })

  test('slugifyGoal handles caps, punctuation, spaces, long input and empties', () => {
    expect(slugifyGoal('Add null check to parseConfig in src/config.ts')).toBe('add-null-check-to-parseconfig-in-src-config-ts')
    expect(slugifyGoal('Add null check to parseConfig in src/config.ts').length).toBeLessThanOrEqual(48)
    expect(slugifyGoal('Hello World')).toBe('hello-world')
    expect(slugifyGoal('  multiple   spaces  and   Tabs\there  ')).toBe('multiple-spaces-and-tabs-here')
    expect(slugifyGoal('Launch 🚀 the ROCKET at 3am!! NOW')).toBe('launch-the-rocket-at-3am-now')
    expect(slugifyGoal('!!! ??? ///')).toBe('task')
    expect(slugifyGoal('')).toBe('task')
    expect(slugifyGoal('a'.repeat(200))).toMatch(/^a{48}$/)
    expect(slugifyGoal('ab cd'.repeat(50))).not.toMatch(/-$/)
  })
})

describe('queue semantics and append-only invariants', () => {
  test('pushTask is strictly append-only and no flow reorders or splices', async () => {
    const { bus, trace } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)

    const first = await delegateTask({ goal: 'first', mode: 'after-step', target: active.id, bus })
    const second = await delegateTask({ goal: 'second', mode: 'after-step', target: active.id, bus })
    const third = await delegateTask({ goal: 'third', mode: 'after-step', target: active.id, bus })

    expect(active.taskQueue.map((r) => r.id)).toEqual([first.record.id, second.record.id, third.record.id])

    const popped = popNextTask(active, { bus, planStepIndex: 0 })
    expect(popped?.id).toBe(first.record.id)
    trackDelegation(first.record.id, bus, 'done')

    const popped2 = popNextTask(active, { bus, planStepIndex: 0 })
    expect(popped2?.id).toBe(second.record.id)

    expect(active.taskQueue.map((r) => r.id)).toEqual([first.record.id, second.record.id, third.record.id])
    expect(active.taskQueue.map((r) => r.status)).toEqual(['done', 'active', 'queued'])
    expect(trace.violations).toEqual([])
    for (const patch of trace.queuePatches) {
      expect(patch.queue).toHaveLength(3)
    }
  })

  test('after-step tasks never pop before their queuedAfterStep boundary', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)
    const { record } = await delegateTask({ goal: 'late', mode: 'after-step', target: active.id, planStepCount: 2, bus })

    expect(popNextTask(active, { bus, planStepIndex: 0 })).toBeUndefined()
    expect(popNextTask(active, { bus, planStepIndex: 1 })).toBeUndefined()
    expect(active.taskQueue[0]?.status).toBe('queued')
    expect(active.taskQueue.map((r) => r.id)).toEqual([record.id])

    expect(popNextTask(active, { bus, planStepIndex: 2 })?.id).toBe(record.id)
    expect(active.taskQueue[0]?.status).toBe('active')
  })

  test('interruptAfterStep never pops a not-yet-due after-step head', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)
    await delegateTask({ goal: 'big', mode: 'after-step', target: active.id, planStepCount: 1, bus })
    expect(popNextTask(active, { bus, interruptAfterStep: true, planStepIndex: 3 })).toBeUndefined()
  })

  test('status transitions queued -> active -> done via trackDelegation and findRecord', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)
    const { record } = await delegateTask({ goal: 'ship it', mode: 'after-step', bus })

    expect(record.status).toBe('queued')
    expect(findRecord(bus, record.id)?.handle.id).toBe(active.id)

    const popped = popNextTask(active, { bus })
    expect(popped?.status).toBe('active')
    expect(active.taskQueue[0]?.status).toBe('active')

    trackDelegation(record.id, bus, 'done')
    expect(active.taskQueue[0]?.status).toBe('done')
    expect(findRecord(bus, record.id)).toBeDefined()

    trackDelegation(record.id, bus, 'cancelled')
    expect(active.taskQueue[0]?.status).toBe('cancelled')
    expect(active.taskQueue).toHaveLength(1)
  })

  test('trackDelegation throws on an unknown record id', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)
    expect(() => trackDelegation('delegation-nope', bus, 'done')).toThrow(/Unknown delegation record/)
    await expect(delegateToFromQueue(bus, {})).rejects.toThrow(/goal/i)
  })

  test('findRecord returns undefined when no session holds the record', () => {
    const { bus } = trackedBus()
    seedSession(bus, 'main')
    expect(findRecord(bus, 'delegation-none')).toBeUndefined()
  })
})

describe('quickchatStatus', () => {
  test('lists queued/active tasks per session and filters by status', async () => {
    const { bus } = trackedBus()
    const alpha = seedSession(bus, 'alpha')
    const beta = seedSession(bus, 'beta')
    const r1 = await delegateTask({ goal: 'one', mode: 'after-step', target: alpha.id, bus, source: 'cli' })
    const r2 = await delegateTask({ goal: 'two', mode: 'after-step', target: alpha.id, bus })
    const r3 = await delegateTask({ goal: 'three', mode: 'after-step', target: beta.id, bus })

    const all = quickchatStatus(bus)
    expect(all).toHaveLength(2)
    expect(all.find((row) => row.sessionName === 'alpha')?.tasks.map((t) => t.id)).toEqual([r1.record.id, r2.record.id])
    expect(all.find((row) => row.sessionName === 'beta')?.tasks.map((t) => t.id)).toEqual([r3.record.id])

    popNextTask(alpha, { bus })
    expect(quickchatStatus(bus, { status: 'active' }).find((row) => row.sessionName === 'alpha')?.tasks.map((t) => t.id)).toEqual([r1.record.id])
    expect(quickchatStatus(bus, { status: 'queued' }).find((row) => row.sessionName === 'alpha')?.tasks.map((t) => t.id)).toEqual([r2.record.id])

    trackDelegation(r1.record.id, bus, 'done')
    trackDelegation(r3.record.id, bus, 'done')
    const doneOnly = quickchatStatus(bus, { status: 'done' })
    expect(doneOnly.find((row) => row.sessionName === 'alpha')?.tasks.map((t) => t.id)).toEqual([r1.record.id])
    expect(doneOnly.find((row) => row.sessionName === 'beta')?.tasks.map((t) => t.id)).toEqual([r3.record.id])
  })

  test('omits sessions with no matching tasks', async () => {
    const { bus } = trackedBus()
    const busy = seedSession(bus, 'busy')
    seedSession(bus, 'idle')

    expect(quickchatStatus(bus)).toEqual([])
    const { record } = await delegateTask({ goal: 'work', mode: 'after-step', target: busy.id, bus })
    const rows = quickchatStatus(bus)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sessionName).toBe('busy')
    expect(rows[0]?.tasks.map((t) => t.id)).toEqual([record.id])
  })
})

describe('delegateToFromQueue', () => {
  test('requires a goal', async () => {
    const { bus } = trackedBus()
    await expect(delegateToFromQueue(bus)).rejects.toThrow(/goal/i)
  })

  test('defaults to a quiet cli after-step into the active session', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)

    await delegateToFromQueue(bus, { goal: '  tidy the prompts  ' })
    expect(active.taskQueue).toHaveLength(1)
    expect(active.taskQueue[0]?.source).toBe('cli')
    expect(active.taskQueue[0]?.mode).toBe('after-step')
    expect(active.taskQueue[0]?.queuedAfterStep).toBe(0)
  })

  test('forwards an explicit mode', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)

    await delegateToFromQueue(bus, { goal: 'fix promptly', mode: 'now' })
    expect(active.taskQueue[0]?.queuedAfterStep).toBe(-1)
  })
})

describe('handleQuickchatDelegate', () => {
  test('queues an after-step task into the active session with a confirmation', async () => {
    const { bus } = trackedBus()
    const active = seedSession(bus, 'main')
    bus.setActiveSession(active.id)

    const result = await handleQuickchatDelegate({ goal: 'reword the help', mode: 'after-step', bus })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.record.targetSession).toBe(active.id)
      expect(result.result.record.source).toBe('quickchat')
      expect(result.result.confirmation).toBe('Queued in session main after step 0')
    }
  })

  test('resolves sessionRef by id or by unambiguous name', async () => {
    const { bus } = trackedBus()
    const other = seedSession(bus, 'other')

    const byName = await handleQuickchatDelegate({ goal: 'x', mode: 'after-step', sessionRef: 'other', bus })
    const byId = await handleQuickchatDelegate({ goal: 'y', mode: 'after-step', sessionRef: other.id, bus })
    expect(byName.ok).toBe(true)
    expect(byId.ok).toBe(true)
    if (byName.ok && byId.ok) {
      expect(byName.result.record.targetSession).toBe(other.id)
      expect(byId.result.record.targetSession).toBe(other.id)
      expect(other.taskQueue).toHaveLength(2)
    }
  })

  test('reports unknown sessions, missing goals and no-active-session as soft failures', async () => {
    const { bus } = trackedBus()
    expect(await handleQuickchatDelegate({ goal: 'x', mode: 'now', sessionRef: 'nope', bus })).toMatchObject({ ok: false })
    expect(await handleQuickchatDelegate({ goal: '   ', mode: 'now', bus })).toMatchObject({ ok: false })
    expect(await handleQuickchatDelegate({ goal: 'x', mode: 'after-step', bus })).toMatchObject({ ok: false })
  })

  test('spawns a new session on new-session mode', async () => {
    const { bus } = trackedBus()
    const result = await handleQuickchatDelegate({ goal: 'Spin up a spike', mode: 'new-session', bus })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.confirmation).toBe('Spawned session auto-spin-up-a-spike')
      expect(result.result.record.spawnedName).toBe(makeSessionName('auto-spin-up-a-spike'))
    }
  })
})