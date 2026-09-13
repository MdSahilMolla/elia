import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureBeforeWrite,
  createFileTracker,
  loadCheckpoints,
  messagesForRestore,
  peekCheckpointFile,
  restoreCheckpoint,
  saveCheckpoints,
  setActiveTracker,
  snapshotMessages,
  type Checkpoint,
} from './checkpoint.ts'
import type { ConversationMessage } from './agentLoop.ts'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-checkpoint-test-'))
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

afterEach(() => {
  setActiveTracker(undefined)
})

const sampleMessages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

test('per-turn snapshots share one copy of each earlier message instead of re-cloning the history', () => {
  const live: ConversationMessage[] = []
  const snapshots: ConversationMessage[][] = []
  for (let turn = 0; turn < 5; turn++) {
    snapshots.push(snapshotMessages(live))
    live.push({ role: 'user', content: [{ type: 'text', text: `turn ${turn}` }] })
    live.push({ role: 'assistant', content: [{ type: 'text', text: `reply ${turn}` }] })
  }
  // The first message appears in four later snapshots — as the very same object.
  expect(snapshots[1]![0]).toBe(snapshots[4]![0])
  // ...and that shared object is a private copy, not the live message.
  expect(snapshots[4]![0]).not.toBe(live[0])
  expect(snapshots[4]![0]).toEqual(live[0]!)
  // A snapshot is still exactly the history at that point.
  expect(snapshots[2]!.map((m) => (m.content[0] as { text: string }).text)).toEqual(['turn 0', 'reply 0', 'turn 1', 'reply 1'])
})

test('restoring hands back a fresh history that does not alias the shared checkpoint copies', () => {
  const snapshot = snapshotMessages(sampleMessages)
  const checkpoint: Checkpoint = { turn: 0, at: 0, label: 'x', messagesBefore: snapshot, files: {} }
  const restored = messagesForRestore(checkpoint)
  expect(restored).toEqual(snapshot)
  expect(restored[0]).not.toBe(snapshot[0])
})

test('loaded checkpoints re-share repeated messages', async () => {
  const shared: ConversationMessage = { role: 'user', content: [{ type: 'text', text: 'first' }] }
  const later: ConversationMessage = { role: 'assistant', content: [{ type: 'text', text: 'second' }] }
  const sessionId = `share-${Date.now().toString(36)}`
  await saveCheckpoints(sessionId, [
    { turn: 0, at: 1, label: 'a', messagesBefore: [], files: {} },
    { turn: 1, at: 2, label: 'b', messagesBefore: [shared, later], files: {} },
    { turn: 2, at: 3, label: 'c', messagesBefore: [shared, later, shared], files: {} },
  ], testDir)
  const loaded = await loadCheckpoints(sessionId, testDir)
  expect(loaded[1]!.messagesBefore[0]).toBe(loaded[2]!.messagesBefore[0])
  expect(loaded[1]!.messagesBefore[1]).toBe(loaded[2]!.messagesBefore[1])
  expect(loaded[2]!.messagesBefore).toEqual([shared, later, shared])
})

test('FileTracker captures a file only on its first touch', async () => {
  const path = join(testDir, 'a.txt')
  await Bun.write(path, 'original')

  const tracker = createFileTracker()
  await tracker.capture(path)
  await Bun.write(path, 'changed')
  await tracker.capture(path) // second touch in the same turn must not overwrite the snapshot

  expect(tracker.snapshot()[path]).toBe('original')
})

test('FileTracker records null for a file that did not exist yet', async () => {
  const path = join(testDir, 'new-file.txt')
  const tracker = createFileTracker()
  await tracker.capture(path)

  expect(tracker.snapshot()[path]).toBeNull()
})

test('captureBeforeWrite is a no-op with no active tracker', async () => {
  await expect(captureBeforeWrite(join(testDir, 'unused.txt'))).resolves.toBeUndefined()
})

test('captureBeforeWrite delegates to the active tracker', async () => {
  const path = join(testDir, 'b.txt')
  await Bun.write(path, 'before')

  const tracker = createFileTracker()
  setActiveTracker(tracker)
  await captureBeforeWrite(path)
  setActiveTracker(undefined)

  expect(tracker.snapshot()[path]).toBe('before')
})

test('restoreCheckpoint writes back captured content and deletes files created since', async () => {
  const existing = join(testDir, 'existing.txt')
  const created = join(testDir, 'created.txt')
  await Bun.write(existing, 'edited content')
  await Bun.write(created, 'new content')

  const checkpoint: Checkpoint = {
    turn: 0,
    at: Date.now(),
    label: 'test',
    messagesBefore: [],
    files: { [existing]: 'original content', [created]: null },
  }

  const result = await restoreCheckpoint(checkpoint)

  expect(result).toEqual({ restored: 1, deleted: 1 })
  expect(await Bun.file(existing).text()).toBe('original content')
  expect(existsSync(created)).toBe(false)
})

test('restoreCheckpoint is idempotent when a "created" file is already gone', async () => {
  const path = join(testDir, 'already-gone.txt')
  const checkpoint: Checkpoint = { turn: 0, at: Date.now(), label: 'test', messagesBefore: [], files: { [path]: null } }

  const result = await restoreCheckpoint(checkpoint)
  expect(result).toEqual({ restored: 0, deleted: 0 })
})

test('restoreCheckpoint leaves every file untouched if staging any one of them fails', async () => {
  const good = join(testDir, 'stage-good.txt')
  // A path whose parent directory doesn't exist: writeFile can't create it,
  // so staging this entry's temp sibling fails and the whole restore must
  // roll back to touching nothing at all — including the good file.
  const bad = join(testDir, 'no-such-parent-dir', 'file.txt')
  await Bun.write(good, 'edited')

  const checkpoint: Checkpoint = {
    turn: 0,
    at: Date.now(),
    label: 'test',
    messagesBefore: [],
    files: { [good]: 'original', [bad]: 'this write must fail' },
  }

  await expect(restoreCheckpoint(checkpoint)).rejects.toThrow()
  // The good file's edit is still there — nothing was partially applied.
  expect(await Bun.file(good).text()).toBe('edited')
  // No leftover temp files anywhere under testDir.
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(testDir).some((name) => name.endsWith('.tmp'))).toBe(false)
})

test('saveCheckpoints then loadCheckpoints round-trips checkpoints', async () => {
  const checkpoints: Checkpoint[] = [
    { turn: 0, at: 1, label: 'first', messagesBefore: sampleMessages, files: { 'x.txt': 'content' } },
  ]

  await saveCheckpoints('sess-1', checkpoints, testDir)
  const loaded = await loadCheckpoints('sess-1', testDir)

  expect(loaded).toEqual(checkpoints)
})

test('loadCheckpoints returns an empty array for an unknown session', async () => {
  const loaded = await loadCheckpoints('does-not-exist', testDir)
  expect(loaded).toEqual([])
})

test('peekCheckpointFile reads a tracked file without writing anything to disk', async () => {
  const path = join(testDir, 'peek-existing.txt')
  await Bun.write(path, 'live content, must not change')
  const checkpoint: Checkpoint = { turn: 0, at: 0, label: 'l', messagesBefore: [], files: { [path]: 'snapshot content' } }

  expect(peekCheckpointFile(checkpoint, path)).toBe('snapshot content')
  expect(await Bun.file(path).text()).toBe('live content, must not change')
})

test('peekCheckpointFile returns null for a file the checkpoint tracked as not-yet-existing', () => {
  const checkpoint: Checkpoint = { turn: 0, at: 0, label: 'l', messagesBefore: [], files: { 'new.txt': null } }
  expect(peekCheckpointFile(checkpoint, 'new.txt')).toBeNull()
})

test('peekCheckpointFile returns undefined for a path the checkpoint never tracked at all', () => {
  const checkpoint: Checkpoint = { turn: 0, at: 0, label: 'l', messagesBefore: [], files: {} }
  expect(peekCheckpointFile(checkpoint, 'untracked.txt')).toBeUndefined()
})
