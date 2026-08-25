import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatDiagnostics, diagnosticsForFile, resetLspStateForTests } from './registry.ts'
import type { Diagnostic } from './protocol.ts'

test('formatDiagnostics returns an empty string for a clean file', () => {
  expect(formatDiagnostics([], 'src/foo.ts')).toBe('')
})

test('formatDiagnostics renders severity, line, and column as 1-based', () => {
  const diagnostics: Diagnostic[] = [{ range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } }, severity: 1, message: 'Cannot find name x' }]
  const text = formatDiagnostics(diagnostics, 'src/foo.ts')
  expect(text).toContain('src/foo.ts:5:3 error: Cannot find name x')
})

test('formatDiagnostics sorts errors before warnings and caps the list', () => {
  const many: Diagnostic[] = Array.from({ length: 25 }, (_, i) => ({
    range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
    severity: i === 24 ? 1 : 2,
    message: `issue ${i}`,
  }))
  const text = formatDiagnostics(many, 'src/foo.ts')
  const lines = text.split('\n').filter((l) => l.includes('issue'))
  expect(lines).toHaveLength(20)
  expect(lines[0]).toContain('error: issue 24')
  expect(text).toContain('...and 5 more')
})

test('a file extension with no configured language server returns undefined without spawning anything', async () => {
  const result = await diagnosticsForFile('README.md', '# hello', process.cwd())
  expect(result).toBeUndefined()
})

test('a recognized extension with no server binary installed fails soft instead of hanging or throwing', async () => {
  // gopls is not installed in this environment (verified before writing this
  // test) — a real "the user hasn't set this language server up" case.
  const root = mkdtempSync(join(tmpdir(), 'elia-lsp-registry-'))
  try {
    const result = await diagnosticsForFile(join(root, 'main.go'), 'package main', root)
    expect(result).toBeUndefined()
  } finally {
    resetLspStateForTests()
  }
})

test('ELIA_LSP=off disables diagnostics entirely, even for a recognized extension', async () => {
  const previous = process.env.ELIA_LSP
  process.env.ELIA_LSP = 'off'
  try {
    const result = await diagnosticsForFile('src/index.ts', 'const x = 1', process.cwd())
    expect(result).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.ELIA_LSP
    else process.env.ELIA_LSP = previous
  }
})
