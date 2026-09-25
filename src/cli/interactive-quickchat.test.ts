import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSessionId, makeSessionName, type MemorySlice, type SessionBus, type SessionHandle } from '../session/types.ts'
import { allSlashCommands } from './runtime.ts'
import { formatQuickchatResult } from '../quickchat/present.ts'
import { handleQuickchatCommand, parseQuickchatCommand, type FastResponder } from '../quickchat/quickchat.ts'

const EMPTY_MEMORY: MemorySlice = { lessons: [], projectNotes: [], localLessons: [], localNotes: [] }

function fakeSession(id: string, name: string): SessionHandle {
  return {
    id: makeSessionId(id),
    name: makeSessionName(name),
    status: 'running',
    taskQueue: [],
    memorySlice: EMPTY_MEMORY,
    lastActivity: Date.now(),
    activeAgents: 0,
    sharedContext: {},
    dependencies: [],
    checkpoints: new Map(),
    lastTask: undefined,
  }
}

function fakeBus(session: SessionHandle): SessionBus {
  return {
    activeSession: session.id,
    setActiveSession() {},
    create() {
      throw new Error('create not implemented in fake bus')
    },
    fork() {
      throw new Error('fork not implemented in fake bus')
    },
    get(id) {
      return id === session.id ? session : undefined
    },
    byName(name) {
      return session.name === name ? session : undefined
    },
    resolve(ref) {
      if (ref === session.id) return session
      return session.name === ref ? session : undefined
    },
    list() {
      return [session]
    },
    update() {},
    setStatus() {},
    pushTask(handleId, task) {
      if (handleId === session.id) session.taskQueue.push(task)
    },
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

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempLogDir(): string {
  const dir = join(tmpdir(), `quickchat-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

describe('/quickchat in the REPL', () => {
  test('the slash command is registered for the help list', () => {
    const entry = allSlashCommands().find((command) => command.name === '/quickchat')
    expect(entry).toBeDefined()
    expect(entry?.description).toContain('ask anything about this session')
  })

  test('the REPL-ready parser accepts an input line with the /quickchat prefix', () => {
    expect(parseQuickchatCommand('/quickchat status')).toEqual({ kind: 'status' })
    expect(parseQuickchatCommand('/quickchat summary')).toEqual({ kind: 'summary' })
    expect(parseQuickchatCommand('/quickchat why is the build red?')).toEqual({ kind: 'ask', question: 'why is the build red?' })
  })

  test('status renders as one printable line the REPL can report', async () => {
    const session = fakeSession('interactive-status', 'main')
    const result = await handleQuickchatCommand('/quickchat status', session)
    expect(result.handled).toBe(true)
    const text = formatQuickchatResult(result.result)
    expect(text).toContain('session running')
    expect(text).toContain('queue empty')
  })

  test('summary renders queue and memory without touching the network', async () => {
    const session = fakeSession('interactive-summary', 'main')
    const result = await handleQuickchatCommand(
      '/quickchat summary',
      session,
      {
        planSteps: [
          { id: 'step-1', title: 'wire the REPL', status: 'done' },
          { id: 'step-2', title: 'verify', status: 'running' },
        ],
        filesModified: [{ path: 'src/cli/runtime.ts', summary: 'registered /quickchat' }],
      },
    )
    expect(result.handled).toBe(true)
    const text = formatQuickchatResult(result.result)
    expect(text).toContain('1/2 steps done')
    expect(text).toContain('src/cli/runtime.ts')
    expect(text).toContain('running')
  })

  test('diff lists the recorded files', async () => {
    const session = fakeSession('interactive-diff', 'main')
    const result = await handleQuickchatCommand(
      '/quickchat diff',
      session,
      { filesModified: [{ path: 'src/a.ts', summary: 'added sync decide' }] },
    )
    expect(result.handled).toBe(true)
    expect(formatQuickchatResult(result.result)).toContain('src/a.ts')
  })

  test('an ask goes through the fast tier seam and lands in the visible answer', async () => {
    const session = fakeSession('interactive-ask', 'main')
    const fastResponder: FastResponder = async (_ctx, question) => `fast answer to: ${question}`
    const result = await handleQuickchatCommand(
      '/quickchat what changed in the sync flow?',
      session,
      { bus: fakeBus(session), fastResponder, logDir: tempLogDir() },
    )
    expect(result.handled).toBe(true)
    expect(formatQuickchatResult(result.result)).toBe('fast answer to: what changed in the sync flow?')
  })

  test('--session routes the ask to another named session', async () => {
    const session = fakeSession('interactive-other', 'bugfix/queue')
    const fastResponder: FastResponder = async (_ctx, question) => `other-session answer: ${question}`
    const result = await handleQuickchatCommand(
      '/quickchat --session bugfix/queue what broke?',
      session,
      { bus: fakeBus(session), fastResponder, logDir: tempLogDir() },
    )
    expect(result.handled).toBe(true)
    expect(formatQuickchatResult(result.result)).toBe('other-session answer: what broke?')
  })

  test('risk uses the risk prompt and stays non-blocking in shape', async () => {
    const session = fakeSession('interactive-risk', 'main')
    const fastResponder: FastResponder = async (_ctx, question) => `rerun: ${question}`
    const result = await handleQuickchatCommand(
      '/quickchat risk',
      session,
      { bus: fakeBus(session), fastResponder, logDir: tempLogDir() },
    )
    expect(result.handled).toBe(true)
    expect(formatQuickchatResult(result.result)).toContain('rerun:')
  })

  test('delegate queues a real task and reports a confirmation line', async () => {
    const session = fakeSession('interactive-delegate', 'main')
    const bus = fakeBus(session)
    const result = await handleQuickchatCommand('/quickchat delegate "cover the sync layer"', session, { bus })
    expect(result.handled).toBe(true)
    const text = formatQuickchatResult(result.result)
    expect(text).toContain('Queued in session')
    expect(session.taskQueue).toHaveLength(1)
    expect(session.taskQueue[0]?.goal).toBe('cover the sync layer')
  })

  test('unknown usages still yield a handled, printable error', async () => {
    const session = fakeSession('interactive-error', 'main')
    const result = await handleQuickchatCommand('/quickchat', session)
    expect(result.handled).toBe(true)
    expect(formatQuickchatResult(result.result)).toContain('Usage: /quickchat <question>')
  })

  test('a non-quickchat line is left for the rest of the REPL pipeline', async () => {
    const session = fakeSession('interactive-pass', 'main')
    const result = await handleQuickchatCommand('just a normal prompt', session)
    expect(result.handled).toBe(false)
  })
})