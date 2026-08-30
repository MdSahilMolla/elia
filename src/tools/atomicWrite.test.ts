import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite } from './atomicWrite.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-atomic-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('creates a new file, including missing parent directories', async () => {
  const path = join(dir, 'a', 'b', 'c.txt')
  await atomicWrite(path, 'hello')
  expect(readFileSync(path, 'utf8')).toBe('hello')
})

test('overwrites an existing file with the complete new content', async () => {
  const path = join(dir, 'f.txt')
  writeFileSync(path, 'old content that is longer')
  await atomicWrite(path, 'new')
  expect(readFileSync(path, 'utf8')).toBe('new')
})

test('leaves no temp files behind on success', async () => {
  const path = join(dir, 'f.txt')
  await atomicWrite(path, 'one')
  await atomicWrite(path, 'two')
  const leftovers = readdirSync(dir).filter((name) => name.includes('.elia-') || name.endsWith('.tmp'))
  expect(leftovers).toEqual([])
})

test('preserves the existing file mode across the rename', async () => {
  if (process.platform === 'win32') return // POSIX mode bits are not meaningful on Windows
  const path = join(dir, 'script.sh')
  writeFileSync(path, '#!/bin/sh\necho old\n')
  chmodSync(path, 0o755)
  await atomicWrite(path, '#!/bin/sh\necho new\n')
  expect(statSync(path).mode & 0o777).toBe(0o755)
})

test('a failure before the rename leaves the original file untouched and cleans up', async () => {
  const path = join(dir, 'target')
  writeFileSync(path, 'original')
  // Force writeFile to fail: the temp path's parent is `path` itself (a file),
  // so no temp file can be created under it. atomicWrite mkdir(dirname) first,
  // so instead point at a path whose parent is a regular file.
  const nested = join(path, 'child.txt')
  await expect(atomicWrite(nested, 'x')).rejects.toThrow()
  expect(readFileSync(path, 'utf8')).toBe('original')
})

test('concurrent writers never produce a torn file', async () => {
  const path = join(dir, 'race.txt')
  const a = 'A'.repeat(20_000)
  const b = 'B'.repeat(20_000)
  await Promise.all([atomicWrite(path, a), atomicWrite(path, b), atomicWrite(path, a), atomicWrite(path, b)])
  const final = readFileSync(path, 'utf8')
  expect(final === a || final === b).toBe(true)
})

test('round-trips binary content', async () => {
  const path = join(dir, 'bin')
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0])
  await atomicWrite(path, bytes)
  expect(new Uint8Array(readFileSync(path))).toEqual(bytes)
})
