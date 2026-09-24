import { expect, test } from 'bun:test'
import {
  makeSessionId,
  makeSessionName,
  type ContextDrop,
  type CreateHandleOptions,
  type DelegationRecord,
  type SessionBus,
  type SessionCheckpoint,
  type SessionEvent,
  type SessionHandle,
  type SessionId,
  type SessionName,
  type SessionStatus,
} from '../session/types.ts'
import {
  cliOutFor,
  parseParallelSessionsArgs,
  renderLiveSessionsTable,
  renderSyncReport,
  resolveTarget,
  runParallelSessions,
  sessionRef,
  type ParallelSessionsDeps,
} from './parallelSessions.ts'
import { sessionFlagName } from './argv.ts'

class FakeBus implements SessionBus {
  activeSession: SessionId | undefined
  private handles = new Map<SessionId, SessionHandle>()
  private listeners = new Set<(event: SessionEvent) => void>()
  private drops = new Map<string, Array<(drop: ContextDrop) => void>>()
  private counter = 0

  create(name: SessionName, opts: CreateHandleOptions = {}): SessionHandle {
    this.counter += 1
    const id = makeSessionId(`fake-${this.counter}`)
    const handle: SessionHandle = {
      id,
      name,
      status: 'idle',
      worktree: opts.worktree,
      taskQueue: [],
      memorySlice: { lessons: [], projectNotes: [], localLessons: [], localNotes: [] },
      lastActivity: Date.now(),
      activeAgents: 0,
      sharedContext: {},
      dependencies: opts.dependencies ?? [],
      checkpoints: new Map<string, SessionCheckpoint>(),
      lastTask: opts.lastTask,
    }
    this.handles.set(id, handle)
    return handle
  }

  fork(from: SessionId, name: SessionName): SessionHandle {
    const parent = this.get(from)
    const child = this.create(name)
    if (parent) child.memorySlice.localLessons = [...parent.memorySlice.localLessons]
    child.memorySlice.localNotes = [...(parent?.memorySlice.localNotes ?? [])]
    return child
  }

  get(id: SessionId): SessionHandle | undefined {
    return this.handles.get(id)
  }

  byName(name: SessionName): SessionHandle | undefined {
    return [...this.handles.values()].find((handle) => handle.name === name)
  }

  resolve(ref: string): SessionHandle | undefined {
    return this.byName(ref as SessionName) ?? this.handles.get(ref as SessionId)
  }

  list(): SessionHandle[] {
    return [...this.handles.values()]
  }

  update(id: SessionId, patch: Partial<Omit<SessionHandle, 'id'>>): void {
    const handle = this.handles.get(id)
    if (!handle) return
    Object.assign(handle, patch)
  }

  setStatus(id: SessionId, status: SessionStatus): void {
    const handle = this.handles.get(id)
    if (!handle) return
    handle.status = status
    handle.lastActivity = Date.now()
  }

  pushTask(id: SessionId, record: DelegationRecord): void {
    this.handles.get(id)?.taskQueue.push(record)
  }

  noteCheckpoint(id: SessionId, name: string, data?: unknown): void {
    const handle = this.handles.get(id)
    if (!handle) return
    handle.checkpoints.set(name, { name, emittedAt: Date.now(), data })
  }

  emitDrop(drop: ContextDrop): void {
    for (const callback of this.drops.get(drop.name) ?? []) callback(drop)
    this.emit({ type: 'cross:context-sync', sessionId: drop.fromSession, drop })
  }

  subscribeDrop(target: SessionId, dropName: string, callback: (drop: ContextDrop) => void): () => void {
    void target
    const callbacks = this.drops.get(dropName) ?? []
    callbacks.push(callback)
    this.drops.set(dropName, callbacks)
    return () => {
      const updated = callbacks.filter((cb) => cb !== callback)
      if (updated.length > 0) this.drops.set(dropName, updated)
      else this.drops.delete(dropName)
    }
  }

  emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  on(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  kill(id: SessionId): void {
    this.handles.delete(id)
    this.emit({ type: 'session:completed', sessionId: id })
  }

  setActiveSession(id: SessionId | undefined): void {
    this.activeSession = id
  }
}

function capture(): { text: () => string; restore: () => void } {
  const chunks: string[] = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  const write = (target: unknown) => {
    chunks.push(String(target))
    return true
  }
  process.stdout.write = write as typeof process.stdout.write
  process.stderr.write = write as typeof process.stderr.write
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
    },
  }
}

function seed(bus: FakeBus, name: string, status: SessionStatus = 'idle'): SessionHandle {
  const handle = bus.create(makeSessionName(name))
  bus.setStatus(handle.id, status)
  return handle
}

test('dispatch parses nested subcommands and their flags', () => {
  const parsed = parseParallelSessionsArgs(['new', '--name', 'feat/rate-limit'])
  expect(parsed.command).toBe('new')
  expect(parsed.positionals).toEqual(['new'])
  expect(parsed.flags['name']).toBe('feat/rate-limit')
  expect(parseParallelSessionsArgs(['--json', 'list']).json).toBe(true)
  expect(parseParallelSessionsArgs(['--plain', 'kill', 'x']).command).toBe('kill')
  expect(parseParallelSessionsArgs(['--session=alpha', 'attach']).flags['session']).toBe('alpha')
  expect(parseParallelSessionsArgs(['drop', 'notes', '--payload', 'context.md', '--from', 'beta']).flags['payload']).toBe('context.md')
  expect(parseParallelSessionsArgs(['--unknown-flag', 'list']).command).toBe('list')
})

test('cliOutFor merges parsed flags with the process-wide UI mode', () => {
  const parsed = parseParallelSessionsArgs(['--json', 'list'])
  expect(cliOutFor(parsed).json).toBe(true)
  expect(parseParallelSessionsArgs(['list']).json).toBe(false)
})

test('session flag helper exposes the --session value with nothing else changed', () => {
  expect(sessionFlagName()).toBeUndefined()
})

test('new creates a running session, a worktree, and emits session:started', async () => {
  const bus = new FakeBus()
  const worktrees: Array<{ name: string; path: string }> = []
  const deps: Partial<ParallelSessionsDeps> = {
    loadBus: async () => bus,
    createWorktree: async (name) => {
      const path = `H:\\elia\\session-worktrees\\${name}`
      worktrees.push({ name, path })
      return path
    },
  }
  const events: SessionEvent[] = []
  bus.on((event) => events.push(event))

  const captureState = capture()
  try {
    await runParallelSessions(['new', '--name', 'feat/rate-limit'], deps)
  } finally {
    captureState.restore()
  }

  const [handle] = bus.list()
  expect(handle?.name).toBe(makeSessionName('feat/rate-limit'))
  expect(handle?.status).toBe('running')
  expect(handle?.worktree).toBe(`H:\\elia\\session-worktrees\\feat/rate-limit`)
  expect(worktrees).toEqual([{ name: 'feat/rate-limit', path: `H:\\elia\\session-worktrees\\feat/rate-limit` }])
  expect(captureState.text()).toContain('Session "feat/rate-limit" started')
  expect(captureState.text()).toContain('session-worktrees\\feat/rate-limit')
  expect(captureState.text()).toContain(handle!.id)
})

test('new with --plain prints exactly one line: id path', async () => {
  const bus = new FakeBus()
  const captureState = capture()
  try {
    await runParallelSessions(['new', '--name', 'feat/a', '--plain'], {
      loadBus: async () => bus,
      createWorktree: async () => `H:\\fake\\worktrees\\feat/a`,
    })
  } finally {
    captureState.restore()
  }
  const [handle] = bus.list()
  const lines = captureState.text().trim().split('\n')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toBe(`${handle!.id} H:\\fake\\worktrees\\feat/a`)
})

test('new with --json emits a session:started event with id and name', async () => {
  const bus = new FakeBus()
  const captureState = capture()
  try {
    await runParallelSessions(['--json', 'new', '--name', 'feat/rate-limit'], {
      loadBus: async () => bus,
      createWorktree: async () => `H:\\fake\\worktrees\\feat/rate-limit`,
    })
  } finally {
    captureState.restore()
  }
  const handle = bus.list()[0]!
  const emitted = captureState.text().trim().split('\n').map((line) => JSON.parse(line))
  expect(emitted.some((event) => event.type === 'session:started' && event.sessionId === handle.id && event.name === 'feat/rate-limit')).toBe(true)
})

test('new without a name fails and leaves nothing behind', async () => {
  const bus = new FakeBus()
  const login: string[] = []
  const deps: Partial<ParallelSessionsDeps> = { loadBus: async () => bus, createWorktree: async (name) => (login.push(name), '') }
  const captureState = capture()
  try {
    await runParallelSessions(['new'], deps)
  } finally {
    captureState.restore()
  }
  expect(bus.list()).toHaveLength(0)
  expect(login).toHaveLength(0)
})

test('new rejects path-traversal names', async () => {
  const bus = new FakeBus()
  const captureState = capture()
  try {
    await runParallelSessions(['new', '--name', '../escape'], { loadBus: async () => bus })
  } finally {
    captureState.restore()
  }
  expect(bus.list()).toHaveLength(0)
})

test('list prints a table of live sessions and an empty hint when the bus is empty', async () => {
  const bus = new FakeBus()
  seed(bus, 'feat/rate-limit', 'running')
  seed(bus, 'research', 'idle')
  const captureState = capture()
  try {
    await runParallelSessions(['list'], { loadBus: async () => bus })
  } finally {
    captureState.restore()
  }
  const text = captureState.text()
  expect(text).toContain('feat/rate-limit')
  expect(text).toContain('research')
  expect(text).toContain('NAME')
  expect(text).toContain('STATUS')

  const empty = new FakeBus()
  const emptyCapture = capture()
  try {
    await runParallelSessions(['list'], { loadBus: async () => empty })
  } finally {
    emptyCapture.restore()
  }
  expect(emptyCapture.text()).toContain('No live sessions')
})

test('list --json emits one sessions event and no human table', async () => {
  const bus = new FakeBus()
  seed(bus, 'feat/rate-limit', 'running')
  const captureState = capture()
  try {
    await runParallelSessions(['--json', 'list'], { loadBus: async () => bus })
  } finally {
    captureState.restore()
  }
  const lines = captureState.text().trim().split('\n')
  const events = lines.map((line) => JSON.parse(line))
  expect(events).toHaveLength(1)
  expect(events[0]!.type).toBe('sessions')
  expect(events[0]!.sessions).toHaveLength(1)
  expect(events[0]!.sessions[0].name).toBe('feat/rate-limit')
})

test('list --quiet suppresses the table but keeps state accessible via the bus', async () => {
  const bus = new FakeBus()
  seed(bus, 'alpha')
  const captureState = capture()
  try {
    await runParallelSessions(['--quiet', 'list'], { loadBus: async () => bus })
  } finally {
    captureState.restore()
  }
  expect(captureState.text()).toBe('')
})

test('renderLiveSessionsTable renders name, id, status, last task, active agents', () => {
  const bus = new FakeBus()
  const handle = seed(bus, 'feat/rate-limit', 'running')
  bus.update(handle.id, { lastTask: 'wiring the limiter', activeAgents: 2 })
  const lines = renderLiveSessionsTable(bus.list())
  const text = lines.join('\n')
  expect(text).toContain('feat/rate-limit')
  expect(text).toContain(handle.id)
  expect(text).toContain('running')
  expect(text).toContain('wiring the limiter')
  expect(text).toContain('2')
})

test('attach sets the active session and reports it', async () => {
  const bus = new FakeBus()
  seed(bus, 'alpha')
  const captureState = capture()
  try {
    await runParallelSessions(['attach', 'alpha'], { loadBus: async () => bus })
  } finally {
    captureState.restore()
  }
  expect(bus.activeSession).toBeDefined()
  const handle = bus.list()[0]!
  expect(bus.activeSession).toBe(handle.id)
  expect(captureState.text()).toContain('Attached to session "alpha"')
})

test('attach honors --session for the target', async () => {
  const bus = new FakeBus()
  const alpha = seed(bus, 'alpha')
  seed(bus, 'beta')
  await runParallelSessions(['attach', '--session', 'beta'], { loadBus: async () => bus })
  expect(bus.activeSession).toBe(bus.byName('beta' as SessionName)!.id)
  expect(bus.activeSession).not.toBe(alpha.id)
})

test('commands without a session target fall back to the active session', () => {
  const bus = new FakeBus()
  const handle = seed(bus, 'alpha')
  bus.setActiveSession(handle.id)
  const parsed = parseParallelSessionsArgs(['attach'])
  expect(resolveTarget(bus, parsed)?.id).toBe(handle.id)
})

test('kill removes the session and its worktree', async () => {
  const bus = new FakeBus()
  const handle = seed(bus, 'alpha')
  bus.update(handle.id, { worktree: `H:\\elia\\session-worktrees\\alpha` })
  const removed: string[] = []
  const captureState = capture()
  try {
    await runParallelSessions(['kill', 'alpha'], {
      loadBus: async () => bus,
      removeWorktree: async (path) => {
        if (path) removed.push(path)
      },
    })
  } finally {
    captureState.restore()
  }
  expect(bus.get(handle.id)).toBeUndefined()
  expect(removed).toEqual([`H:\\elia\\session-worktrees\\alpha`])
  expect(captureState.text()).toContain('Killed session "alpha"')
})

test('sync resolves both refs and prints the report', async () => {
  const bus = new FakeBus()
  const a = seed(bus, 'alpha')
  seed(bus, 'beta')
  const report = {
    diff: { aOnly: ['lesson-alpha'], bOnly: ['note-beta'], conflicts: [{ key: 'shared', a: 'old', b: 'new' }] },
    resolved: [{ key: 'conflict', choice: 'both' as const }],
  }
  const calls: string[][] = []
  const captureState = capture()
  try {
    await runParallelSessions(['sync', 'alpha', 'beta'], {
      loadBus: async () => bus,
      loadSync: async () => ({
        syncSessions: async (aRef, bRef) => {
          calls.push([aRef, bRef])
          return report
        },
      }),
    })
  } finally {
    captureState.restore()
  }
  expect(calls).toEqual([['alpha', 'beta']])
  expect(a.id.length).toBeGreaterThan(0)
  const text = captureState.text()
  expect(text).toContain('a-only')
  expect(text).toContain('lesson-alpha')
  expect(text).toContain('b-only')
  expect(text).toContain('note-beta')
  expect(text).toContain('conflict')
  expect(text).toContain('conflicts: 1')
})

test('sync --json emits a sessions_sync event', async () => {
  const bus = new FakeBus()
  seed(bus, 'alpha')
  seed(bus, 'beta')
  const report = { diff: { aOnly: ['x'], bOnly: [], conflicts: [] }, resolved: [] }
  const captureState = capture()
  try {
    await runParallelSessions(['--json', 'sync', 'alpha', 'beta'], {
      loadBus: async () => bus,
      loadSync: async () => ({
        syncSessions: async () => report,
      }),
    })
  } finally {
    captureState.restore()
  }
  const events = captureState.text().trim().split('\n').map((line) => JSON.parse(line))
  expect(events[0]!.type).toBe('sessions_sync')
  expect(events[0]!.report.diff.aOnly).toEqual(['x'])
})

test('sync fails with a clear message when the sync module is unavailable', async () => {
  const bus = new FakeBus()
  seed(bus, 'alpha')
  seed(bus, 'beta')
  const captureState = capture()
  try {
    await runParallelSessions(['sync', 'alpha', 'beta'], {
      loadBus: async () => bus,
      loadSync: async () => {
        throw new Error('module not found')
      },
    })
  } finally {
    captureState.restore()
  }
  expect(captureState.text()).toContain('sync is not yet available')
})

test('renderSyncReport renders a-only/b-only/conflict rows', () => {
  const lines = renderSyncReport({ diff: { aOnly: ['k1'], bOnly: ['k2'], conflicts: [] }, resolved: [] })
  expect(lines.join('\n')).toContain('a-only')
  expect(lines.join('\n')).toContain('k1')
  expect(lines.join('\n')).toContain('k2')
  expect(renderSyncReport({ diff: { aOnly: [], bOnly: [], conflicts: [] }, resolved: [] })).toHaveLength(0)
})

test('drop and subscribe reach the contextDrop handlers through the same dispatcher', async () => {
  const bus = new FakeBus()
  const from = seed(bus, 'delta')
  const seen: Array<Record<string, unknown>> = []
  const deps: Partial<ParallelSessionsDeps> = {
    loadBus: async () => bus,
    loadContextDrop: async () => ({
      runContextDrop: async (opts) => {
        seen.push({ kind: 'drop', ...opts })
      },
      runContextSubscribe: async (opts) => {
        seen.push({ kind: 'subscribe', ...opts })
      },
    }),
  }
  await runParallelSessions(['drop', 'plan-v1', '--payload', 'docs/context.md', '--from', 'delta'], deps)
  await runParallelSessions(['subscribe', 'plan-v1', '--from', 'delta'], deps)
  expect(seen).toHaveLength(2)
  expect(seen[0]).toMatchObject({ kind: 'drop', name: 'plan-v1', payloadPath: 'docs/context.md', fromSession: from.id })
  expect(seen[1]).toMatchObject({ kind: 'subscribe', name: 'plan-v1', fromSession: from.id })
})

test('drop warns clearly when the contextDrop module is unavailable', async () => {
  const bus = new FakeBus()
  const captureState = capture()
  try {
    await runParallelSessions(['drop', 'plan-v1'], {
      loadBus: async () => bus,
      loadContextDrop: async () => {
        throw new Error('not found')
      },
    })
  } finally {
    captureState.restore()
  }
  expect(captureState.text()).toContain('context drops are not yet available')
})

test('subscribe requires a --from session', async () => {
  const bus = new FakeBus()
  const captureState = capture()
  try {
    await runParallelSessions(['subscribe', 'plan-v1'], {
      loadBus: async () => bus,
      loadContextDrop: async () => ({ runContextSubscribe: async () => undefined }),
    })
  } finally {
    captureState.restore()
  }
  expect(captureState.text()).toContain('Usage: elia sessions subscribe')
})

test('an unknown nested subcommand is rejected', async () => {
  const bus = new FakeBus()
  const captureState = capture()
  try {
    await runParallelSessions(['bogus'], { loadBus: async () => bus })
  } finally {
    captureState.restore()
  }
  expect(captureState.text()).toContain('Unknown "elia sessions" subcommand')
})

test('sessionRef reads --session against the parsed args', () => {
  expect(sessionRef(parseParallelSessionsArgs(['kill', '--session', 'alpha']))).toBe('alpha')
  expect(sessionRef(parseParallelSessionsArgs(['list']))).toBeUndefined()
})