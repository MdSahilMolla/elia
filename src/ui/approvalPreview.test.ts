import { expect, test } from 'bun:test'
import { approvalPreviewLines } from './approvalPreview.ts'

test('edit_file preview shows the path and the old -> new lines as a diff', () => {
  const lines = approvalPreviewLines('edit_file', { path: 'src/a.ts', old_string: 'const x = 1\nreturn x', new_string: 'const x = 2\nreturn x * 2' })
  expect(lines).toEqual([
    '  src/a.ts',
    '- const x = 1',
    '- return x',
    '+ const x = 2',
    '+ return x * 2',
  ])
})

test('edit_file preview notes replace_all', () => {
  const lines = approvalPreviewLines('edit_file', { path: 'a.ts', old_string: 'old', new_string: 'new', replace_all: true })
  expect(lines).toContain('  (every occurrence)')
})

test('write_file preview shows the line count and the first lines as additions', () => {
  const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const lines = approvalPreviewLines('write_file', { path: 'b.ts', content })!
  expect(lines[0]).toBe('  b.ts  (40 lines)')
  expect(lines[1]).toBe('+ line 0')
  expect(lines).toHaveLength(31) // header + first 30 lines
})

test('run_command preview shows the exact command and cwd', () => {
  expect(approvalPreviewLines('run_command', { command: 'npm test', cwd: 'app' })).toEqual(['  $ npm test', '  in app'])
  expect(approvalPreviewLines('run_command', { command: 'ls' })).toEqual(['  $ ls'])
})

test('tools without a meaningful preview return undefined', () => {
  expect(approvalPreviewLines('browser', { action: 'navigate' })).toBeUndefined()
  expect(approvalPreviewLines('edit_file', {})).toBeUndefined()
  expect(approvalPreviewLines('run_command', {})).toBeUndefined()
})
