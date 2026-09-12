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

// --- Sensitive paths ---

test('refuses to edit a protected path', async () => {
  const path = join(dir, '.env')
  writeFileSync(path, 'SECRET=1\n')
  await expect(edit({ path, old_string: 'SECRET=1', new_string: 'SECRET=2' })).rejects.toThrow(/protected path/)
  expect(readFileSync(path, 'utf8')).toBe('SECRET=1\n')
})

test('refuses to edit an ssh private key regardless of extension', async () => {
  const path = join(dir, 'id_rsa')
  writeFileSync(path, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n')
  await expect(edit({ path, old_string: 'abc', new_string: 'xyz' })).rejects.toThrow(/protected path/)
})

// --- Mixed line endings (finding #4) ---

test('a file with genuinely mixed line endings matches and edits the LF region correctly', async () => {
  const path = join(dir, 'mixed.ts')
  // First two lines are CRLF (as if opened once in a Windows editor), the rest
  // is bare LF (as if pasted in afterward) — a single global "the file is CRLF"
  // guess would convert old_string's \n to \r\n and fail to find this region.
  const original = 'crlf line one\r\ncrlf line two\r\nlf line three\nlf line four\n'
  writeFileSync(path, original)
  await edit({ path, old_string: 'lf line three\nlf line four', new_string: 'LF LINE THREE\nLF LINE FOUR' })
  expect(readFileSync(path, 'utf8')).toBe('crlf line one\r\ncrlf line two\r\nLF LINE THREE\nLF LINE FOUR\n')
})

test('a mixed-ending file: editing the CRLF region keeps its CRLF and leaves the LF region untouched', async () => {
  const path = join(dir, 'mixed2.ts')
  const original = 'crlf line one\r\ncrlf line two\r\nlf line three\nlf line four\n'
  writeFileSync(path, original)
  await edit({ path, old_string: 'crlf line one\ncrlf line two', new_string: 'CRLF LINE ONE\nCRLF LINE TWO' })
  expect(readFileSync(path, 'utf8')).toBe('CRLF LINE ONE\r\nCRLF LINE TWO\r\nlf line three\nlf line four\n')
})

test('replace_all finds and replaces every occurrence across a mixed CRLF/LF file', async () => {
  const path = join(dir, 'mixed3.ts')
  const original = 'const target = 1\r\nconsole.log(target)\r\n---\nconst other = 2\nconsole.log(target)\n'
  writeFileSync(path, original)
  await edit({ path, old_string: 'target', new_string: 'renamed', replace_all: true })
  expect(readFileSync(path, 'utf8')).toBe('const renamed = 1\r\nconsole.log(renamed)\r\n---\nconst other = 2\nconsole.log(renamed)\n')
})
