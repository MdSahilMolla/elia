import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedCodeFiles, checkRoot, detectChecks } from './detectChecks.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-checks-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('changedCodeFiles keeps source files, drops the rest', () => {
  expect(changedCodeFiles(['src/a.ts', 'README.md', 'x/b.py', 'style.css', 'c.go'])).toEqual(['src/a.ts', 'x/b.py', 'c.go'])
})

test('npm project: typecheck + test scripts', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  expect(detectChecks(dir)).toEqual(['npm run typecheck', 'npm test'])
})

test('bun project via bun.lock', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'bun test src/' } }))
  writeFileSync(join(dir, 'bun.lock'), '')
  expect(detectChecks(dir)).toEqual(['bun run typecheck', 'bun run test'])
})

test('skips a watch-mode test script', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest --watch' } }))
  writeFileSync(join(dir, 'yarn.lock'), '')
  expect(detectChecks(dir)).toEqual([])
})

test('no check when the project declares only unrelated scripts', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', start: 'node .' } }))
  writeFileSync(join(dir, 'tsconfig.json'), '{}')
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  expect(detectChecks(dir)).toEqual([])
})

test('rust project', () => {
  writeFileSync(join(dir, 'Cargo.toml'), '[package]')
  expect(detectChecks(dir)).toEqual(['cargo check', 'cargo test'])
})

test('python + pytest', () => {
  writeFileSync(join(dir, 'pytest.ini'), '')
  expect(detectChecks(dir)).toEqual(['pytest -q'])
})

test('empty when nothing is inferable', () => {
  expect(detectChecks(dir)).toEqual([])
})

test('checkRoot points at a sub-project when all changes are inside it', () => {
  const app = join(dir, 'workspace', 'my-app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
  writeFileSync(join(dir, 'package.json'), '{}')
  expect(checkRoot([join(app, 'src', 'a.ts'), join(app, 'src', 'b.ts')], dir)).toBe(app)
})

test('checkRoot falls back to the repo root when changes span projects', () => {
  writeFileSync(join(dir, 'package.json'), '{}')
  const app = join(dir, 'workspace', 'x')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), '{}')
  expect(checkRoot([join(app, 'a.ts'), join(dir, 'src', 'b.ts')], dir)).toBe(dir)
})
