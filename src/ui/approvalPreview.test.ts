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

test('process start preview shows the command it will keep running', () => {
  expect(approvalPreviewLines('process', { action: 'start', command: 'npm run dev', cwd: 'web' })).toEqual(['  $ npm run dev', '  in web'])
  expect(approvalPreviewLines('process', { action: 'logs', id: 'proc_1' })).toBeUndefined()
})

test('run_program preview preserves each literal argument', () => {
  expect(approvalPreviewLines('run_program', { program: 'bun', args: ['install', 'folder with spaces'], cwd: 'app' }))
    .toEqual(['  $ bun "install" "folder with spaces"', '  in app'])
})

test('tools without a meaningful preview return undefined', () => {
  expect(approvalPreviewLines('browser', { action: 'navigate' })).toBeUndefined()
  expect(approvalPreviewLines('edit_file', {})).toBeUndefined()
  expect(approvalPreviewLines('run_command', {})).toBeUndefined()
})

test('communication send preview shows channel, recipients, subject, attachments and a redacted body excerpt', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { paths } = await import('../config.ts')
  const dir = join(paths.state, 'communications')
  mkdirSync(dir, { recursive: true })
  const id = 'draft-preview-1'
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id, channel: 'email', recipient: 'a@example.com', cc: ['b@example.com'], bcc: ['c@example.com'],
    subject: 'Quarterly numbers', attachments: ['report.pdf'], body: 'Hi\nuse https://u:pw123@host.example/x today',
  }))
  const lines = approvalPreviewLines('communication', { action: 'send', draftId: id })!
  const text = lines.join('\n')
  expect(text).toContain('to: a@example.com')
  expect(text).toContain('cc: b@example.com')
  expect(text).toContain('bcc: c@example.com')
  expect(text).toContain('subject: Quarterly numbers')
  expect(text).toContain('attachments: report.pdf')
  expect(text).toContain('body: Hi use')
  expect(text).not.toContain('pw123')
  expect(approvalPreviewLines('communication', { action: 'send', draftId: '../../etc/passwd' })).toBeUndefined()
  expect(approvalPreviewLines('communication', { action: 'send', draftId: 'missing-draft-id' })).toEqual(['  (draft not found — nothing to preview)'])
})
