import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractPaths, resolveImports } from './prefetch.ts'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-prefetch-'))
  mkdirSync(join(dir, 'src', 'net'), { recursive: true })
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })

  writeFileSync(join(dir, 'src', 'index.ts'), "import { a } from './net/client.ts'\nimport pkg from 'some-package'\n")
  writeFileSync(join(dir, 'src', 'net', 'client.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'src', 'net', 'config.ts'), 'export const t = 1\n')
  writeFileSync(join(dir, 'src', 'deep', 'index.ts'), 'export const d = 1\n')
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.ts'), 'export const p = 1\n')
  writeFileSync(join(dir, 'README.md'), '# readme\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('paths are pulled out of grep-style output', () => {
  const output = ['src/net/client.ts:3:export const a = 1', 'src/net/config.ts:1:export const t = 1'].join('\n')

  expect(extractPaths(output, dir).sort()).toEqual(['src/net/client.ts', 'src/net/config.ts'])
})

test('paths that do not exist on disk are not predicted', () => {
  const output = 'src/net/client.ts:1:x\nsrc/imaginary/nothing.ts:1:y'

  expect(extractPaths(output, dir)).toEqual(['src/net/client.ts'])
})

test('files inside ignored directories are never predicted', () => {
  expect(extractPaths('node_modules/pkg/index.ts:1:export const p = 1', dir)).toEqual([])
})

test('the same path appearing many times is predicted once', () => {
  const output = Array.from({ length: 5 }, (_, i) => `src/net/client.ts:${i}:hit`).join('\n')

  expect(extractPaths(output, dir)).toEqual(['src/net/client.ts'])
})

test('relative imports of a just-read file resolve to real paths', () => {
  const content = "import { a } from './client.ts'\nimport { t } from './config.ts'\n"

  expect(resolveImports(content, 'src/net/index.ts', dir).sort()).toEqual(['src/net/client.ts', 'src/net/config.ts'])
})

test('bare package specifiers are skipped — those live in node_modules', () => {
  const content = "import pkg from 'some-package'\nimport fs from 'node:fs'\n"

  expect(resolveImports(content, 'src/index.ts', dir)).toEqual([])
})

test('an extensionless import resolves through the candidate extensions', () => {
  // './client' with no extension is the common TypeScript style.
  expect(resolveImports("import { a } from './client'", 'src/net/index.ts', dir)).toEqual(['src/net/client.ts'])
})

test('a directory import resolves to its index file', () => {
  expect(resolveImports("import { d } from './deep'", 'src/index.ts', dir)).toEqual(['src/deep/index.ts'])
})

test('an import that resolves to nothing is dropped rather than guessed at', () => {
  expect(resolveImports("import { z } from './does-not-exist.ts'", 'src/index.ts', dir)).toEqual([])
})

test('a parent-relative import resolves correctly', () => {
  expect(resolveImports("import { x } from '../index.ts'", 'src/net/client.ts', dir)).toEqual(['src/index.ts'])
})
