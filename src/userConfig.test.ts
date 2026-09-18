import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadUserConfig, readUserConfigValues, writeUserConfig } from './userConfig.ts'

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

test('a rename failure cleans up the temp file instead of leaving a just-written secret on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-user-config-'))
  const path = join(dir, 'config.env')
  // Occupy the destination with a directory so the rename can never succeed —
  // exercises the same failure path a transient Windows EPERM/EACCES/EBUSY
  // would, after renameSyncWithRetry exhausts its retries.
  mkdirSync(path)

  expect(() => writeUserConfig({ SECRET_KEY: 'super-secret-value' }, path)).toThrow()

  const leftoverTemps = readdirSync(dir).filter((name) => name.includes('.tmp-'))
  expect(leftoverTemps).toEqual([])
}, 10_000)

test('inline comments on unquoted values are stripped, not baked into the secret', () => {
  const path = tempPath()
  writeFileSync(path, 'PLAIN=abc  # the real value is abc\nSTARTING_HASH=#not-a-comment\nPOUND_NO_SPACE=abc#def\n')
  expect(readUserConfigValues(path)).toMatchObject({
    PLAIN: 'abc',
    STARTING_HASH: '#not-a-comment',
    POUND_NO_SPACE: 'abc#def',
  })
})

test('a comment after a quoted value never reaches the value', () => {
  const path = tempPath()
  writeFileSync(path, 'QUOTED="hello world" # trailing note\nSINGLE=\'my value\' # note\n')
  expect(readUserConfigValues(path)).toEqual({ QUOTED: 'hello world', SINGLE: 'my value' })
})

test('a hash inside quotes is data, not a comment', () => {
  const path = tempPath()
  writeFileSync(path, 'IN_DOUBLE="a # b"\nIN_SINGLE=\'a # b\'\n')
  expect(readUserConfigValues(path)).toEqual({ IN_DOUBLE: 'a # b', IN_SINGLE: 'a # b' })
})

test('an unterminated quote is a malformed value, not a swallowed quote char', () => {
  const path = tempPath()
  writeFileSync(path, 'OPEN="abc definitely\nSINGLE_OPEN=\'xyz definitely\n')
  // These are ambiguous files; the important guarantee is that the opening
  // quote never pollutes the loaded value as a literal character.
  expect(readUserConfigValues(path).OPEN).toBe('abc definitely')
  expect(readUserConfigValues(path).SINGLE_OPEN).toBe('xyz definitely')
})

test('duplicate keys resolve last-wins the same way in both reader and loader', () => {
  const path = tempPath()
  const previous = process.env.DUP_KEY
  delete process.env.DUP_KEY
  writeFileSync(path, 'DUP_KEY=first\nDUP_KEY=last\n')
  try {
    expect(readUserConfigValues(path)).toEqual({ DUP_KEY: 'last' })
    const result = loadUserConfig(path)
    expect(process.env.DUP_KEY as string | undefined).toBe('last')
    expect(result.loaded).toEqual(['DUP_KEY'])
  } finally {
    if (previous === undefined) delete process.env.DUP_KEY
    else process.env.DUP_KEY = previous
  }
})
