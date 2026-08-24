import { appendFileSync, chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

/** Ensure a state directory exists and is not group/world accessible. */
export function ensureSecureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  chmodSync(path, PRIVATE_DIRECTORY_MODE)
}

/** Best-effort repair for state files created by older Elia versions. */
export function hardenSecureFile(path: string): void {
  try {
    if (lstatSync(path).isFile()) chmodSync(path, PRIVATE_FILE_MODE)
  } catch {
    // Missing or concurrently removed state is handled by the caller.
  }
}

/** Atomically write an owner-readable text file. */
export function writeSecureFile(path: string, content: string): void {
  ensureSecureDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(temporary, content, { mode: PRIVATE_FILE_MODE })
  chmodSync(temporary, PRIVATE_FILE_MODE)
  renameSync(temporary, path)
  chmodSync(path, PRIVATE_FILE_MODE)
}

/** Append an owner-readable record, using a restrictive creation mode. */
export function appendSecureFile(path: string, content: string): void {
  ensureSecureDirectory(dirname(path))
  appendFileSync(path, content, { mode: PRIVATE_FILE_MODE })
  chmodSync(path, PRIVATE_FILE_MODE)
}

/** Asynchronously write an owner-readable file using Bun’s byte/text writer. */
export async function writeSecureBunFile(path: string, content: string): Promise<void> {
  ensureSecureDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await Bun.write(temporary, content)
  chmodSync(temporary, PRIVATE_FILE_MODE)
  renameSync(temporary, path)
  chmodSync(path, PRIVATE_FILE_MODE)
}
