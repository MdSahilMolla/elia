import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSessionId, makeSessionName, type MemorySlice, type QuickchatContext, type SessionBus, type SessionHandle } from '../session/types.ts'
import { readQuickchatLog } from './overlay.ts'
import {
  handleQuickchatCommand,
  parseQuickchatCommand,
  renderDiff,
  renderSummary,
  resolveFastResponder,
  runQuickchat,
  type RunQuickchatOutcome,
} from './quickchat.ts'

const EMPTY_MEMORY: MemorySlice = { lessons: [], projectNotes: [], localLessons: [], localNotes: [] }

function fakeSession(partial: Omit<Partial<SessionHandle>, 'id' | 'name'> & { id?: string; name?: string } = {}): SessionHandle {
  return {
    id: makeSessionId(partial.id ?? 'quickchat-test-session'),
    name: makeSessionName(partial.name ?? 'test/session'),
    status: partial.status ?? 'running',
    taskQueue: partial.taskQueue ?? [],
    memorySlice: partial.memorySlice ?? EMPTY_MEMORY,
    lastActivity: partial.lastActivity ?? Date.now(),
    activeAgents: 0,
    sharedContext: {},
    dependencies: [],
    checkpoints: new Map(),
    lastTask: partial.lastTask,
  }
}

function fakeBus(sessions: SessionHandle[]): SessionBus {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return {
    activeSession: sessions[0]?.id,
    setActiveSession() {},
    create() {
      throw new Error('create not implemented in fake bus')
    },
    fork() {
      throw new Error('fork not implemented in fake bus')
    },
    get(id) {
      return byId.get(id)
    },
    byName(name) {
      return sessions.find((session) => session.name === name)
    },
    resolve(ref) {
      const byIdHit = byId.get(ref as SessionHandle['id'])
      if (byIdHit) return byIdHit
      return sessions.find((session) => session.name === (ref as SessionHandle['name']))
    },
    list() {
      return [...sessions]
    },
    update() {},
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

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempLogDir(): string {
  const dir = join(tmpdir(), `quickchat-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

test('parseQuickchatCommand covers every form', () => {
  expect(parseQuickchatCommand('how is the build?')).toEqual({ kind: 'ask', question: 'how is the build?' })
  expect(parseQuickchatCommand('/quickchat how is the build?')).toEqual({ kind: 'ask', question: 'how is the build?' })
  expect(parseQuickchatCommand('status')).toEqual({ kind: 'status' })
  expect(parseQuickchatCommand('summary')).toEqual({ kind: 'summary' })
  expect(parseQuickchatCommand('diff')).toEqual({ kind: 'diff' })
  expect(parseQuickchatCommand('risk')).toEqual({ kind: 'risk' })
  expect(parseQuickchatCommand('delegate "refactor the auth layer"')).toEqual({
    kind: 'delegate',
    mode: 'after-step',
    question: 'refactor the auth layer',
  })
  expect(parseQuickchatCommand('delegate --new "scaffold the public api"')).toEqual({
    kind: 'delegate-new',
    mode: 'new-session',
    question: 'scaffold the public api',
  })
  expect(parseQuickchatCommand('delegate --now "run the data migration"')).toEqual({
    kind: 'delegate-now',
    mode: 'now',
    question: 'run the data migration',
  })
  expect(parseQuickchatCommand('delegate write some tests')).toEqual({ kind: 'delegate', mode: 'after-step', question: 'write some tests' })
  expect(parseQuickchatCommand('--session bugfix/queue "what is the failure?"')).toEqual({
    kind: 'session-ask',
    targetSession: 'bugfix/queue',
    question: 'what is the failure?',
  })
  expect(parseQuickchatCommand("--session 'core engine' ship it")).toEqual({ kind: 'session-ask', targetSession: 'core engine', question: 'ship it' })
  expect(parseQuickchatCommand('')).toEqual({ kind: 'ask', question: '' })
})

test('runQuickchat answers, writes the overlay, and appends the log', async () => {
  const session = fakeSession({ id: 'sess-1', name: 'bugfix/queue', lastTask: 'fixing the auth 401' })
  const bus = fakeBus([session])
  const logDir = tempLogDir()
  let seenContext: QuickchatContext | undefined
  let seenQuestion: string | undefined

  const outcome = await runQuickchat({
    sessionRef: 'sess-1',
    question: 'what is going on?',
    bus,
    logDir,
    async fastResponder(ctx, question, _signal) {
      seenContext = ctx
      seenQuestion = question
      return 'It looks like you are mid-refactor.'
    },
  })

  expect(outcome.answer).toBe('It looks like you are mid-refactor.')
  expect(outcome.overlay.status).toBe('closed')
  expect(outcome.overlay.buffer).toBe('It looks like you are mid-refactor.')
  expect(outcome.overlay.contextLabel).toBe('bugfix/queue (sess-1)')
  expect(seenContext?.currentTask).toBe('fixing the auth 401')
  expect(seenQuestion).toBe('what is going on?')

  const entries = readQuickchatLog('sess-1', { dir: logDir })
  expect(entries).toHaveLength(1)
  expect(entries[0]?.question).toBe('what is going on?')
  expect(entries[0]?.answer).toBe('It looks like you are mid-refactor.')
})

test('runQuickchat resolves sessions by name too', async () => {
  const session = fakeSession({ id: 'sess-name', name: 'db/perf' })
  const bus = fakeBus([session])
  const logDir = tempLogDir()
  const outcome = await runQuickchat({
    sessionRef: 'db/perf',
    question: 'status?',
    bus,
    logDir,
    async fastResponder() {
      return 'looks fine.'
    },
  })
  expect(outcome.answer).toBe('looks fine.')
})

test('runQuickchat times out after the override and reports it in the overlay', async () => {
  const session = fakeSession({ id: 'sess-timeout', name: 'slow/session' })
  const bus = fakeBus([session])
  const logDir = tempLogDir()
  const outcome = await runQuickchat({
    sessionRef: 'sess-timeout',
    question: 'hurry up',
    bus,
    logDir,
    timeoutMs: 40,
    async fastResponder(_ctx, _question, signal) {
      // Never settles on its own; resolves only if the signal ever fires.
      return new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => resolve('too late'), { once: true })
      })
    },
  })
  expect(outcome.answer).toContain('timed out')
  expect(outcome.overlay.buffer).toContain('timed out')
  expect(outcome.overlay.status).toBe('closed')
  const entries = readQuickchatLog('sess-timeout', { dir: logDir })
  expect(entries[0]?.answer).toContain('timed out')
})

test('runQuickchat folds provider errors into a readable answer', async () => {
  const session = fakeSession({ id: 'sess-err', name: 'broken/one' })
  const bus = fakeBus([session])
  const logDir = tempLogDir()
  const outcome = await runQuickchat({
    sessionRef: 'sess-err',
    question: 'still there?',
    bus,
    logDir,
    async fastResponder() {
      throw new Error('provider 529 overloaded')
    },
  })
  expect(outcome.answer).toContain('provider 529 overloaded')
  expect(outcome.overlay.status).toBe('closed')
})

test('runQuickchat throws a friendly error for an unknown session', async () => {
  const session = fakeSession({ id: 'sess-known', name: 'known/one' })
  const bus = fakeBus([session])
  await expect(
    runQuickchat({ sessionRef: 'ghost', question: 'hi?', bus, logDir: tempLogDir(), fastResponder: async () => 'never' }),
  ).rejects.toThrow(/Unknown session/)
})

test('handleQuickchatCommand leaves non-quickchat input alone', async () => {
  const session = fakeSession({ id: 'sess-3', name: 'core/engine' })
  const result = await handleQuickchatCommand('set the variable', session, { bus: fakeBus([session]) })
  expect(result.handled).toBe(false)
})

test('handleQuickchatCommand ask path answers via the injected responder', async () => {
  const session = fakeSession({ id: 'sess-4', name: 'core/engine' })
  const logDir = tempLogDir()
  const result = await handleQuickchatCommand('/quickchat what error is live?', session, {
    bus: fakeBus([session]),
    logDir,
    fastResponder: async (_ctx, question) => `observe(${question})`,
  })
  expect(result.handled).toBe(true)
  const outcome = result.result as RunQuickchatOutcome
  expect(outcome.answer).toBe('observe(what error is live?)')
})

test('handleQuickchatCommand status lists the task queue', async () => {
  const session = fakeSession({ id: 'sess-5', name: 'core/engine', status: 'blocked', taskQueue: [{ id: 't1', source: 'quickchat', goal: 'check logs', targetSession: makeSessionId('sess-5'), mode: 'after-step', status: 'queued', createdAt: Date.now() }] })
  const result = await handleQuickchatCommand('/quickchat status', session, { bus: fakeBus([session]) })
  expect(result.handled).toBe(true)
  expect(result.result).toMatchObject({ status: 'blocked', taskQueue: [{ id: 't1' }] })
})

test('handleQuickchatCommand summary renders a 5-line report', async () => {
  const session = fakeSession({ id: 'sess-6', name: 'core/engine', lastTask: 'wiring the bus' })
  const result = await handleQuickchatCommand('/quickchat summary', session, {
    bus: fakeBus([session]),
    planSteps: [
      { id: 'p1', title: 'schema', status: 'done' },
      { id: 'p2', title: 'queries', status: 'running' },
    ],
  })
  expect(result.handled).toBe(true)
  const text = String(result.result)
  const lines = text.split('\n')
  expect(lines).toHaveLength(5)
  expect(text).toContain('core/engine')
  expect(text).toContain('1/2 steps done')
})

test('handleQuickchatCommand diff lists modified files', async () => {
  const session = fakeSession({ id: 'sess-7', name: 'core/engine' })
  const result = await handleQuickchatCommand('/quickchat diff', session, {
    bus: fakeBus([session]),
    filesModified: [{ path: 'src/a.ts', summary: 'refactor parse' }],
  })
  expect(result.handled).toBe(true)
  expect(String(result.result)).toContain('src/a.ts')
  expect(String(result.result)).toContain('refactor parse')
})

test('handleQuickchatCommand risk asks the fast responder to flag risks', async () => {
  const session = fakeSession({ id: 'sess-8', name: 'core/engine' })
  const logDir = tempLogDir()
  const result = await handleQuickchatCommand('/quickchat risk', session, {
    bus: fakeBus([session]),
    logDir,
    fastResponder: async (_ctx, question) => `risks for: ${question.slice(0, 20)}`,
  })
  expect(result.handled).toBe(true)
  const outcome = result.result as RunQuickchatOutcome
  expect(outcome.answer.startsWith('risks for:')).toBe(true)
})

test('handleQuickchatCommand --session targets another session on the bus', async () => {
  const origin = fakeSession({ id: 'sess-origin', name: 'lead/session' })
  const target = fakeSession({ id: 'sess-target', name: 'bugfix/queue' })
  const logDir = tempLogDir()
  const result = await handleQuickchatCommand('/quickchat --session bugfix/queue "is it green?"', origin, {
    bus: fakeBus([origin, target]),
    logDir,
    fastResponder: async (_ctx, question) => `answer for target: ${question}`,
  })
  expect(result.handled).toBe(true)
  const outcome = result.result as RunQuickchatOutcome
  expect(outcome.overlay.contextLabel).toContain('bugfix/queue')
})

test('handleQuickchatCommand --session to an unknown session reports an error, not a throw', async () => {
  const origin = fakeSession({ id: 'sess-origin', name: 'lead/session' })
  const result = await handleQuickchatCommand('/quickchat --session ghost "are you there?"', origin, {
    bus: fakeBus([origin]),
  })
  expect(result.handled).toBe(true)
  expect((result.result as { error?: string }).error).toContain('Unknown session')
})

test('handleQuickchatCommand delegate is handled (resolved by the delegation module when present)', async () => {
  const session = fakeSession({ id: 'sess-9', name: 'core/engine' })
  const result = await handleQuickchatCommand('/quickchat delegate "rebuild the cache"', session, { bus: fakeBus([session]) })
  expect(result.handled).toBe(true)
  // The delegation module is another agent's file; with the fake bus the call
  // either reaches a real delegateTask (needs the registrar) or fails kindly —
  // either way this command is owned and answered, never dropped.
  expect(result.result).toBeDefined()
})

test('renderSummary and renderDiff are pure and deterministic', () => {
  const session = fakeSession({ id: 'sess-10', name: 'render/me', lastTask: 'do the thing' })
  const summary = renderSummary(session, {
    planSteps: [
      { id: 'a', title: 'one', status: 'done' },
      { id: 'b', title: 'two', status: 'todo' },
    ],
    filesModified: [{ path: 'x.ts', summary: 'touch' }],
  })
  expect(summary.split('\n')).toHaveLength(5)
  expect(summary).toContain('render/me')
  expect(summary).toContain('1/2 steps done')

  expect(renderDiff([])).toContain('No modified files')
  expect(renderDiff([{ path: 'a.ts', summary: 'added cfg' }])).toContain('- a.ts: added cfg')
})

test('resolveFastResponder returns a callable fast-tier responder without a network call', async () => {
  const responder = await resolveFastResponder()
  expect(typeof responder).toBe('function')
})