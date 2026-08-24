import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendSecureFile, ensureSecureDirectory, hardenSecureFile, writeSecureBunFile, writeSecureFile } from './securePersistence.ts'

// Windows has no POSIX permission bits: chmod is a no-op there and stat always
// reports 0o666/0o444, so asserting 0o700/0o600 can never pass. The hardening
// call still has to run and still has to produce the file — that part is
// asserted everywhere; only the mode check is Unix-only.
const POSIX_PERMISSIONS = process.platform !== 'win32'

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

    expect(existsSync(nested)).toBe(true)
    expect(await Bun.file(syncPath).text()).toBe('{"ok":true}\n')
    expect(await Bun.file(asyncPath).text()).toBe('{"ok":true}')

    if (POSIX_PERMISSIONS) {
      expect(privateMode(nested)).toBe(0o700)
      expect(privateMode(syncPath)).toBe(0o600)
      expect(privateMode(asyncPath)).toBe(0o600)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hardenSecureFile repairs an older permissive regular file', () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-private-repair-'))
  const path = join(root, 'legacy.json')
  try {
    // Written synchronously: Bun.write returns a promise, and chmodSync on the
    // next line raced it to ENOENT when this was not awaited.
    writeFileSync(path, '{}')
    chmodSync(path, 0o644)
    hardenSecureFile(path)
    expect(existsSync(path)).toBe(true)
    if (POSIX_PERMISSIONS) expect(privateMode(path)).toBe(0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
