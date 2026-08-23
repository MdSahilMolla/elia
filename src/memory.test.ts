import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectInstructions, loadProjectMemory } from './memory.ts'

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

test('loadProjectInstructions prefers AGENTS.override.md and bounds content', () => {
  const instructionDir = mkdtempSync(join(tmpdir(), 'elia-instructions-'))
  writeFileSync(join(instructionDir, 'AGENTS.md'), 'base')
  writeFileSync(join(instructionDir, 'AGENTS.override.md'), `override${'x'.repeat(25_000)}`)
  const instructions = loadProjectInstructions(instructionDir)
  expect(instructions?.startsWith('overridex')).toBe(true)
  expect(instructions?.length).toBe(20_000)
  rmSync(instructionDir, { recursive: true, force: true })
})

test('loadProjectInstructions treats whitespace-only files as absent', () => {
  const instructionDir = mkdtempSync(join(tmpdir(), 'elia-instructions-blank-'))
  writeFileSync(join(instructionDir, 'AGENTS.md'), '   \n')
  expect(loadProjectInstructions(instructionDir)).toBeUndefined()
  rmSync(instructionDir, { recursive: true, force: true })
})

test('loadProjectMemory treats a whitespace-only file as absent', () => {
  const blankDir = mkdtempSync(join(tmpdir(), 'elia-memory-blank-'))
  writeFileSync(join(blankDir, 'ELIA.md'), '   \n')
  expect(loadProjectMemory(blankDir)).toBeUndefined()
  rmSync(blankDir, { recursive: true, force: true })
})
