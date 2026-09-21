import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSession } from './session.ts'
import { listSessionIds, listSessionSummaries, resolveSessionId, sessionHolder, sessionTitle } from './sessionCatalog.ts'
import type { ConversationMessage } from './agentLoop.ts'

let dir: string
let statusDir: string

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'elia-catalog-'))
  dir = join(root, 'sessions')
  statusDir = join(root, 'session-status')
})

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

function conversation(prompt: string, replies = 1): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  for (let i = 0; i < replies; i += 1) messages.push({ role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] })
  return messages
}

function heartbeat(id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(statusDir, { recursive: true })
  writeFileSync(
    join(statusDir, `${id}.json`),
    JSON.stringify({
      sessionId: id,
      pid: process.pid,
      mode: 'dev',
      providerLabel: 'fake',
      model: 'fake-model',
      startedAt: Date.now(),
      busy: false,
      lastAction: 'Idle at prompt',
      taskSummary: '',
      messageCount: 2,
      updatedAt: Date.now(),
      ...extra,
    }),
  )
}

test('lists saved conversations newest first, titled by what the user asked', async () => {
  await saveSession('aaa111', conversation('fix the login redirect'), dir, { model: 'fake-model', providerName: 'fake' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await saveSession('bbb222', conversation('write the release notes', 3), dir)

  const sessions = await listSessionSummaries({ dir, statusDir })
  expect(sessions.map((session) => session.id)).toEqual(['bbb222', 'aaa111'])
  expect(sessions[1]).toMatchObject({ title: 'fix the login redirect', turns: 1, messages: 2, model: 'fake-model', status: 'saved', heldByLiveProcess: false })
  expect(sessions[0]).toMatchObject({ title: 'write the release notes', messages: 4 })
})

test('ignores checkpoint sidecars, ledgers and half-written temp files', async () => {
  await saveSession('real123', conversation('the only real one'), dir)
  writeFileSync(join(dir, 'real123.checkpoints.json'), '[]')
  writeFileSync(join(dir, 'real123.ledger.jsonl'), '{}\n')
  writeFileSync(join(dir, 'real123.json.tmp-999-1-abc'), '{}')

  expect(listSessionIds(dir).map((entry) => entry.id)).toEqual(['real123'])
  expect((await listSessionSummaries({ dir, statusDir })).map((session) => session.id)).toEqual(['real123'])
})

test('a conversation held by a live process is flagged, and by a dead one is not', async () => {
  await saveSession('live111', conversation('being worked on right now'), dir)
  await saveSession('dead222', conversation('its process is long gone'), dir)
  heartbeat('live111', { busy: true })
  // A pid that cannot be running: the heartbeat says idle, but nothing holds it.
  heartbeat('dead222', { pid: 0x7fffffff })

  const sessions = await listSessionSummaries({ dir, statusDir })
  const live = sessions.find((session) => session.id === 'live111')
  const dead = sessions.find((session) => session.id === 'dead222')
  expect(live?.heldByLiveProcess).toBe(true)
  expect(live?.status).toBe('running')
  expect(dead?.heldByLiveProcess).toBe(false)
  expect(sessionHolder('live111', statusDir)?.pid).toBe(process.pid)
  expect(sessionHolder('dead222', statusDir)).toBeUndefined()
})

test('a session that ended cleanly is not treated as held', async () => {
  await saveSession('ended11', conversation('finished and exited'), dir)
  heartbeat('ended11', { endedAt: Date.now() })

  const [session] = await listSessionSummaries({ dir, statusDir })
  expect(session?.status).toBe('ended')
  expect(session?.heldByLiveProcess).toBe(false)
  expect(sessionHolder('ended11', statusDir)).toBeUndefined()
})

test('a live session with nothing saved yet is listed but marked unresumable', async () => {
  await saveSession('saved11', conversation('has a conversation'), dir)
  heartbeat('fresh22', { messageCount: 0, lastAction: 'Idle at prompt' })

  const sessions = await listSessionSummaries({ dir, statusDir })
  const fresh = sessions.find((session) => session.id === 'fresh22')
  expect(fresh?.hasConversation).toBe(false)
  expect(fresh?.heldByLiveProcess).toBe(true)
})

test('the limit reads only the newest conversations', async () => {
  for (const id of ['old111', 'mid222', 'new333']) {
    await saveSession(id, conversation(`prompt ${id}`), dir)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const sessions = await listSessionSummaries({ dir, statusDir, limit: 2 })
  expect(sessions.map((session) => session.id)).toEqual(['new333', 'mid222'])
})

test('resolveSessionId takes an exact id or an unambiguous prefix', () => {
  const ids = [{ id: 'mub4fx55-tu1089' }, { id: 'mub4gr6z-7mgwot' }, { id: 'zzz999-abc' }]
  expect(resolveSessionId('mub4fx55-tu1089', ids)).toEqual({ kind: 'found', id: 'mub4fx55-tu1089' })
  expect(resolveSessionId('mub4f', ids)).toEqual({ kind: 'found', id: 'mub4fx55-tu1089' })
  expect(resolveSessionId('mub4', ids)).toEqual({ kind: 'ambiguous', ids: ['mub4fx55-tu1089', 'mub4gr6z-7mgwot'] })
  expect(resolveSessionId('nope', ids)).toEqual({ kind: 'missing' })
  expect(resolveSessionId('  ', ids)).toEqual({ kind: 'missing' })
})

test('the title is the typed prompt, not the context elia folded in after it', () => {
  expect(
    sessionTitle([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ship the parser fix' },
          { type: 'text', text: '<elia-plan>\n1. do a thing\n</elia-plan>' },
        ],
      },
    ]),
  ).toBe('ship the parser fix')
  expect(sessionTitle([{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }])).toBe('(no prompt yet)')
  expect(sessionTitle([])).toBe('(no prompt yet)')
})

test('an empty or missing directory lists nothing rather than throwing', async () => {
  expect(await listSessionSummaries({ dir: join(dir, 'nope'), statusDir })).toEqual([])
  expect(listSessionIds(join(dir, 'nope'))).toEqual([])
})
