import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendNote, loadNotes, rewriteNotes } from './notes.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'elia-notes-')), 'notes.jsonl')
}

test('appendNote persists and loadNotes reads it back', () => {
  const path = tmpFile()
  const note = appendNote({ text: 'the http client retries 3x with jitter', paths: ['src/http.ts'], tags: ['Networking'] }, path)
  expect(note).toBeDefined()
  const loaded = loadNotes(path)
  expect(loaded).toHaveLength(1)
  expect(loaded[0]!.text).toBe('the http client retries 3x with jitter')
  expect(loaded[0]!.paths).toEqual(['src/http.ts'])
  expect(loaded[0]!.tags).toEqual(['networking'])
})

test('appendNote dedupes on exact text, case-insensitively', () => {
  const path = tmpFile()
  appendNote({ text: 'build runs via bun, not node' }, path)
  const dup = appendNote({ text: 'Build runs via bun, not node' }, path)
  expect(dup).toBeUndefined()
  expect(loadNotes(path)).toHaveLength(1)
})

test('appendNote rejects empty text', () => {
  const path = tmpFile()
  expect(appendNote({ text: '   ' }, path)).toBeUndefined()
  expect(loadNotes(path)).toHaveLength(0)
})

test('loadNotes tolerates a torn line', () => {
  const path = tmpFile()
  appendNote({ text: 'first' }, path)
  const { appendFileSync } = require('node:fs')
  appendFileSync(path, '{not json\n')
  appendNote({ text: 'second' }, path)
  expect(loadNotes(path).map((n) => n.text)).toEqual(['first', 'second'])
})

test('rewriteNotes replaces the whole file', () => {
  const path = tmpFile()
  appendNote({ text: 'a' }, path)
  appendNote({ text: 'b' }, path)
  const kept = loadNotes(path).filter((n) => n.text === 'b')
  rewriteNotes(kept, path)
  expect(loadNotes(path).map((n) => n.text)).toEqual(['b'])
})

test('loadNotes returns nothing when the file does not exist', () => {
  expect(loadNotes(join(tmpdir(), 'nope-elia', 'missing.jsonl'))).toEqual([])
})
