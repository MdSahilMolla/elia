import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { lspRefactorTool } from './lspRefactor.ts'
import { resetLspStateForTests } from '../lsp/registry.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-lsp-refactor-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetLspStateForTests()
})

function run(input: Record<string, unknown>) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => lspRefactorTool.execute(input))
}

// `.md` has no configured language server at all (same fixture registry.test.ts
// uses), so every action below hits the "no server" path deterministically,
// with no real LSP process spawned — exactly what an environment with no
// language servers installed sees, matching the honest "say so" contract.

test('rename reports plainly when no language server is configured for the file type', async () => {
  const path = join(dir, 'notes.md')
  writeFileSync(path, '# hello\n')
  const out = await run({ action: 'rename', path, line: 1, column: 1, newName: 'x' })
  expect(out).toContain('No language server is configured/available')
})

test('code_actions reports plainly when no language server is configured', async () => {
  const path = join(dir, 'notes.md')
  writeFileSync(path, '# hello\n')
  const out = await run({ action: 'code_actions', path, line: 1, column: 1 })
  expect(out).toContain('No language server is configured/available')
})

test('apply_code_action reports plainly when no language server is configured, regardless of index', async () => {
  const path = join(dir, 'notes.md')
  writeFileSync(path, '# hello\n')
  const out = await run({ action: 'apply_code_action', path, line: 1, column: 1, index: 1 })
  expect(out).toContain('No language server is configured/available')
})

test('rename requires a non-empty newName before touching anything', async () => {
  const path = join(dir, 'notes.md')
  writeFileSync(path, '# hello\n')
  await expect(run({ action: 'rename', path, line: 1, column: 1, newName: '' })).rejects.toThrow(/newName/)
  await expect(run({ action: 'rename', path, line: 1, column: 1 })).rejects.toThrow(/newName/)
})

test('line and column must be 1-based positive integers', async () => {
  const path = join(dir, 'notes.md')
  writeFileSync(path, '# hello\n')
  await expect(run({ action: 'code_actions', path, line: 0, column: 1 })).rejects.toThrow(/line/)
  await expect(run({ action: 'code_actions', path, line: 1, column: 0 })).rejects.toThrow(/column/)
  await expect(run({ action: 'code_actions', path, line: 1.5, column: 1 })).rejects.toThrow(/line/)
})

test('refuses a path outside the active workspace before doing anything else', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'elia-lsp-outside-'))
  try {
    await expect(run({ action: 'code_actions', path: join(outside, 'x.md'), line: 1, column: 1 })).rejects.toThrow(/escapes the active workspace/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('refuses a sensitive path before doing anything else', async () => {
  const path = join(dir, '.env')
  writeFileSync(path, 'SECRET=1\n')
  await expect(run({ action: 'code_actions', path, line: 1, column: 1 })).rejects.toThrow(/protected path/)
})

test('a nonexistent file rejects rather than silently no-opping', async () => {
  await expect(run({ action: 'code_actions', path: join(dir, 'does-not-exist.md'), line: 1, column: 1 })).rejects.toThrow()
})
