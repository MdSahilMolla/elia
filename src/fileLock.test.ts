import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
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
