import { afterEach, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createJournal, readCheckpoint, readEvents, runDir } from './journal.ts'
import type { ConversationMessage } from '../agentLoop.ts'

const runIds: string[] = []

afterEach(() => {
  for (const runId of runIds.splice(0)) rmSync(runDir(runId), { recursive: true, force: true })
})

function freshRunId(): string {
  const id = `test-journal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  runIds.push(id)
  return id
}

test('two journals opened on the same run never reuse a seq number', () => {
  const runId = freshRunId()
  const a = createJournal(runId, 'goal')
  const b = createJournal(runId, 'goal')

  // Interleave writes from both handles, the way a resume + a fork would.
  a.append('phase', { n: 1 })
  b.append('phase', { n: 2 })
  a.append('tool', { n: 3 })
  b.append('tool', { n: 4 })

  const seqs = readEvents(runId).map((event) => event.seq)
  expect(new Set(seqs).size).toBe(seqs.length) // all unique
  expect([...seqs].sort((x, y) => x - y)).toEqual(seqs) // already monotonic on disk
})

test('checkpoint ids do not collide across two journals on the same run', () => {
  const runId = freshRunId()
  const a = createJournal(runId, 'goal')
  const b = createJournal(runId, 'goal')

  const id1 = a.checkpoint('one', [])
  const id2 = b.checkpoint('two', [])
  const id3 = a.checkpoint('three', [])
  expect(new Set([id1, id2, id3]).size).toBe(3)
})

// #1242: secret VALUES must be redacted at rest (events.ndjson, checkpoints,
// and the in-memory events that feed receipts) — not only key names.
test('secret values are redacted in events.ndjson, checkpoints, and in-memory events', () => {
  const runId = freshRunId()
  const journal = createJournal(runId, 'goal')
  const token = 'sk-proj-1234567890abcdefghij' // pragma: allowlist secret
  journal.append('verify', { command: `echo ${token}`, exitCode: 0 })
  journal.checkpoint('c1', [{ role: 'user', content: `use ${token} against the registry` }] as unknown as ConversationMessage[])

  const onDisk = readEvents(runId)
  expect(onDisk.find((event) => event.kind === 'verify')?.data.command).not.toContain(token)
  expect(onDisk.find((event) => event.kind === 'verify')?.data.command).toContain('[REDACTED]')
  // The in-memory copy a receipt embeds must agree with what is on disk.
  expect(journal.events()).toEqual(onDisk)

  const ndjson = readFileSync(join(runDir(runId), 'events.ndjson'), 'utf8')
  expect(ndjson).not.toContain(token)

  const checkpoint = readCheckpoint(runId, 1)
  expect(JSON.stringify(checkpoint?.messages ?? [])).not.toContain(token)
})
