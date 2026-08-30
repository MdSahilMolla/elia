import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Write a file so a reader (or a crash) never sees a half-written version.
 *
 * `Bun.write` and `fs.writeFile` truncate the target and then stream bytes into
 * it — kill the process, run out of disk, or hit a concurrent read at the wrong
 * moment and the file is left corrupt or empty. That is the single worst thing a
 * coding agent can do to a repo, and `edit_file` / `write_file` are the tools
 * most exposed to it (a slow LSP pass or a cancellation can land mid-write).
 *
 * This writes the new content to a sibling temp file in the same directory, then
 * `rename`s it over the target. `rename` within one filesystem is atomic on
 * every platform elia runs on, so the target is only ever the complete old file
 * or the complete new one. A failure before the rename leaves the target
 * untouched and the temp file is cleaned up.
 *
 * It is not a full durability fsync (a power cut right after the rename can still
 * lose the write on some filesystems) — the goal here is integrity, not
 * durability: never a torn file.
 */
export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })

  // Preserve the existing file's permission bits — creating a fresh temp file
  // would otherwise silently reset a 0755 script or a group-writable file to the
  // process umask default on the rename.
  let mode: number | undefined
  try {
    mode = (await stat(path)).mode & 0o777
  } catch {
    // New file — no mode to preserve.
  }

  const tmp = join(dir, `.${basename(path)}.elia-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`)

  try {
    await writeFile(tmp, content)
    if (mode !== undefined) await chmod(tmp, mode)
    await renameWithRetry(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/**
 * On Windows, `rename` over an existing file transiently fails with EPERM /
 * EACCES / EBUSY when another handle has the destination open — a concurrent
 * reader, an antivirus scanner, a search indexer, or another atomic write
 * racing for the same target. The file is not actually locked; the handle
 * clears in milliseconds. A short bounded backoff turns those transients into a
 * successful replace instead of a spurious "edit failed". POSIX renames are
 * atomic and never hit this path.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY'])
  const delaysMs = [10, 25, 50, 100, 200]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= delaysMs.length || !transient.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]))
    }
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || 'file'
}
