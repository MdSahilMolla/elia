import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchWithJs } from '../tools/grep.ts'
import {
  GoIndexUnavailable,
  goIndexEnabled,
  goIndexMode,
  resolveGoIndexPath,
  searchWithGoIndex,
} from './index.ts'

const savedMode = process.env.ELIA_GO_INDEX
const savedPath = process.env.ELIA_GO_INDEX_PATH

afterEach(() => {
  if (savedMode === undefined) delete process.env.ELIA_GO_INDEX
  else process.env.ELIA_GO_INDEX = savedMode
  if (savedPath === undefined) delete process.env.ELIA_GO_INDEX_PATH
  else process.env.ELIA_GO_INDEX_PATH = savedPath
})

function fixture(): { dir: string; inputDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'elia-goindex-'))
  writeFileSync(join(dir, 'a.ts'), 'const x = 1\nconst y = needle here\nconst z = 3\n')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'b.ts'), 'nothing\nneedle again\ntrailing\n')
  writeFileSync(join(dir, 'sub', 'c.js'), 'no match in this file\n')
  writeFileSync(join(dir, '.env'), 'SECRET=needle-should-stay-hidden\n')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'vendored.ts'), 'needle in vendored code\n')
  return { dir, inputDir: '.' }
}

test('go index mode defaults to off', () => {
  delete process.env.ELIA_GO_INDEX
  expect(goIndexMode()).toBe('off')
  expect(goIndexEnabled()).toBe(false)
})

test('resolveGoIndexPath honors an explicit override', () => {
  const { dir } = fixture()
  const fake = join(dir, 'elia-index')
  writeFileSync(fake, 'x')
  process.env.ELIA_GO_INDEX_PATH = fake
  expect(resolveGoIndexPath()).toBe(fake)
  // A bogus override never resolves to itself — the local build (if present)
  // is used instead, mirroring resolveEliadPath.
  process.env.ELIA_GO_INDEX_PATH = join(dir, 'missing-binary')
  expect(resolveGoIndexPath()).not.toBe(join(dir, 'missing-binary'))
})

test('searchWithGoIndex throws GoIndexUnavailable when off', async () => {
  delete process.env.ELIA_GO_INDEX
  const { dir } = fixture()
  await expect(searchWithGoIndex('needle', dir, '.', undefined, undefined)).rejects.toBeInstanceOf(GoIndexUnavailable)
})

test('searchWithGoIndex throws GoIndexUnavailable when the binary cannot run', async () => {
  process.env.ELIA_GO_INDEX = 'auto'
  // An existing but non-executable file: spawn fails deterministically,
  // regardless of whether a real local build is present.
  const { dir } = fixture()
  const notABinary = join(dir, 'not-a-binary.txt')
  writeFileSync(notABinary, 'x')
  process.env.ELIA_GO_INDEX_PATH = notABinary
  await expect(searchWithGoIndex('needle', dir, '.', undefined, undefined)).rejects.toBeInstanceOf(GoIndexUnavailable)
})

test('go backend matches the pure-JS backend on fixtures', async () => {
  process.env.ELIA_GO_INDEX = 'auto'
  delete process.env.ELIA_GO_INDEX_PATH
  if (!resolveGoIndexPath()) return // binary not built locally; the CI go lane covers this
  const { dir, inputDir } = fixture()
  // The pure-JS backend emits the OS-native separator from Bun.Glob while the
  // sidecar always returns slashes (like the ripgrep tier) — normalize before
  // comparing so the test asserts match/line/grouping parity, not separators.
  const normalize = (s: string) => s.replaceAll('\\', '/')
  for (const [pattern, glob, context] of [
    ['needle', undefined, undefined],
    ['needle', '**/*.ts', undefined],
    ['needle', '**/*.{js,ts}', 1],
    ['const', undefined, 2],
  ] as Array<[string, string | undefined, number | undefined]>) {
    const [go, js] = await Promise.all([
      searchWithGoIndex(pattern, dir, inputDir, glob, context),
      searchWithJs(pattern, dir, inputDir, glob, context),
    ])
    expect(normalize(go)).toBe(normalize(js))
  }
})

test('go backend surfaces a bad pattern like the JS backend', async () => {
  process.env.ELIA_GO_INDEX = 'auto'
  delete process.env.ELIA_GO_INDEX_PATH
  if (!resolveGoIndexPath()) return
  const { dir } = fixture()
  const [goErr, jsErr] = await Promise.all([
    searchWithGoIndex('(', dir, '.', undefined, undefined).then(
      () => 'no-throw',
      (e) => String((e as Error).message),
    ),
    searchWithJs('(', dir, '.', undefined, undefined).then(
      () => 'no-throw',
      (e) => String((e as Error).message),
    ),
  ])
  expect(goErr).toContain('invalid regular expression:')
  expect(jsErr).toContain('invalid regular expression:')
})
