import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { readFileTool } from './readFile.ts'

let dir: string
const bigPath = () => join(dir, 'big.log')

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-readfile-'))
  // ~8 MB: 200k lines of ~40 bytes, well over the 5 MB whole-file limit.
  const lines: string[] = []
  for (let i = 1; i <= 200_000; i++) lines.push(`line ${i} ${'x'.repeat(28)}`)
  writeFileSync(bigPath(), lines.join('\n'))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function read(input: Record<string, unknown>) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => readFileTool.execute(input))
}

test('a bare read of an over-limit file is refused, naming the offset/limit escape hatch', async () => {
  await expect(read({ path: bigPath() })).rejects.toThrow(/pass both offset and limit/)
})

test('an offset+limit read of an over-limit file returns exactly that line window', async () => {
  const result = await read({ path: bigPath(), offset: 100_000, limit: 3 })
  expect(result).toContain('100000\tline 100000')
  expect(result).toContain('100001\tline 100001')
  expect(result).toContain('100002\tline 100002')
  expect(result).not.toContain('100003\tline 100003')
  expect(result).toContain('windowed read')
})

test('the window is clamped to the line ceiling', async () => {
  const result = await read({ path: bigPath(), offset: 1, limit: 10_000 })
  const numbered = result.split('\n').filter((l) => /^\d+\t/.test(l))
  expect(numbered.length).toBeLessThanOrEqual(2000)
})

test('an offset past the readable window throws', async () => {
  await expect(read({ path: bigPath(), offset: 5_000_000, limit: 5 })).rejects.toThrow(/past the readable window/)
})

test('small files are unaffected by the windowing path', async () => {
  const small = join(dir, 'small.txt')
  writeFileSync(small, 'a\nb\nc\n')
  expect(await read({ path: small })).toBe('1\ta\n2\tb\n3\tc\n4\t')
})
