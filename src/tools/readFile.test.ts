import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { hasReadFile, resetFileAccess } from './fileAccess.ts'
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
  expect(await read({ path: small })).toBe('1\ta\n2\tb\n3\tc\n')
})

test('a file ending in a newline does not gain a phantom trailing empty line', async () => {
  const small = join(dir, 'trailing.txt')
  writeFileSync(small, 'one\ntwo\nthree\n')
  const result = await read({ path: small })
  expect(result).toBe('1\tone\n2\ttwo\n3\tthree\n')
  expect(result).not.toMatch(/4\t/)
})

test('a real blank line from "\\n\\n" is preserved, not swallowed', async () => {
  const file = join(dir, 'blanks.txt')
  writeFileSync(file, 'top\n\nbottom\n')
  expect(await read({ path: file })).toBe('1\ttop\n2\t\n3\tbottom\n')
})

test('a file with no trailing newline still reads cleanly', async () => {
  const file = join(dir, 'no-eol.txt')
  writeFileSync(file, 'a\nb')
  expect(await read({ path: file })).toBe('1\ta\n2\tb')
})

test('a failed read never records the file as read', async () => {
  resetFileAccess()
  const giant = join(dir, 'not-readable.log')
  writeFileSync(giant, 'Z'.repeat(6_000_000))
  await expect(read({ path: giant, offset: 9_000_000, limit: 5 })).rejects.toThrow(/past the readable window/)
  expect(hasReadFile(giant)).toBe(false)
  // …but a successful windowed read does count, so write_file keeps its guard.
  await read({ path: bigPath(), offset: 1, limit: 2 })
  expect(hasReadFile(bigPath())).toBe(true)
})

test('the byte ceiling counts UTF-8 bytes, not UTF-16 code units', async () => {
  // 10_000 lines of 200 sun glyphs: 200 UTF-16 code units but 600 bytes per
  // line (6 MB file, over the whole-file limit). A code-unit counter never
  // reaches the 512 KiB window ceiling inside the 2000-line cap; a byte counter
  // hits it at roughly line 874 and must say so.
  const wide = join(dir, 'wide.log')
  writeFileSync(wide, Array.from({ length: 10_000 }, () => '☀'.repeat(200)).join('\n'))
  const result = await read({ path: wide, offset: 1, limit: 2000 })
  expect(result).toContain('[window stopped at ')
  const numbered = result.split('\n').filter((l) => /^\d+\t/.test(l))
  expect(numbered.length).toBeLessThan(2000)
})

test('a single over-ceiling line returns a truncated window instead of "offset past the file"', async () => {
  // One 6 MB line (no trailing newline) overflows the window ceiling instantly.
  // Before the fix the window came back empty and the read claimed the offset
  // was past a file that plainly has content at that offset.
  const giant = join(dir, 'giant.log')
  writeFileSync(giant, 'Z'.repeat(6_000_000))
  const result = await read({ path: giant, offset: 1, limit: 5 })
  expect(result).toContain('[window stopped at ')
  expect(result.startsWith('1\t')).toBe(true)
})
