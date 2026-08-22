import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectMemory } from './memory.ts'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-memory-test-'))
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

test('loadProjectMemory returns undefined when ELIA.md is absent', () => {
  expect(loadProjectMemory(testDir)).toBeUndefined()
})

test('loadProjectMemory reads ELIA.md content when present', () => {
  writeFileSync(join(testDir, 'ELIA.md'), 'Always run tests before committing.\n')
  expect(loadProjectMemory(testDir)).toBe('Always run tests before committing.')
})

test('loadProjectMemory treats a whitespace-only file as absent', () => {
  const blankDir = mkdtempSync(join(tmpdir(), 'elia-memory-blank-'))
  writeFileSync(join(blankDir, 'ELIA.md'), '   \n')
  expect(loadProjectMemory(blankDir)).toBeUndefined()
  rmSync(blankDir, { recursive: true, force: true })
})
