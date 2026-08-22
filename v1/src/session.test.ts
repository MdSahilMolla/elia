import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLatestSession, loadSession, saveSession } from './session.ts'
import type { ConversationMessage } from './agentLoop.ts'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-session-test-'))
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

const sampleMessages: ConversationMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
]

test('saveSession then loadSession round-trips messages', async () => {
  await saveSession('abc123', sampleMessages, testDir)
  const loaded = await loadSession('abc123', testDir)
  expect(loaded?.id).toBe('abc123')
  expect(loaded?.messages).toEqual(sampleMessages)
})

test('loadSession returns undefined for an unknown id', async () => {
  const loaded = await loadSession('does-not-exist', testDir)
  expect(loaded).toBeUndefined()
})

test('loadLatestSession picks the most recently saved session', async () => {
  await saveSession('older', sampleMessages, testDir)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await saveSession('newer', sampleMessages, testDir)

  const latest = await loadLatestSession(testDir)
  expect(latest?.id).toBe('newer')
})

test('loadLatestSession returns undefined when the directory has no sessions', async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'elia-session-empty-'))
  const latest = await loadLatestSession(emptyDir)
  expect(latest).toBeUndefined()
  rmSync(emptyDir, { recursive: true, force: true })
})
