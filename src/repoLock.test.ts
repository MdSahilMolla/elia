import { expect, test } from 'bun:test'
import { isRepoMutatingTool, withRepoLock } from './repoLock.ts'

test('classifies the file-mutating tools', () => {
  expect(isRepoMutatingTool('edit_file')).toBe(true)
  expect(isRepoMutatingTool('write_file')).toBe(true)
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
