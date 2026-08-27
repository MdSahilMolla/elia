import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSessionHeartbeat, writeSessionEnded, listKnownSessions, type SessionHeartbeatInput } from './sessionRegistry.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'elia-session-registry-'))
}

function baseInfo(overrides: Partial<SessionHeartbeatInput> = {}): SessionHeartbeatInput {
  return {
    sessionId: 'abc123',
    pid: 12345,
    mode: 'dev',
    providerLabel: 'anthropic',
    model: 'claude-opus-5',
    startedAt: Date.now() - 60_000,
    busy: false,
    lastAction: 'Idle at prompt',
    taskSummary: '',
    messageCount: 2,
    ...overrides,
  }
}

test('returns an empty list when the status directory does not exist yet', () => {
  const dir = join(tempDir(), 'does-not-exist')
  expect(listKnownSessions(dir)).toEqual([])
})

test('a written heartbeat round-trips with the correct liveStatus', () => {
  const dir = tempDir()
  writeSessionHeartbeat(baseInfo({ busy: true, lastAction: 'edit_file src/foo.ts' }), dir)
  const sessions = listKnownSessions(dir)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ sessionId: 'abc123', liveStatus: 'running', lastAction: 'edit_file src/foo.ts' })
})

test('busy:false reports idle, not running', () => {
  const dir = tempDir()
  writeSessionHeartbeat(baseInfo({ busy: false }), dir)
  expect(listKnownSessions(dir)[0]?.liveStatus).toBe('idle')
})

test('writeSessionEnded reports ended regardless of the busy flag', () => {
  const dir = tempDir()
  writeSessionEnded(baseInfo({ busy: true }), dir)
  const sessions = listKnownSessions(dir)
  expect(sessions[0]?.liveStatus).toBe('ended')
  expect(sessions[0]?.endedAt).toBeDefined()
})

test('a stale "running" heartbeat (no update in a long time) reports stopped, not running', () => {
  const dir = tempDir()
  // Write directly rather than through writeSessionHeartbeat, which always
  // stamps updatedAt to now — this simulates a process that crashed a while ago.
  writeFileSync(
    join(dir, 'stale123.json'),
    JSON.stringify({ ...baseInfo({ sessionId: 'stale123', busy: true }), updatedAt: Date.now() - 10 * 60_000 }),
  )
  expect(listKnownSessions(dir)[0]?.liveStatus).toBe('stopped')
})

test('two concurrent sessions never clobber each other — each is its own file', () => {
  const dir = tempDir()
  writeSessionHeartbeat(baseInfo({ sessionId: 'session-a', lastAction: 'A working' }), dir)
  writeSessionHeartbeat(baseInfo({ sessionId: 'session-b', lastAction: 'B working' }), dir)
  const sessions = listKnownSessions(dir)
  expect(sessions.map((s) => s.sessionId).sort()).toEqual(['session-a', 'session-b'])
})

test('a corrupt heartbeat file is skipped rather than breaking the whole listing', () => {
  const dir = tempDir()
  writeSessionHeartbeat(baseInfo({ sessionId: 'good-session' }), dir)
  writeFileSync(join(dir, 'corrupt.json'), '{ not valid json')
  const sessions = listKnownSessions(dir)
  expect(sessions.map((s) => s.sessionId)).toEqual(['good-session'])
})

test('sessions are sorted most-recently-updated first', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'older.json'), JSON.stringify({ ...baseInfo({ sessionId: 'older' }), updatedAt: 1000 }))
  writeFileSync(join(dir, 'newer.json'), JSON.stringify({ ...baseInfo({ sessionId: 'newer' }), updatedAt: 2000 }))
  const sessions = listKnownSessions(dir)
  expect(sessions.map((s) => s.sessionId)).toEqual(['newer', 'older'])
})
