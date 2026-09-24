import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { isRepoMutatingTool, withRepoLock } from './repoLock.ts'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-local-tests'

// The repo lock lives at `<cwd>/.elia/repo-mutation.lock`, so redirecting it to
// an isolated temp dir means changing the process cwd for the duration of a
// test. Tests in this file run serially, so the restore in `finally` keeps the
// module-level `tail` and the on-disk lock well-behaved.
function repoLockPath(): string {
  return join(process.cwd(), '.elia', 'repo-mutation.lock')
}

async function withTempCwd(run: () => Promise<void>): Promise<void> {
  const original = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'elia-repolock-'))
  process.chdir(dir)
  try {
    await run()
  } finally {
    process.chdir(original)
    rmSync(dir, { recursive: true, force: true })
  }
}

function seedLockFile(content: string, mtime?: Date): void {
  mkdirSync(join(process.cwd(), '.elia'), { recursive: true })
  writeFileSync(repoLockPath(), content)
  if (mtime) utimesSync(repoLockPath(), mtime, mtime)
}

function deadOwnerLock(): string {
  // pid 2**22 is not a live process on any supported host; same-host dead
  // owners are reclaimable even when the record is freshly written.
  return JSON.stringify({ pid: 2 ** 22, token: 'dead-owner', at: Date.now(), host: hostname() })
}

test('classifies the file-mutating tools', () => {
  expect(isRepoMutatingTool('edit_file')).toBe(true)
  expect(isRepoMutatingTool('write_file')).toBe(true)
  expect(isRepoMutatingTool('visualize')).toBe(true)
  expect(isRepoMutatingTool('read_file')).toBe(false)
  expect(isRepoMutatingTool('run_command')).toBe(false)
})

test('serializes overlapping critical sections in FIFO order', async () => {
  const order: string[] = []
  const slow = (tag: string, ms: number) =>
    withRepoLock(async () => {
      order.push(`${tag}:start`)
      await Bun.sleep(ms)
      order.push(`${tag}:end`)
    })
  await Promise.all([slow('a', 30), slow('b', 5), slow('c', 5)])
  expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
})

test('a throwing section does not wedge the lock', async () => {
  await expect(withRepoLock(async () => { throw new Error('boom') })).rejects.toThrow('boom')
  const ok = await withRepoLock(async () => 'recovered')
  expect(ok).toBe('recovered')
})

test('reclaims a repo lock left by a dead owner, replacing it with its own owner record', async () => {
  await withTempCwd(async () => {
    seedLockFile(deadOwnerLock())
    let sawOwnedRecord = false
    await withRepoLock(async () => {
      const lock = repoLockPath()
      expect(existsSync(lock)).toBe(true)
      const owner = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; token: string; host: string }
      expect(owner.pid).toBe(process.pid)
      expect(owner.host).toBe(hostname())
      expect(typeof owner.token).toBe('string')
      sawOwnedRecord = true
    })
    expect(sawOwnedRecord).toBe(true)
    expect(existsSync(repoLockPath())).toBe(false)
  })
})

test('does not steal a lock held by a live foreign owner, and only acquires once the owner releases', async () => {
  await withTempCwd(async () => {
    const lock = repoLockPath()
    const foreign = JSON.stringify({ pid: process.pid, token: 'foreign-live', at: Date.now(), host: hostname() })
    seedLockFile(foreign)
    let acquired: string | undefined
    const waiter = withRepoLock(async () => 'acquired')
    try {
      await Bun.sleep(100)
      expect(readFileSync(lock, 'utf8')).toBe(foreign)
    } finally {
      rmSync(lock, { force: true })
      acquired = await waiter
    }
    expect(acquired).toBe('acquired')
    expect(existsSync(lock)).toBe(false)
  })
})

test('treats a fresh unreadable lock file as held rather than reclaiming it as stale', async () => {
  await withTempCwd(async () => {
    const lock = repoLockPath()
    const corrupted = 'torn-owner-record{'
    seedLockFile(corrupted)
    let acquired: string | undefined
    const waiter = withRepoLock(async () => 'acquired')
    try {
      await Bun.sleep(100)
      expect(readFileSync(lock, 'utf8')).toBe(corrupted)
    } finally {
      rmSync(lock, { force: true })
      acquired = await waiter
    }
    expect(acquired).toBe('acquired')
    expect(existsSync(lock)).toBe(false)
  })
})

test('reclaims a corrupted lock file that has sat untouched past the TTL', async () => {
  await withTempCwd(async () => {
    seedLockFile('torn-owner-record{', new Date(Date.now() - 130_000))
    let ran = false
    await withRepoLock(async () => { ran = true })
    expect(ran).toBe(true)
    expect(existsSync(repoLockPath())).toBe(false)
  })
})
