import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isProcessAlive, withFileLock, withFileLockAsync } from './fileLock.ts'

function lockDir(): string {
  return mkdtempSync(join(tmpdir(), 'elia-filelock-'))
}

describe('fileLock', () => {
  test('runs the critical section and removes the lock afterwards', () => {
    const lock = join(lockDir(), 'a.lock')
    const result = withFileLock(lock, () => 42)
    expect(result).toBe(42)
    expect(existsSync(lock)).toBe(false)
  })

  test('is reentrant within a process', () => {
    const lock = join(lockDir(), 'b.lock')
    const result = withFileLock(lock, () => withFileLock(lock, () => 'inner'))
    expect(result).toBe('inner')
    expect(existsSync(lock)).toBe(false)
  })

  test('reclaims a lock whose owner process is gone', () => {
    const lock = join(lockDir(), 'c.lock')
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22, token: 'dead', at: Date.now(), host: hostname() }))
    let ran = false
    withFileLock(lock, () => { ran = true }, { timeoutMs: 500 })
    expect(ran).toBe(true)
  })

  test('does not steal a lock held by a live process, and never deletes a lock it does not own', () => {
    const lock = join(lockDir(), 'd.lock')
    const foreign = JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now(), host: hostname() })
    writeFileSync(lock, foreign)

    expect(() => withFileLock(lock, () => 'nope', { timeoutMs: 60, retryDelayMs: 10 })).toThrow('is busy')

    let ran = false
    withFileLock(lock, () => { ran = true }, { timeoutMs: 60, retryDelayMs: 10, proceedOnTimeout: true })
    expect(ran).toBe(true)
    // The foreign lock is still intact — we proceeded without acquiring it.
    expect(readFileSync(lock, 'utf8')).toBe(foreign)
  })

  test('a just-created lock whose owner record is not written yet is held, not reclaimed as stale', () => {
    // `wx` creates the file an instant before its JSON lands; a contender that
    // read it in that window used to call it stale and delete a live lock.
    const lock = join(lockDir(), 'empty.lock')
    writeFileSync(lock, '')
    expect(() => withFileLock(lock, () => 'nope', { timeoutMs: 60, retryDelayMs: 10 })).toThrow('is busy')
    expect(existsSync(lock)).toBe(true)
  })

  test('an unreadable lock that has sat untouched past the TTL is reclaimed', () => {
    const lock = join(lockDir(), 'old-empty.lock')
    writeFileSync(lock, '')
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)
    let ran = false
    withFileLock(lock, () => { ran = true }, { ttlMs: 60_000, timeoutMs: 500 })
    expect(ran).toBe(true)
  })

  test('parallel processes contending for one lock all get in, one at a time', async () => {
    const dir = lockDir()
    const lock = join(dir, 'shared.lock')
    const counter = join(dir, 'counter.txt')
    writeFileSync(counter, '0')
    const script = join(dir, 'worker.ts')
    const lockModule = pathToFileURL(join(import.meta.dir, 'fileLock.ts')).href
    // A read-modify-write that loses increments unless the lock truly excludes.
    writeFileSync(script, [
      `import { readFileSync, writeFileSync } from 'node:fs'`,
      `const { withFileLock } = await import(${JSON.stringify(lockModule)})`,
      `for (let i = 0; i < 25; i++) withFileLock(${JSON.stringify(lock)}, () => writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1)), { timeoutMs: 20_000 })`,
    ].join('\n'))
    const workers = [1, 2, 3, 4].map(() => Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' }))
    const exits = await Promise.all(workers.map((worker) => worker.exited))
    expect(exits).toEqual([0, 0, 0, 0])
    expect(readFileSync(counter, 'utf8')).toBe('100')
  }, 60_000)

  test('calls onProceedWithoutLock exactly when it proceeds unlocked, and not on the normal path', () => {
    const held = join(lockDir(), 'g.lock')
    writeFileSync(held, JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now(), host: hostname() }))

    let notified = 0
    withFileLock(held, () => 'ran', { timeoutMs: 60, retryDelayMs: 10, proceedOnTimeout: true, onProceedWithoutLock: () => { notified += 1 } })
    expect(notified).toBe(1)

    const free = join(lockDir(), 'h.lock')
    let notifiedOnSuccess = 0
    withFileLock(free, () => 'ran', { proceedOnTimeout: true, onProceedWithoutLock: () => { notifiedOnSuccess += 1 } })
    expect(notifiedOnSuccess).toBe(0)
  })

  test('gives a cross-host lock a grace period before reclaiming it, but reclaims it once that grace elapses', () => {
    const lock = join(lockDir(), 'f.lock')
    // A cross-host lock is stealable past 2× its TTL. At a 50ms TTL that
    // boundary was 100ms, and the "not yet stealable" check below sat at 55ms
    // and then retried for 30ms — about 15ms of margin, so any scheduler stall
    // that long on a loaded machine pushed the lock past the grace and the
    // assertion failed. The ages here are back-dated timestamps, not real waits,
    // so a 1s TTL costs no runtime and leaves ~950ms of margin either way.
    const ttlMs = 1_000
    const foreignHost = `${hostname()}-remote`
    const writeForeignOwner = (ageMs: number) =>
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'remote-owner', at: Date.now() - ageMs, host: foreignHost }))

    // Just past the base TTL but still within the cross-host grace: not yet stealable.
    writeForeignOwner(ttlMs + 5)
    expect(() => withFileLock(lock, () => 'nope', { ttlMs, timeoutMs: 30, retryDelayMs: 10 })).toThrow('is busy')

    // Well past the cross-host grace: stealable.
    writeForeignOwner(ttlMs * 3)
    let ran = false
    withFileLock(lock, () => { ran = true }, { ttlMs, timeoutMs: 500, retryDelayMs: 10 })
    expect(ran).toBe(true)
  })

  test('async variant holds across awaits', async () => {
    const lock = join(lockDir(), 'e.lock')
    const order: string[] = []
    const a = withFileLockAsync(lock, async () => { order.push('a-start'); await Bun.sleep(20); order.push('a-end') })
    const b = withFileLockAsync(lock, async () => { order.push('b-start'); order.push('b-end') }, { retryDelayMs: 5 })
    await Promise.all([a, b])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
    expect(existsSync(lock)).toBe(false)
  })

  test('isProcessAlive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(2 ** 22)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
  })
})
