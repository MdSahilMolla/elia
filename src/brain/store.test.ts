import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBrainItems, keyHash } from './store.ts'
import { appendNote } from './notes.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'elia-brain-'))
}

function writeEpisode(sessionsDir: string, sessionId: string, episode: Record<string, unknown>): void {
  const line = JSON.stringify({ type: 'episode', messageCount: 1, decisions: [], filesTouched: [], symbols: [], openThreads: [], at: Date.now(), ...episode })
  writeFileSync(join(sessionsDir, `${sessionId}.ledger.jsonl`), `${line}\n`)
}

test('loadBrainItems merges episodes from every session, plus lessons, rationale, notes', async () => {
  const dir = scratch()
  const sessionsDir = join(dir, 'sessions')
  require('node:fs').mkdirSync(sessionsDir, { recursive: true })

  writeEpisode(sessionsDir, 'sess-one', { id: 'e1', turn: 2, summary: 'wired the OAuth refresh flow', filesTouched: ['src/auth.ts'] })
  writeEpisode(sessionsDir, 'sess-two', { id: 'e2', turn: 5, summary: 'added retry to the uploader' })

  const lessonsPath = join(dir, 'lessons.md')
  writeFileSync(lessonsPath, '# Lessons\n\n- run tests with bun not node <!-- 2026-01-01T00:00:00Z -->\n')

  const rationalePath = join(dir, 'rationale.jsonl')
  writeFileSync(rationalePath, `${JSON.stringify({ at: Date.now(), path: 'src/auth.ts', decision: 'store tokens in memory only', reason: 'disk persistence is a leak risk', source: 'agent' })}\n`)

  const notesPath = join(dir, 'notes.jsonl')
  appendNote({ text: 'the staging API rate-limits at 20 rps', tags: ['api'] }, notesPath)

  // `cwd` matters even though every explicit path above points into `dir`:
  // the recording and book sources derive `.elia/recordings` and `.elia/books`
  // from cwd rather than from those paths, so leaving it unset falls back to
  // process.cwd() and indexes the developer's real session history into a test
  // that asserts an exact set of kinds. Green on a fresh clone, red on any
  // checkout that has actually been used.
  const items = await loadBrainItems({ cwd: dir, sessionsDir, lessonsPath, rationalePath, notesPath, currentSessionId: 'sess-two' })

  const kinds = items.map((i) => i.kind).sort()
  expect(kinds).toEqual(['episode', 'episode', 'lesson', 'note', 'rationale'])

  const current = items.find((i) => i.key === 'episode:e2')
  expect(current?.fromCurrentSession).toBe(true)
  const earlier = items.find((i) => i.key === 'episode:e1')
  expect(earlier?.fromCurrentSession).toBe(false)
  expect(earlier?.paths).toEqual(['src/auth.ts'])
})

test('loadBrainItems is empty and does not throw when nothing exists yet', async () => {
  const dir = scratch()
  const items = await loadBrainItems({
    cwd: dir,
    sessionsDir: join(dir, 'sessions'),
    lessonsPath: join(dir, 'lessons.md'),
    rationalePath: join(dir, 'rationale.jsonl'),
    notesPath: join(dir, 'notes.jsonl'),
  })
  expect(items).toEqual([])
})

test('keyHash is stable and content-addressed', () => {
  expect(keyHash('hello')).toBe(keyHash('hello'))
  expect(keyHash('hello')).not.toBe(keyHash('world'))
})

test('explicit paths bypass the in-process cache — a fresh note shows up immediately', async () => {
  const dir = scratch()
  const notesPath = join(dir, 'notes.jsonl')
  const common = { sessionsDir: join(dir, 'sessions'), lessonsPath: join(dir, 'lessons.md'), rationalePath: join(dir, 'rationale.jsonl'), notesPath }

  appendNote({ text: 'first fact' }, notesPath)
  expect((await loadBrainItems(common)).map((i) => i.render)).toContain('note: first fact')

  appendNote({ text: 'second fact' }, notesPath)
  expect((await loadBrainItems(common)).map((i) => i.render)).toContain('note: second fact')
})
