/**
 * A cross-process advisory lock.
 *
 * elia's durable stores (the schedule store, the goal graph, a run journal) are
 * plain files that a `read → modify → write` cycle mutates. Within one process a
 * promise chain or a synchronous section is enough, but two elia processes over
 * the same project — a daemon plus an interactive `elia resume`, two `elia auto`
 * invocations, the workspace server plus a CLI one-shot — are not coordinated by
 * any of that. This lock is the missing piece: an `O_EXCL` lock file whose
 * contents record the owner (pid + a random token) so a *stale* lock can be
 * reclaimed safely and a live one is never stolen, and whose own `release` only
 * removes a lock it still owns.
 *
 * It is deliberately synchronous: the critical sections it guards are short
 * file writes, and a synchronous hold cannot interleave with anything else on
 * this single-threaded runtime.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname as osHostname } from 'node:os'
import { dirname } from 'node:path'
import { ensureSecureDirectory } from './securePersistence.ts'

export interface FileLockOptions {
  /** A held lock older than this (and whose owner process is gone) is reclaimable. Default 60s. */
  ttlMs?: number
  /** How long to keep retrying acquisition before giving up. Default 30s. */
  timeoutMs?: number
  /** Delay between acquisition attempts. Default 25ms. */
  retryDelayMs?: number
  /**
   * When acquisition times out, run `fn` anyway instead of throwing. Use for a
   * best-effort advisory lock where failing the caller's work would be worse
   * than a brief unsynchronized window. Default false.
   */
  proceedOnTimeout?: boolean
}

interface LockOwner {
  pid: number
  token: string
  at: number
  host: string
}

/** Whether a process with this pid is currently running. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Per-path reentrancy: everything here is synchronous, so a simple depth counter
// keyed by lock path lets a method that already holds the lock call another one
// that also takes it without deadlocking on the on-disk lock file.
const heldDepth = new Map<string, number>()

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockOwner>
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string' && typeof parsed.at === 'number') {
      return { pid: parsed.pid, token: parsed.token, at: parsed.at, host: String(parsed.host ?? '') }
    }
  } catch {
    // Missing, torn, or unparseable — treat as no valid owner.
  }
  return undefined
}

function isStale(owner: LockOwner | undefined, ttlMs: number, now: number): boolean {
  if (!owner) return true
  const expired = now - owner.at > ttlMs
  // Only trust pid liveness on the same host that wrote the lock.
  const sameHost = owner.host === hostname()
  if (sameHost && !isProcessAlive(owner.pid)) return true
  // A lock held past a generous grace even by a live process is treated as stale
  // — the holder may be wedged. Same-host gets the full 5× TTL grace since we
  // can also fall back to pid liveness. A cross-host lock can't be liveness-
  // checked at all, so a live-but-slow remote holder looks identical to a dead
  // one from here; a smaller 2× grace balances reclaiming genuinely-dead
  // cross-host locks against not stealing from a holder that is simply slow.
  const graceMultiplier = sameHost ? 5 : 2
  if (expired && now - owner.at > ttlMs * graceMultiplier) return true
  return false
}

let cachedHost: string | undefined
function hostname(): string {
  if (cachedHost === undefined) {
    try {
      cachedHost = osHostname()
    } catch {
      cachedHost = ''
    }
  }
  return cachedHost
}

/**
 * Runs `fn` while holding an exclusive cross-process lock at `lockPath`.
 * Reentrant within a process. Throws `Error('… is busy')` on timeout unless
 * `proceedOnTimeout` is set.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, options: FileLockOptions = {}): T {
  const ttlMs = options.ttlMs ?? 60_000
  const timeoutMs = options.timeoutMs ?? 30_000
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 25)

  const depth = heldDepth.get(lockPath) ?? 0
  if (depth > 0) {
    heldDepth.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      heldDepth.set(lockPath, (heldDepth.get(lockPath) ?? 1) - 1)
    }
  }

  ensureSecureDirectory(dirname(lockPath))
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), at: Date.now(), host: hostname() }
  const serialized = JSON.stringify(owner)
  const deadline = Date.now() + timeoutMs
  let acquired = false

  for (;;) {
    try {
      writeFileSync(lockPath, serialized, { flag: 'wx', mode: 0o600 })
      acquired = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const now = Date.now()
      if (isStale(readOwner(lockPath), ttlMs, now)) {
        // Two reclaimers can race here; `wx` on the next iteration ensures only
        // one wins the re-create and the other retries.
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // Someone else already removed it.
        }
        continue
      }
      if (now >= deadline) {
        if (options.proceedOnTimeout) break
        throw new Error(`${lockPath} is busy; another elia process is holding it`)
      }
      Bun.sleepSync(retryDelayMs)
    }
  }

  heldDepth.set(lockPath, 1)
  try {
    return fn()
  } finally {
    heldDepth.set(lockPath, (heldDepth.get(lockPath) ?? 1) - 1)
    if (acquired) releaseIfOwned(lockPath, owner.token)
  }
}

function releaseIfOwned(lockPath: string, token: string): void {
  // Only remove the lock if it is still ours — never delete a lock a different
  // process reclaimed while we ran (the bug this whole module replaces).
  const current = readOwner(lockPath)
  if (!current || current.token === token) {
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // Already gone.
    }
  }
}

/**
 * The async counterpart of {@link withFileLock}, holding the lock across an
 * awaited `fn`. It does NOT track in-process reentrancy — the caller must ensure
 * only one holder runs at a time within a process (e.g. `repoLock`'s promise
 * chain already does). Cross-process, it behaves identically.
 */
export async function withFileLockAsync<T>(lockPath: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const ttlMs = options.ttlMs ?? 60_000
  const timeoutMs = options.timeoutMs ?? 30_000
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 25)

  ensureSecureDirectory(dirname(lockPath))
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), at: Date.now(), host: hostname() }
  const serialized = JSON.stringify(owner)
  const deadline = Date.now() + timeoutMs
  let acquired = false

  for (;;) {
    try {
      writeFileSync(lockPath, serialized, { flag: 'wx', mode: 0o600 })
      acquired = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const now = Date.now()
      if (isStale(readOwner(lockPath), ttlMs, now)) {
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // Someone else already removed it.
        }
        continue
      }
      if (now >= deadline) {
        if (options.proceedOnTimeout) break
        throw new Error(`${lockPath} is busy; another elia process is holding it`)
      }
      await Bun.sleep(retryDelayMs)
    }
  }

  try {
    return await fn()
  } finally {
    if (acquired) releaseIfOwned(lockPath, owner.token)
  }
}
