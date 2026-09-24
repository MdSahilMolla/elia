import { expect, test } from 'bun:test'
import {
  buildQuickchatContext,
  estimateTokens,
  QUICKCHAT_AGENT_OUTPUT_TOKEN_CAP,
  QUICKCHAT_CONTEXT_TOKEN_CAP,
} from './context-builder.ts'
import { makeSessionId, makeSessionName, type MemorySlice, type SessionHandle } from '../session/types.ts'

const EMPTY_MEMORY: MemorySlice = { lessons: [], projectNotes: [], localLessons: [], localNotes: [] }

function fakeSession(partial: Partial<SessionHandle> = {}): SessionHandle {
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

test('estimateTokens uses the ~4 chars per token rule', () => {
  expect(estimateTokens('')).toBe(0)
  expect(estimateTokens('hello')).toBe(2) // ceil(5 / 4)
  expect(estimateTokens('x'.repeat(400))).toBe(100)
  expect(estimateTokens('y'.repeat(401))).toBe(101)
})

test('defaults fall back to session fields', () => {
  const session = fakeSession({ lastTask: 'Fix the parser' })
  const ctx = buildQuickchatContext(session)
  expect(ctx.sessionId).toBe(session.id)
  expect(ctx.sessionName).toBe(session.name)
  expect(ctx.currentTask).toBe('Fix the parser')
  expect(ctx.recentAgentOutputs).toEqual([])
  expect(ctx.planSteps).toEqual([])
  expect(ctx.filesModified).toEqual([])
  expect(ctx.pendingReviews).toEqual([])
  expect(ctx.currentErrors).toEqual([])
  expect(ctx.memorySlice.lessons).toEqual([])
})

test('opts override session defaults', () => {
  const session = fakeSession({ lastTask: 'Ignored default' })
  const ctx = buildQuickchatContext(session, {
    currentTask: 'Override task',
    planSteps: [{ id: 'p1', title: 'Step one', status: 'running' }],
    filesModified: [{ path: 'src/a.ts', summary: 'added parse' }],
    pendingReviews: ['review: check isolation'],
    currentErrors: ['ERR: crash on empty input'],
    recentAgentOutputs: ['annex: read src/core.ts (450 lines)'],
  })
  expect(ctx.currentTask).toBe('Override task')
  expect(ctx.planSteps[0]?.title).toBe('Step one')
  expect(ctx.filesModified.find((file) => file.path === 'src/a.ts')?.summary).toContain('parse')
  expect(ctx.pendingReviews[0]).toContain('check isolation')
  expect(ctx.currentErrors[0]).toContain('empty input')
  expect(ctx.recentAgentOutputs[0]).toContain('annex:')
})

test('memory slice is copied, never shared by reference', () => {
  const memory: MemorySlice = { lessons: ['lesson'], projectNotes: ['note'], localLessons: [], localNotes: ['scratch'] }
  const session = fakeSession({ memorySlice: memory })
  const ctx = buildQuickchatContext(session)
  expect(ctx.memorySlice).not.toBe(session.memorySlice)
  expect(ctx.memorySlice.lessons).not.toBe(session.memorySlice.lessons)
  expect(ctx.memorySlice.lessons).toEqual(['lesson'])
  expect(ctx.memorySlice.localNotes).toEqual(['scratch'])
})

test('huge recentAgentOutputs stay bounded and newest-first', () => {
  const session = fakeSession()
  // 20 KB per output means one output already exceeds the ~4000-token whole-cap.
  const outputs = Array.from({ length: 200 }, (_, i) => `${i}-`.padEnd(20_000, 'x') + `-${i}`)
  const ctx = buildQuickchatContext(session, { recentAgentOutputs: outputs })

  expect(estimateTokens(JSON.stringify(ctx))).toBeLessThanOrEqual(QUICKCHAT_CONTEXT_TOKEN_CAP)
  // The newest output is always preserved, and order stays newest-first.
  expect(ctx.recentAgentOutputs[0]?.startsWith('0-')).toBe(true)
  // An ellipsis marker entry was appended because older outputs were elided.
  expect(ctx.recentAgentOutputs.find((entry) => entry.includes('elided') && entry.startsWith('…'))).toBeDefined()
  expect(ctx.recentAgentOutputs.length).toBeLessThan(outputs.length)
})

test('outputs alone never exceed the ~2000-token agent cap', () => {
  const sessions = fakeSession()
  const outputs = Array.from({ length: 300 }, (_, i) => `output-${i} ` + 'z'.repeat(300))
  const ctx = buildQuickchatContext(sessions, { recentAgentOutputs: outputs })
  const joined = ctx.recentAgentOutputs.join(' ')
  expect(estimateTokens(joined)).toBeLessThanOrEqual(QUICKCHAT_AGENT_OUTPUT_TOKEN_CAP + estimateTokens('… +older outputs elided'))
  expect(ctx.recentAgentOutputs.length).toBeLessThan(outputs.length)
})

test('filesModified summaries are present and survive the budget', () => {
  const session = fakeSession()
  const ctx = buildQuickchatContext(session, {
    filesModified: [
      { path: 'src/auth.ts', summary: 'added middleware chain' },
      { path: 'src/auth.test.ts', summary: 'tests for the middleware' },
    ],
  })
  const auth = ctx.filesModified.find((file) => file.path === 'src/auth.ts')
  expect(auth?.summary).toContain('middleware')
  expect(ctx.filesModified.length).toBe(2)
})

test('a snapshot is still valid when every trimmable bucket is pushed over budget', () => {
  const session = fakeSession({ lastTask: 'Big task ' + 'y'.repeat(50_000) })
  const memory: MemorySlice = {
    lessons: ['huge lesson ' + 'l'.repeat(50_000)],
    projectNotes: ['huge note ' + 'n'.repeat(50_000)],
    localLessons: ['scratch ' + 's'.repeat(50_000), 'more ' + 'm'.repeat(50_000)],
    localNotes: ['note0 ' + 'z'.repeat(50_000)],
  }
  const ctx = buildQuickchatContext(
    fakeSession({ memorySlice: memory, lastTask: session.lastTask }),
    {
      currentTask: session.lastTask,
      recentAgentOutputs: ['output ' + 'o'.repeat(50_000)],
      filesModified: [{ path: 'src/big.ts', summary: 'huge ' + 'f'.repeat(50_000) }],
      pendingReviews: ['runway review ' + 'r'.repeat(50_000)],
      currentErrors: ['boom ' + 'e'.repeat(50_000)],
      planSteps: [{ id: 's1', title: 'step ' + 't'.repeat(50_000), status: 'running' }],
    },
  )
  expect(estimateTokens(JSON.stringify(ctx))).toBeLessThanOrEqual(QUICKCHAT_CONTEXT_TOKEN_CAP)
  expect(typeof ctx.sessionId).toBe('string')
  expect(Array.isArray(ctx.recentAgentOutputs)).toBe(true)
})