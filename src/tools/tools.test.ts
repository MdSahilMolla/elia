import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolsByName } from './registry.ts'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-test-'))
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

test('write_file creates a file', async () => {
  const result = await toolsByName.write_file!.execute({
    path: join(testDir, 'hello.txt'),
    content: 'hello from elia',
  })
  expect(result).toContain('hello.txt')
  expect(await Bun.file(join(testDir, 'hello.txt')).text()).toBe('hello from elia')
})

test('write_file rejects a missing path with a clear error instead of a raw Node exception', async () => {
  await expect(toolsByName.write_file!.execute({ content: 'x' })).rejects.toThrow('non-empty "path"')
})

test('write_file rejects a missing content argument', async () => {
  await expect(toolsByName.write_file!.execute({ path: join(testDir, 'no-content.txt') })).rejects.toThrow('"content"')
})

test('read_file returns content with line numbers', async () => {
  const result = await toolsByName.read_file!.execute({ path: join(testDir, 'hello.txt') })
  expect(result).toBe('1\thello from elia')
})

test('read_file throws on missing file', async () => {
  await expect(
    toolsByName.read_file!.execute({ path: join(testDir, 'does-not-exist.txt') }),
  ).rejects.toThrow('File not found')
})

test('edit_file replaces a unique substring', async () => {
  await toolsByName.edit_file!.execute({
    path: join(testDir, 'hello.txt'),
    old_string: 'hello',
    new_string: 'hi',
  })
  expect(await Bun.file(join(testDir, 'hello.txt')).text()).toBe('hi from elia')
})

test('edit_file throws when old_string is not found', async () => {
  await expect(
    toolsByName.edit_file!.execute({
      path: join(testDir, 'hello.txt'),
      old_string: 'nonexistent',
      new_string: 'x',
    }),
  ).rejects.toThrow('not found')
})

test('edit_file rejects a missing old_string with a clear error', async () => {
  await expect(
    toolsByName.edit_file!.execute({ path: join(testDir, 'hello.txt'), new_string: 'x' }),
  ).rejects.toThrow('non-empty "old_string"')
})

test('edit_file rejects a missing new_string with a clear error', async () => {
  await expect(
    toolsByName.edit_file!.execute({ path: join(testDir, 'hello.txt'), old_string: 'hi' }),
  ).rejects.toThrow('"new_string"')
})

test('edit_file throws when old_string is not unique', async () => {
  const dupPath = join(testDir, 'dup.txt')
  await toolsByName.write_file!.execute({ path: dupPath, content: 'foo foo' })
  await expect(
    toolsByName.edit_file!.execute({ path: dupPath, old_string: 'foo', new_string: 'bar' }),
  ).rejects.toThrow('multiple locations')
})

test('list_files finds files matching a glob', async () => {
  const result = await toolsByName.list_files!.execute({ pattern: '*.txt', cwd: testDir })
  expect(result).toContain('hello.txt')
})

test('list_files skips node_modules', async () => {
  mkdirSync(join(testDir, 'node_modules'), { recursive: true })
  writeFileSync(join(testDir, 'node_modules', 'ignored.txt'), 'x')
  const result = await toolsByName.list_files!.execute({ pattern: '**/*.txt', cwd: testDir })
  expect(result).not.toContain('ignored.txt')
})

test('grep finds a matching line', async () => {
  const result = await toolsByName.grep!.execute({ pattern: 'hi from', path: testDir })
  expect(result).toContain('hi from elia')
})

test('grep returns no matches message when nothing found', async () => {
  const result = await toolsByName.grep!.execute({ pattern: 'zzz-not-present-zzz', path: testDir })
  expect(result).toBe('No matches found.')
})

test('run_command captures stdout and exit code', async () => {
  const result = await toolsByName.run_command!.execute({ command: 'echo test123' })
  expect(result).toContain('exit code: 0')
  expect(result).toContain('test123')
})


test('run_command rejects malformed and oversized command inputs', async () => {
  await expect(toolsByName.run_command!.execute({})).rejects.toThrow('non-empty string')
  await expect(toolsByName.run_command!.execute({ command: 42 })).rejects.toThrow('non-empty string')
  await expect(toolsByName.run_command!.execute({ command: 'x'.repeat(100_001) })).rejects.toThrow('exceeds 100000 characters')
})
