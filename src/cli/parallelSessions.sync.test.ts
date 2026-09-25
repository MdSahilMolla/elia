import { describe, expect, test } from 'bun:test'
import { makeSessionId, makeSessionName, type MemorySlice, type SessionBus, type SessionHandle, type SyncConflict, type SyncReport } from '../session/types.ts'
import type { SyncDecision } from '../session/sync.ts'
import { conflictPromptLabel, parseConflictChoice, promptForConflictDecisions, runParallelSessions } from './parallelSessions.ts'

const EMPTY_MEMORY: MemorySlice = { lessons: [], projectNotes: [], localLessons: [], localNotes: [] }

function session(id: string, name: string, localLessons: string[] = []): SessionHandle {
  return {
    id: makeSessionId(id),
    name: makeSessionName(name),
    status: 'running',
    taskQueue: [],
    memorySlice: { ...EMPTY_MEMORY, localLessons },
    lastActivity: Date.now(),
    activeAgents: 0,
    sharedContext: {},
    dependencies: [],
    checkpoints: new Map(),
    lastTask: undefined,
  }
}

function busWith(a: SessionHandle, b: SessionHandle): SessionBus {
  const byId = new Map<string, SessionHandle>([[a.id, a], [b.id, b]])
  return {
    activeSession: a.id,
    setActiveSession() {},
    create() {
      throw new Error('create not implemented')
    },
    fork() {
      throw new Error('fork not implemented')
    },
    get(id) {
      return byId.get(id)
    },
    byName(name) {
      return [a, b].find((handle) => handle.name === name)
    },
    resolve(ref) {
      return byId.get(ref) ?? [a, b].find((handle) => handle.name === ref)
    },
    list() {
      return [a, b]
    },
    update(handleId, patch) {
      const target = byId.get(handleId)
      if (target && patch.memorySlice) target.memorySlice = patch.memorySlice
    },
    setStatus() {},
    pushTask() {},
    noteCheckpoint() {},
    emitDrop() {},
    subscribeDrop() {
      return () => {}
    },
    emit() {},
    on() {
      return () => {}
    },
    kill() {},
  }
}

const conflicts: SyncConflict[] = [
  { key: 'server is a callback hell', a: 'server is a callback hell', b: 'server is async-clean now' },
  { key: 'deploy via docker', a: 'deploy via docker', b: 'deploy via kubernetes' },
]

describe('parseConflictChoice', () => {
  test('accepts the four valid choices case-insensitively', () => {
    expect(parseConflictChoice('a')).toBe('a')
    expect(parseConflictChoice('B')).toBe('b')
    expect(parseConflictChoice('both')).toBe('both')
    expect(parseConflictChoice('Drop')).toBe('drop')
    expect(parseConflictChoice(' second ')).toBe('b')
  })

  test('rejects empty and unknown answers so the key stays unresolved', () => {
    expect(parseConflictChoice('')).toBeUndefined()
    expect(parseConflictChoice('  ')).toBeUndefined()
    expect(parseConflictChoice('maybe')).toBeUndefined()
    expect(parseConflictChoice(undefined)).toBeUndefined()
    expect(parseConflictChoice(null)).toBeUndefined()
  })
})

describe('conflictPromptLabel', () => {
  test('shows both sides and the key on one label', () => {
    const label = conflictPromptLabel(conflicts[0]!, 0)
    expect(label).toContain(conflicts[0]!.key)
    expect(label).toContain('server is async-clean now')
    expect(label).toContain('[a] first')
  })
})

describe('promptForConflictDecisions', () => {
  test('collects a decision per answered key, in order', async () => {
    const asked: string[] = []
    const decisions = await promptForConflictDecisions(conflicts, async (label) => {
      asked.push(label)
      return asked.length === 1 ? 'a' : 'both'
    })
    expect(asked).toHaveLength(2)
    expect(decisions).toEqual([
      { key: conflicts[0]!.key, choice: 'a' },
      { key: conflicts[1]!.key, choice: 'both' },
    ])
  })

  test('skips keys the user declines to resolve', async () => {
    const decisions = await promptForConflictDecisions(conflicts, async () => '')
    expect(decisions).toEqual([])
  })
})

describe('elia sessions sync conflict decide', () => {
  function makeDeps(a: SessionHandle, b: SessionHandle, askerAnswers: string[]) {
    let next = 0
    const askedRefs: Array<[string, string]> = []
    const decided: Array<SyncDecision[] | undefined> = []
    const bus = busWith(a, b)
    const deps = {
      loadBus: async () => bus,
      createWorktree: async () => '/nonexistent/worktree',
      removeWorktree: async () => {},
      loadSync: async () => ({
        syncSessions: async (
          aRef: string,
          bRef: string,
          _bus: SessionBus,
          decide?: (c: SyncConflict[]) => Promise<SyncDecision[]>,
        ): Promise<SyncReport> => {
          askedRefs.push([aRef, bRef])
          const decisions = decide ? await decide(conflicts) : undefined
          decided.push(decisions)
          return { diff: { aOnly: [], bOnly: [], conflicts }, resolved: decisions ?? [] }
        },
      }),
      asker: {
        question: async (): Promise<string> => askerAnswers[next++] ?? '',
      },
    }
    return { deps, askedRefs, decided }
  }

  test('an interactive asker resolves the conflicts into the report', async () => {
    const a = session('sync-a', 'alpha', ['server is a callback hell'])
    const b = session('sync-b', 'beta', ['server is async-clean now'])
    const { deps, askedRefs, decided } = makeDeps(a, b, ['b', 'drop'])

    await runParallelSessions(['sync', a.id, b.id], deps)

    expect(askedRefs).toEqual([[a.id, b.id]])
    expect(decided).toEqual([
      [
        { key: conflicts[0]!.key, choice: 'b' },
        { key: conflicts[1]!.key, choice: 'drop' },
      ],
    ])
  })

  test('an unresolved answer is simply skipped, never guessed', async () => {
    const a = session('sync-c', 'alpha', ['server is a callback hell'])
    const b = session('sync-c2', 'beta', ['server is async-clean now', 'deploy via docker'])
    const { deps, decided } = makeDeps(a, b, ['', 'a'])

    await runParallelSessions(['sync', a.id, b.id], deps)

    expect(decided[0]).toEqual([{ key: conflicts[1]!.key, choice: 'a' }])
  })

  test('--plain keeps the deterministic no-ask behavior', async () => {
    const a = session('sync-p', 'alpha', ['server is a callback hell', 'deploy via docker'])
    const b = session('sync-p2', 'beta', ['server is async-clean now', 'deploy via kubernetes'])
    const { deps, decided } = makeDeps(a, b, [])

    await runParallelSessions(['sync', a.id, b.id, '--plain'], deps)

    expect(decided).toEqual([undefined])
  })

  test('--quiet keeps the deterministic no-ask behavior too', async () => {
    const a = session('sync-d', 'alpha', ['deploy via docker'])
    const b = session('sync-d2', 'beta', ['deploy via kubernetes'])
    const { deps, decided } = makeDeps(a, b, [])

    await runParallelSessions(['sync', a.id, b.id, '--quiet'], deps)

    expect(decided).toEqual([undefined])
  })
})