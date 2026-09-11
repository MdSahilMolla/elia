import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

/**
 * `renameSync` over an existing file transiently fails on Windows with EPERM /
 * EACCES / EBUSY whenever another handle has the destination open — a reader,
 * an antivirus scanner, an indexer, or a second write racing for the same
 * target. The handle clears in milliseconds, so a short bounded backoff turns
 * those into a successful replace. `src/tools/atomicWrite.ts` does the same for
 * the edit tools; this path had neither the retry nor any cleanup, so a failed
 * rename left its temp file behind permanently. That is where the 52 stale
 * `.elia/tasks.json.tmp-*` files came from, the oldest dating to 2026-08-24.
 */
export function renameSyncWithRetry(from: string, to: string): void {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY'])
  const delaysMs = [10, 25, 50, 100, 200]
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= delaysMs.length || !transient.has(code)) throw error
      Bun.sleepSync(delaysMs[attempt]!)
    }
  }
}

/** Replace `path` with `temporary`, never leaving the temp file behind on failure. */
function commitTemporary(temporary: string, path: string): void {
  try {
    renameSyncWithRetry(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  chmodSync(path, PRIVATE_FILE_MODE)
}

/** Atomically write an owner-readable text file. */
export function writeSecureFile(path: string, content: string): void {
  ensureSecureDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(temporary, content, { mode: PRIVATE_FILE_MODE })
  chmodSync(temporary, PRIVATE_FILE_MODE)
  commitTemporary(temporary, path)
}

/** Append an owner-readable record, using a restrictive creation mode. */
export function appendSecureFile(path: string, content: string): void {
  ensureSecureDirectory(dirname(path))
  appendFileSync(path, content, { mode: PRIVATE_FILE_MODE })
  chmodSync(path, PRIVATE_FILE_MODE)
}

/**
 * Size-cap an append-only log: when `path` exceeds `maxBytes`, shift it to
 * `path.1`, `path.1` to `path.2`, and so on, dropping anything past `keep`
 * generations. A trajectory log that grew without bound would fill the disk on
 * a long-lived project; rotation keeps a bounded recent window while the older
 * generations stay available for a training export until they age out.
 * Best-effort — a rotation that fails leaves the current file in place.
 */
export function rotateSecureFile(path: string, maxBytes: number, keep = 3): void {
  try {
    if (statSync(path).size < maxBytes) return
  } catch {
    return // no file yet, or unreadable — nothing to rotate
  }
  try {
    rmSync(`${path}.${keep}`, { force: true })
    for (let n = keep - 1; n >= 1; n -= 1) {
      try {
        renameSyncWithRetry(`${path}.${n}`, `${path}.${n + 1}`)
      } catch {
        // that generation doesn't exist — skip it
      }
    }
    renameSyncWithRetry(path, `${path}.1`)
  } catch {
    // Leave the current file as-is; the next append still lands.
  }
}

/** Asynchronously write an owner-readable file using Bun’s byte/text writer. */
export async function writeSecureBunFile(path: string, content: string): Promise<void> {
  ensureSecureDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await Bun.write(temporary, content)
  chmodSync(temporary, PRIVATE_FILE_MODE)
  commitTemporary(temporary, path)
}

/**
 * Remove `*.tmp-<pid>-…` files left behind in `directory` by earlier crashes.
 *
 * Only sweeps temps whose owning process is gone, so a concurrent elia writing
 * its own temp right now is never touched. Called once at startup: without it
 * the orphans accumulate silently — this repo had 52 of them, the oldest three
 * weeks old, in a state directory that had grown to 150 MB.
 */
export function sweepStaleTemporaries(directory: string, isAlive: (pid: number) => boolean): number {
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return 0
  }
  for (const name of entries) {
    const match = /\.tmp-(\d+)(?:-|$)/.exec(name)
    const pid = match ? Number.parseInt(match[1]!, 10) : Number.NaN
    if (!Number.isFinite(pid) || pid === process.pid || isAlive(pid)) continue
    try {
      rmSync(join(directory, name), { force: true })
      removed += 1
    } catch {
      // Held open, or removed by another sweep — nothing to do.
    }
  }
  return removed
}
