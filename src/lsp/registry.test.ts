import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatDiagnostics, diagnosticsForFile, neutralNpxLaunch, resetLspStateForTests, resolveSpawnCommand } from './registry.ts'
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

test('resolveSpawnCommand prefers the direct binary when it is on PATH, ignoring any npx fallback', () => {
  // "node" ships with every environment this runs in; picking a real,
  // reliably-present binary avoids the flakiness of asserting on a
  // language-server binary that may or may not be installed.
  const resolved = resolveSpawnCommand({ languageId: 'x', command: 'node', args: ['--version'], npxArgs: ['-y', 'some-package', '--stdio'] }, true)
  expect(resolved).toEqual({ command: 'node', args: ['--version'] })
})

test('resolveSpawnCommand falls back to npx only when explicitly allowed, and the direct binary is missing, and an npx fallback is configured', () => {
  const spec = { languageId: 'x', command: 'elia-definitely-not-a-real-lsp-binary-xyz', args: ['--stdio'], npxArgs: ['-y', 'some-package', '--stdio'] }
  // npx itself is expected to be present in this environment (it ships with npm).
  expect(resolveSpawnCommand(spec, true)).toEqual({ command: 'npx', args: ['-y', 'some-package', '--stdio'] })
  // Not allowed (diagnosticsForFile's hot path): falls straight through to the original, missing command.
  expect(resolveSpawnCommand(spec, false)).toEqual({ command: 'elia-definitely-not-a-real-lsp-binary-xyz', args: ['--stdio'] })
})

test('resolveSpawnCommand keeps the original command when the binary is missing and there is no npx fallback configured', () => {
  const resolved = resolveSpawnCommand({ languageId: 'x', command: 'elia-definitely-not-a-real-lsp-binary-xyz', args: ['--stdio'] }, true)
  expect(resolved).toEqual({ command: 'elia-definitely-not-a-real-lsp-binary-xyz', args: ['--stdio'] })
})

test('diagnosticsForFile fails soft and fast for a .ts file with no typescript-language-server installed, even though npx is available and configured as a fallback for rename/code-action use', async () => {
  // typescript-language-server is not installed in this environment (verified
  // before writing this test), and npx IS installed — the exact conditions
  // that once made every .ts/.js edit attempt a slow npx cold-start of
  // typescript-language-server via the shared getClient cache. Regression
  // test for that: this must stay on the default bun:test timeout, not hang
  // on a real network fetch.
  const root = mkdtempSync(join(tmpdir(), 'elia-lsp-registry-ts-'))
  try {
    const result = await diagnosticsForFile(join(root, 'main.ts'), 'const x = 1', root)
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

test('the npx fallback launches from an empty temp directory with elia credentials removed', () => {
  const launch = neutralNpxLaunch({ PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'dummy-a', OPENAI_API_KEY: 'dummy-o', ELIA_API_KEY: 'dummy-e', GITHUB_TOKEN: 'dummy-g' })
  try {
    expect(existsSync(launch.cwd)).toBe(true)
    expect(readdirSync(launch.cwd)).toEqual([])
    expect(launch.cwd).not.toBe(process.cwd())
    expect(launch.env.PATH).toBe('/usr/bin')
    expect(launch.env.HOME).toBe('/h')
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELIA_API_KEY', 'GITHUB_TOKEN']) expect(launch.env[name]).toBeUndefined()
  } finally {
    rmSync(launch.cwd, { recursive: true, force: true })
  }
})
