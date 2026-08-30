import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { editFileTool } from './editFile.ts'
import { readFileTool } from './readFile.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-edit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function edit(input: Record<string, unknown>, signal?: AbortSignal) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir, signal }, () => editFileTool.execute(input))
}

function markRead(path: string) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => readFileTool.execute({ path }))
}

// --- The core invariant: a rejected edit never changes the file at all ---

test('a non-unique old_string without replace_all leaves the file byte-for-byte unchanged', async () => {
  const path = join(dir, 'dup.ts')
  const original = 'const a = 1\nconst a = 1\nconst a = 1\n'
  writeFileSync(path, original)
  await expect(edit({ path, old_string: 'const a = 1', new_string: 'const a = 2' })).rejects.toThrow(/matches 3 location/)
  expect(readFileSync(path, 'utf8')).toBe(original)
})

test('a not-found old_string leaves the file unchanged', async () => {
  const path = join(dir, 'x.ts')
  writeFileSync(path, 'hello world\n')
  await expect(edit({ path, old_string: 'goodbye', new_string: 'x' })).rejects.toThrow(/not found/)
  expect(readFileSync(path, 'utf8')).toBe('hello world\n')
})

test('an edit computed against stale content is rejected and the newer on-disk file is kept', async () => {
  const path = join(dir, 'race.ts')
  writeFileSync(path, 'first version\n')
  await markRead(path)
  // Something else rewrites it between the model's read and this edit.
  writeFileSync(path, 'someone elses change\n')
  await expect(edit({ path, old_string: 'first version', new_string: 'my edit' })).rejects.toThrow(/not found|changed on disk/)
  expect(readFileSync(path, 'utf8')).toBe('someone elses change\n')
})

// --- Cancellation ---

test('an already-aborted run cancels the edit before writing', async () => {
  const path = join(dir, 'c.ts')
  writeFileSync(path, 'keep me\n')
  const controller = new AbortController()
  controller.abort()
  await expect(edit({ path, old_string: 'keep me', new_string: 'changed' }, controller.signal)).rejects.toThrow(/cancelled|aborted/i)
  expect(readFileSync(path, 'utf8')).toBe('keep me\n')
})

// --- Line endings and encoding are preserved ---

test('a CRLF file stays CRLF and a plain-\\n old_string still matches', async () => {
  const path = join(dir, 'crlf.ts')
  writeFileSync(path, 'line one\r\nline two\r\nline three\r\n')
  await edit({ path, old_string: 'line one\nline two', new_string: 'line ONE\nline TWO' })
  expect(readFileSync(path, 'utf8')).toBe('line ONE\r\nline TWO\r\nline three\r\n')
})

test('a file with no trailing newline keeps having no trailing newline', async () => {
  const path = join(dir, 'noeol.ts')
  writeFileSync(path, 'export const x = 1')
  await edit({ path, old_string: 'x = 1', new_string: 'x = 2' })
  expect(readFileSync(path, 'utf8')).toBe('export const x = 2')
})

test('a leading UTF-8 BOM is preserved when editing elsewhere in the file', async () => {
  const path = join(dir, 'bom.ts')
  writeFileSync(path, '﻿export const name = "old"\n')
  await edit({ path, old_string: '"old"', new_string: '"new"' })
  expect(readFileSync(path, 'utf8')).toBe('﻿export const name = "new"\n')
})

test('multibyte content is spliced on character boundaries, not bytes', async () => {
  const path = join(dir, 'unicode.ts')
  writeFileSync(path, 'const emoji = "😀🎉"\nconst greek = "λ φ"\n')
  await edit({ path, old_string: 'λ φ', new_string: 'λ ψ' })
  expect(readFileSync(path, 'utf8')).toBe('const emoji = "😀🎉"\nconst greek = "λ ψ"\n')
})

// --- replace_all ---

test('replace_all changes every occurrence and nothing else', async () => {
  const path = join(dir, 'rename.ts')
  writeFileSync(path, 'oldName()\nconst x = oldName\n// oldName in a comment\n')
  await edit({ path, old_string: 'oldName', new_string: 'newName', replace_all: true })
  expect(readFileSync(path, 'utf8')).toBe('newName()\nconst x = newName\n// newName in a comment\n')
})

test('identical old_string and new_string is rejected before any file work', async () => {
  const path = join(dir, 'noop.ts')
  writeFileSync(path, 'same\n')
  await expect(edit({ path, old_string: 'same', new_string: 'same' })).rejects.toThrow(/identical/)
})
