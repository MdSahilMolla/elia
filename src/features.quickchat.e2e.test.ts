import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionBus } from './session/bus.ts'
import { makeSessionName, type SessionBus, type SessionHandle } from './session/types.ts'
import { formatQuickchatResult } from './quickchat/present.ts'
import { handleQuickchatCommand, parseQuickchatCommand, type FastResponder } from './quickchat/quickchat.ts'
import { quickchatStore } from './ui/app/quickchatOverlayStore.ts'

/**
 * End-to-end proof of the /quickchat logic chain WITHOUT a terminal or Ink
 * renderer: a REAL session bus mirrors the REPL's lazy registration, commands
 * flow through handleQuickchatCommand -> formatQuickchatResult, slow kinds drive
 * the shared quickchatStore overlay exactly as runQuickchatOverlay does, and
 * nothing ever advances the session's turn.
 */

const tempDirs: string[] = []

function tempLogDir(): string {
  const dir = join(tmpdir(), `quickchat-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

/** Mirrors interactive.ts registerQuickchatSession: a fresh bus, a "main" handle, set active. */
function bootQuickchatSession(): { bus: SessionBus; session: SessionHandle } {
  const bus = createSessionBus()
  const session = bus.create(makeSessionName('main'))
  bus.setActiveSession(session.id)
  return { bus, session }
}

/** The store is a process-global singleton with no reset; open() wipes it, close() hides it. */
function resetQuickchatStore(): void {
  quickchatStore.open('', '')
  quickchatStore.requestClose()
}

beforeEach(resetQuickchatStore)

afterEach(() => {
  resetQuickchatStore()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('quickchat logic chain end-to-end', () => {
  test('a real bus boots a "main" session the shape of the REPL lazy registration', () => {
    const { bus, session } = bootQuickchatSession()
    expect(bus.activeSession).toBe(session.id)
    expect(bus.resolve('main')).toBe(session)
    expect(bus.resolve(session.id)).toBe(session)
    expect(session.status).toBe('running')
    expect(session.taskQueue).toEqual([])
  })

  test('/quickchat status parses, is handled, and renders the printable session line', async () => {
    const { bus, session } = bootQuickchatSession()
    expect(parseQuickchatCommand('/quickchat status')).toEqual({ kind: 'status' })
    const result = await handleQuickchatCommand('/quickchat status', session, { bus })
    expect(result.handled).toBe(true)
    const text = formatQuickchatResult(result.result)
    expect(text).toContain('session running')
    expect(text).toContain('queue empty')
  })

  test('/quickchat delegate lands a queued quickchat task in the session queue', async () => {
    const { bus, session } = bootQuickchatSession()
    const result = await handleQuickchatCommand('/quickchat delegate "implement the sync flow"', session, { bus })
    expect(result.handled).toBe(true)
    expect(formatQuickchatResult(result.result)).toContain('Queued in session')
    expect(session.taskQueue).toHaveLength(1)
    const record = session.taskQueue[0]!
    expect(record.source).toBe('quickchat')
    expect(record.status).toBe('queued')
    expect(record.goal).toBe('implement the sync flow')
    expect(session.status).toBe('running')
  })

  test('/quickchat summary renders plan step counts and modified file paths', async () => {
    const { bus, session } = bootQuickchatSession()
    const result = await handleQuickchatCommand(
      '/quickchat summary',
      session,
      {
        bus,
        planSteps: [
          { id: 'p1', title: 'wire the bus', status: 'done' },
          { id: 'p2', title: 'parallel dispatch', status: 'running' },
          { id: 'p3', title: 'verify', status: 'todo' },
        ],
        filesModified: [{ path: 'src/quickchat.ts', summary: 'added handler' }],
      },
    )
    expect(result.handled).toBe(true)
    const text = formatQuickchatResult(result.result)
    expect(text).toContain('1/3 steps done')
    expect(text).toContain('parallel dispatch')
    expect(text).toContain('src/quickchat.ts')
  })

  test('/quickchat <question> streams the fastResponder answer into the overlay and never touches the session', async () => {
    const { bus, session } = bootQuickchatSession()
    const question = 'what is the current state of this session file?'
    const fastResponder: FastResponder = async () => 'fixed reply: two files modified, plan is green.'

    quickchatStore.open(question, session.name)
    expect(quickchatStore.getSnapshot().status).toBe('open')
    expect(quickchatStore.getSnapshot().question).toBe(question)

    const result = await handleQuickchatCommand(`/quickchat ${question}`, session, { bus, fastResponder, logDir: tempLogDir() })
    expect(result.handled).toBe(true)
    const text = formatQuickchatResult(result.result)
    expect(text).toContain('fixed reply:')

    quickchatStore.appendText(text)

    const snap = quickchatStore.getSnapshot()
    expect(snap.status).toBe('open')
    expect(snap.question).toBe(question)
    expect(snap.contextLabel).toBe('main')
    expect(snap.answer).toContain('fixed reply:')

    expect(session.taskQueue).toHaveLength(0)
    expect(session.status).toBe('running')
  })

  test('a non-quickchat input line stays unhandled for the REPL pipeline', async () => {
    const { bus, session } = bootQuickchatSession()
    const result = await handleQuickchatCommand('summarize the diff', session, { bus })
    expect(result.handled).toBe(false)
  })
})