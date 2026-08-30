import { expect, test } from 'bun:test'
import { providerActivityText, summarizeResult } from './stream.ts'

test('provider activity preserves useful multiline progress while redacting secrets', () => {
  expect(providerActivityText({
    kind: 'command_output',
    title: 'Command output',
    detail: 'building\nsk-1234567890abcdef\nfinished',
    status: 'updated',
  })).toBe('Command output\nbuilding\n[REDACTED]\nfinished')
})

test('summarizes a successful shell result to status plus its last output line', () => {
  const result = 'exit code: 0\nstdout:\nbun test v1.3.14\n 569 pass\n 0 fail\nRan 569 tests across 81 files. [12.8s]\n'
  expect(summarizeResult('run_command', result)).toBe('exit code: 0 — Ran 569 tests across 81 files. [12.8s]')
})

test('summarizes a shell result with only stderr output', () => {
  const result = 'exit code: 0\nstderr:\n$ tsc --noEmit\n'
  expect(summarizeResult('run_command', result)).toBe('exit code: 0 — $ tsc --noEmit')
})

test('summarizes a shell result with no output at all', () => {
  expect(summarizeResult('run_command', 'exit code: 0')).toBe('exit code: 0')
})

test('summarizes a file listing to a count and a short preview', () => {
  const result = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].join('\n')
  expect(summarizeResult('list_files', result)).toBe('5 files (a.ts, b.ts, c.ts, …)')
})

test('summarizes an empty file listing verbatim', () => {
  expect(summarizeResult('list_files', 'No files matched.')).toBe('No files matched.')
})

test('summarizes grep matches, counting real hits but not ripgrep context lines', () => {
  const result = ['src/a.ts:10:foo()', 'src/a.ts-11-bar()', 'src/b.ts:4:foo()'].join('\n')
  expect(summarizeResult('grep', result)).toBe('2 matches in 2 files')
})

test('summarizes no grep matches verbatim', () => {
  expect(summarizeResult('grep', 'No matches found.')).toBe('No matches found.')
})

test('summarizes a file read to a line count', () => {
  const result = ['1\tfirst', '2\tsecond', '3\tthird'].join('\n')
  expect(summarizeResult('read_file', result)).toBe('3 lines')
})

test('summarizes a windowed file read with a remaining-lines note', () => {
  const result = `1\tfirst\n2\tsecond\n\n[998 more line(s); pass offset 3 to continue]`
  expect(summarizeResult('read_file', result)).toBe('2 lines shown, 998 more')
})

test('passes through unknown tools capped and unredacted otherwise', () => {
  expect(summarizeResult('edit_file', 'Edited src/foo.ts')).toBe('Edited src/foo.ts')
})
