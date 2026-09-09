// A mutex around file-mutating tool execution — in-process and cross-process.
//
// elia runs tools in parallel — within one turn (the fleet) and, increasingly,
// across concurrent turns. Two `edit_file`/`write_file` calls landing on the
// same file at the same instant would interleave reads and writes and corrupt
// it. Reads and commands stay fully parallel; only the actual mutation is
// serialized, and only for as long as the write takes.
//
// The in-process promise chain (`tail`) serializes mutations within one OS
// process. The advisory file lock under `.elia/` extends that to concurrent
// elia processes sharing a worktree (the workspace server plus an agent
// runtime, two `elia auto` invocations). The file lock is best-effort: if it
// cannot be acquired within the timeout it proceeds anyway rather than failing
// a user's edit — a brief unsynchronized window beats a refused write.

import { join } from 'node:path'
import { withFileLockAsync } from './fileLock.ts'

const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'visualize'])

let tail: Promise<unknown> = Promise.resolve()

export function isRepoMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name)
}

function repoLockPath(): string {
  return join(process.cwd(), '.elia', 'repo-mutation.lock')
}

/** Runs `fn` once every earlier repo-lock holder (this process) has finished, and no other elia process holds the cross-process lock. FIFO. */
export function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(
    () => withFileLockAsync(repoLockPath(), fn, { ttlMs: 120_000, timeoutMs: 30_000, proceedOnTimeout: true }),
    () => withFileLockAsync(repoLockPath(), fn, { ttlMs: 120_000, timeoutMs: 30_000, proceedOnTimeout: true }),
  )
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
