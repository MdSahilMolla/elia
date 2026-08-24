import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadUserConfig, writeUserConfig } from './userConfig.ts'

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'elia-user-config-')), 'config.env')
}

test('loads user config only for environment variables that are not already set', () => {
  const path = tempPath()
  writeFileSync(path, '# comment\nEXPLICIT=from-file\nLOADED=from-file\nQUOTED="hello world"\n')
  const previousExplicit = process.env.EXPLICIT
  const previousLoaded = process.env.LOADED
  const previousQuoted = process.env.QUOTED
  process.env.EXPLICIT = 'from-process'
  delete process.env.LOADED
  delete process.env.QUOTED

  try {
    const result = loadUserConfig(path)
    expect(result.loaded).toEqual(['LOADED', 'QUOTED'])
    expect(process.env.EXPLICIT).toBe('from-process')
    expect(process.env.LOADED as string | undefined).toBe('from-file')
    expect(process.env.QUOTED as string | undefined).toBe('hello world')
  } finally {
    if (previousExplicit === undefined) delete process.env.EXPLICIT
    else process.env.EXPLICIT = previousExplicit
    if (previousLoaded === undefined) delete process.env.LOADED
    else process.env.LOADED = previousLoaded
    if (previousQuoted === undefined) delete process.env.QUOTED
    else process.env.QUOTED = previousQuoted
  }
})

test('writes user config atomically, preserves unrelated lines, and restricts permissions', () => {
  const path = tempPath()
  writeFileSync(path, '# keep this\nELIA_PROVIDER=anthropic\n')
  writeUserConfig({ ELIA_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'test-key', ELIA_MODEL: 'openai/gpt-oss-20b' }, path)

  const content = readFileSync(path, 'utf8')
  expect(content).toContain('# keep this')
  expect(content).toContain('ELIA_PROVIDER=nvidia')
  expect(content).toContain('NVIDIA_API_KEY=test-key')
  expect(content).toContain('ELIA_MODEL=openai/gpt-oss-20b')
  expect(content).not.toContain('ELIA_PROVIDER=anthropic')
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o077).toBe(0)

    // Make the test explicit about the expected mode even on a permissive umask.
    chmodSync(path, 0o600)
    expect(statSync(path).mode & 0o077).toBe(0)
  }
})
