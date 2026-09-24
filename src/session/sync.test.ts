import { expect, test } from 'bun:test'
import type {
  ContextDrop,
  CreateHandleOptions,
  MemorySlice,
  SessionBus,
  SessionEvent,
  SessionHandle,
  SessionId,
  SessionName,
} from './types.ts'
import { makeSessionId, makeSessionName } from './types.ts'
import { computeSessionSyncDiff, resolveConflicts, syncSessions } from './sync.ts'

function slice(overrides: Partial<MemorySlice> = {}): MemorySlice {
  return { lessons: [], projectNotes: [], localLessons: [], localNotes: [], ...overrides }
}

function handle(id: SessionId, name: SessionName, memorySlice: MemorySlice): SessionHandle {
  return {
    id,
    name,
    status: 'idle',
    taskQueue: [],
    memorySlice,
    lastActivity: Date.now(),
    activeAgents: 0,
    sharedContext: {},
    dependencies: [],
    checkpoints: new Map(),
  }
}

interface FakeRegistry {
  bus: SessionBus
  byId: Map<SessionId, SessionHandle>
  updates: SessionId[]
}

function makeBus(...sessions: SessionHandle[]): FakeRegistry {
  const byId = new Map(sessions.map((entry) => [entry.id, entry]))
  const updates: SessionId[] = []
  let active: SessionId | undefined
  const bus: SessionBus = {
    get activeSession(): SessionId | undefined {
      return active
    },
    setActiveSession(id): void {
      active = id
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
    update(id, patch): void {
      const target = byId.get(id)
      if (!target) return
      Object.assign(target, patch)
      updates.push(id)
    },
    setStatus(): void {},
    pushTask(): void {},
    noteCheckpoint(): void {},
    emitDrop(): void {},
    subscribeDrop(_target: SessionId, _dropName: string, _cb: (drop: ContextDrop) => void): () => void {
      return () => {}
    },
    emit(): void {},
    on(_listener: (event: SessionEvent) => void): () => void {
      return () => {}
    },
    kill(): void {},
  }
  return { bus, byId, updates }
}

test('disjoint additions: no conflict, aOnly/bOnly list the added lines, merge lands on both sessions', async () => {
  const a = handle(makeSessionId('sess-a'), makeSessionName('alpha'), slice({ localLessons: ['lesson a'] }))
  const b = handle(makeSessionId('sess-b'), makeSessionName('beta'), slice({ localNotes: ['note b'] }))
  const { bus, byId } = makeBus(a, b)

  const diff = computeSessionSyncDiff(a.memorySlice, b.memorySlice)
  expect(diff.aOnly).toEqual(['lesson a'])
  expect(diff.bOnly).toEqual(['note b'])
  expect(diff.conflicts).toEqual([])

  const report = await syncSessions('sess-a', 'sess-b', bus)
  expect(report.resolved).toEqual([])
  expect(byId.get(a.id)?.memorySlice.localLessons).toEqual(['lesson a'])
  expect(byId.get(a.id)?.memorySlice.localNotes).toEqual(['note b'])
  expect(byId.get(b.id)?.memorySlice.localLessons).toEqual(['lesson a'])
  expect(byId.get(b.id)?.memorySlice.localNotes).toEqual(['note b'])
})

test('a key both sides changed differently is a single conflict, and decide keeps A', async () => {
  const a = handle(makeSessionId('sess-a'), makeSessionName('alpha'), slice({ localLessons: ['Run tests with bun'] }))
  const b = handle(makeSessionId('sess-b'), makeSessionName('beta'), slice({ localLessons: ['run   tests with bun'] }))
  const { bus, byId } = makeBus(a, b)

  const diff = computeSessionSyncDiff(a.memorySlice, b.memorySlice)
  expect(diff.conflicts).toHaveLength(1)
  expect(diff.conflicts[0]?.key).toBe('run tests with bun')
  expect(diff.conflicts[0]?.a).toBe('Run tests with bun')
  expect(diff.conflicts[0]?.b).toBe('run   tests with bun')

  const report = await syncSessions('sess-a', 'sess-b', bus, async (conflicts) =>
    conflicts.map((conflict) => ({ key: conflict.key, choice: 'a' as const })),
  )
  expect(report.resolved).toEqual([{ key: 'run tests with bun', choice: 'a' }])
  expect(byId.get(a.id)?.memorySlice.localLessons).toEqual(['Run tests with bun'])
  expect(byId.get(b.id)?.memorySlice.localLessons).toEqual(['Run tests with bun'])
})

test('resolveConflicts applies b and drop choices per key', () => {
  const a = slice({ localNotes: ['Keep A wording'] })
  const b = slice({ localNotes: ['keep a wording'] })
  const diff = computeSessionSyncDiff(a, b)
  expect(diff.conflicts).toHaveLength(1)
  const key = diff.conflicts[0]?.key ?? 'missing'

  const keptB = resolveConflicts(diff, [{ key, choice: 'b' }])
  expect(keptB.merged.localA).toEqual(['keep a wording'])
  expect(keptB.merged.localB).toEqual(['keep a wording'])
  expect(keptB.report.resolved).toEqual([{ key, choice: 'b' }])

  const dropped = resolveConflicts(diff, [{ key, choice: 'drop' }])
  expect(dropped.merged.localA).toEqual([])
  expect(dropped.merged.localB).toEqual([])
  expect(dropped.report.resolved).toEqual([{ key, choice: 'drop' }])
})

test("resolveConflicts 'both' keeps A first then B, deduping a repeat", () => {
  const a = slice({ localLessons: ['Primary wording'] })
  const b = slice({ localLessons: ['primary  wording'] })
  const diff = computeSessionSyncDiff(a, b)
  const key = diff.conflicts[0]?.key ?? 'missing'

  const result = resolveConflicts(diff, [{ key, choice: 'both' }])
  expect(result.merged.localA).toEqual(['Primary wording', 'primary  wording'])
  expect(result.merged.localB).toEqual(['Primary wording', 'primary  wording'])
  expect(result.report.resolved).toEqual([{ key, choice: 'both' }])
})

test('undecided conflicts stay out of the merged result and the report', () => {
  const a = slice({ localNotes: ['A version'] })
  const b = slice({ localNotes: ['a version'] })
  const diff = computeSessionSyncDiff(a, b)
  const result = resolveConflicts(diff, [])
  expect(result.merged.localA).toEqual([])
  expect(result.merged.localB).toEqual([])
  expect(result.report.resolved).toEqual([])
  expect(result.report.diff.conflicts).toHaveLength(1)
})

test('empty slices produce an empty diff and a no-op sync', async () => {
  const a = handle(makeSessionId('sess-a'), makeSessionName('alpha'), slice())
  const b = handle(makeSessionId('sess-b'), makeSessionName('beta'), slice())
  const { bus, updates } = makeBus(a, b)

  const diff = computeSessionSyncDiff(a.memorySlice, b.memorySlice)
  expect(diff).toEqual({ aOnly: [], bOnly: [], conflicts: [] })

  const report = await syncSessions('sess-a', 'sess-b', bus)
  expect(report.resolved).toEqual([])
  expect(updates).toEqual([])
})

test('re-merging already-synced sessions is idempotent and writes nothing', async () => {
  const a = handle(makeSessionId('sess-a'), makeSessionName('alpha'), slice({ localLessons: ['shared lesson'] }))
  const b = handle(makeSessionId('sess-b'), makeSessionName('beta'), slice({ localNotes: ['another note'] }))
  const { bus, byId, updates } = makeBus(a, b)

  await syncSessions('sess-a', 'sess-b', bus)
  const afterFirst = {
    aLessons: [...(byId.get(a.id)?.memorySlice.localLessons ?? [])],
    bNotes: [...(byId.get(b.id)?.memorySlice.localNotes ?? [])],
  }
  const updatesAfterFirst = updates.length

  const report = await syncSessions('sess-a', 'sess-b', bus)
  expect(report.resolved).toEqual([])
  expect(byId.get(a.id)?.memorySlice.localLessons).toEqual(afterFirst.aLessons)
  expect(byId.get(b.id)?.memorySlice.localNotes).toEqual(afterFirst.bNotes)
  expect(updates.length).toBe(updatesAfterFirst)
})

test('unknown session refs throw a friendly error', async () => {
  const a = handle(makeSessionId('sess-a'), makeSessionName('alpha'), slice())
  const b = handle(makeSessionId('sess-b'), makeSessionName('beta'), slice())
  const { bus } = makeBus(a, b)

  await expect(syncSessions('ghost', 'sess-b', bus)).rejects.toThrow(/Unknown session "ghost"/)
  await expect(syncSessions('sess-a', 'ghost', bus)).rejects.toThrow(/Unknown session "ghost"/)
})

test('merge writes merged locals back to both handles and never touches project arrays', async () => {
  const projectALessons = ['project lesson a'] as readonly string[]
  const projectANotes = ['project note a'] as readonly string[]
  const projectBLessons = ['project lesson b'] as readonly string[]
  const projectBNotes = ['project note b'] as readonly string[]
  const a = handle(
    makeSessionId('sess-a'),
    makeSessionName('alpha'),
    slice({ lessons: projectALessons, projectNotes: projectANotes, localLessons: ['local a'] }),
  )
  const b = handle(
    makeSessionId('sess-b'),
    makeSessionName('beta'),
    slice({ lessons: projectBLessons, projectNotes: projectBNotes, localNotes: ['local b'] }),
  )
  const { bus, byId } = makeBus(a, b)

  await syncSessions('sess-a', 'sess-b', bus)

  expect(byId.get(a.id)?.memorySlice.lessons).toBe(projectALessons)
  expect(byId.get(a.id)?.memorySlice.projectNotes).toBe(projectANotes)
  expect(byId.get(b.id)?.memorySlice.lessons).toBe(projectBLessons)
  expect(byId.get(b.id)?.memorySlice.projectNotes).toBe(projectBNotes)

  expect(byId.get(a.id)?.memorySlice.localLessons).toEqual(['local a'])
  expect(byId.get(a.id)?.memorySlice.localNotes).toEqual(['local b'])
  expect(byId.get(b.id)?.memorySlice.localLessons).toEqual(['local a'])
  expect(byId.get(b.id)?.memorySlice.localNotes).toEqual(['local b'])
})