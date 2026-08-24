import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendSecureFile, ensureSecureDirectory, hardenSecureFile, writeSecureBunFile, writeSecureFile } from './securePersistence.ts'

function privateMode(path: string): number {
  return statSync(path).mode & 0o777
}

test('secure persistence enforces private directories and atomic files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-private-state-'))
  try {
    const nested = join(root, 'nested')
    const syncPath = join(nested, 'sync.json')
    const asyncPath = join(nested, 'async.json')
    ensureSecureDirectory(nested)
    writeSecureFile(syncPath, '{"ok":true}')
    appendSecureFile(syncPath, '\n')
    await writeSecureBunFile(asyncPath, '{"ok":true}')

    expect(privateMode(nested)).toBe(0o700)
    expect(privateMode(syncPath)).toBe(0o600)
    expect(privateMode(asyncPath)).toBe(0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hardenSecureFile repairs an older permissive regular file', () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-private-repair-'))
  const path = join(root, 'legacy.json')
  try {
    Bun.write(path, '{}')
    chmodSync(path, 0o644)
    hardenSecureFile(path)
    expect(privateMode(path)).toBe(0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
