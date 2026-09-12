import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { findSymbolTool } from './findSymbol.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-find-symbol-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(input: Record<string, unknown>) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => findSymbolTool.execute(input))
}

test('finds definitions across multiple files and languages under a directory', async () => {
  writeFileSync(join(dir, 'a.ts'), 'export function alpha() {}\n')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'b.py'), 'def beta():\n    pass\n')
  const out = await run({})
  expect(out).toContain('alpha')
  expect(out).toContain('function_declaration')
  expect(out).toContain('beta')
  expect(out).toContain('function_definition')
})

test('name filters case-insensitively and by substring', async () => {
  writeFileSync(join(dir, 'a.ts'), 'export function fetchUser() {}\nexport function deleteUser() {}\nexport function ping() {}\n')
  const out = await run({ name: 'USER' })
  expect(out).toContain('fetchUser')
  expect(out).toContain('deleteUser')
  expect(out).not.toContain('ping')
})

test('reports plainly when nothing matches, distinguishing "no supported files" from "no matching symbol"', async () => {
  writeFileSync(join(dir, 'notes.md'), '# just docs\n')
  const noneSupported = await run({})
  expect(noneSupported).toContain('No source files with a supported grammar')

  writeFileSync(join(dir, 'a.ts'), 'export function alpha() {}\n')
  const noMatch = await run({ name: 'zzz-does-not-exist-zzz' })
  expect(noMatch).toContain('No matching symbol definitions found')
})

test('glob restricts which files are scanned', async () => {
  writeFileSync(join(dir, 'a.ts'), 'export function alpha() {}\n')
  writeFileSync(join(dir, 'b.py'), 'def beta():\n    pass\n')
  const out = await run({ glob: '*.ts' })
  expect(out).toContain('alpha')
  expect(out).not.toContain('beta')
})

test('skips a file that fails to parse instead of failing the whole search', async () => {
  writeFileSync(join(dir, 'broken.ts'), 'function foo( { not valid [[[')
  writeFileSync(join(dir, 'good.ts'), 'export function alpha() {}\n')
  const out = await run({})
  expect(out).toContain('alpha')
})

test('refuses a sensitive path and a path outside the workspace, matching grep/list_files', async () => {
  writeFileSync(join(dir, '.env'), 'SECRET=1\n')
  await expect(run({ path: '.env' })).rejects.toThrow(/protected/)

  const outside = mkdtempSync(join(tmpdir(), 'elia-find-symbol-outside-'))
  try {
    await expect(run({ path: outside })).rejects.toThrow(/escapes the active workspace/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('validates name and glob input before scanning anything', async () => {
  await expect(run({ name: '' })).rejects.toThrow(/name must be/)
  await expect(run({ glob: '' })).rejects.toThrow(/glob must be/)
})
