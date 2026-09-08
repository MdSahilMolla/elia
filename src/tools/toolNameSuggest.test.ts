import { expect, test } from 'bun:test'
import { editDistance, suggestToolName, unknownToolMessage } from './toolNameSuggest.ts'

const TOOLS = ['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'run_command', 'web_search', 'task']

test('editDistance', () => {
  expect(editDistance('', '')).toBe(0)
  expect(editDistance('grep', 'grep')).toBe(0)
  expect(editDistance('cat', 'car')).toBe(1)
  expect(editDistance('kitten', 'sitting')).toBe(3)
})

test('suggestToolName catches a close typo', () => {
  expect(suggestToolName('read_fil', TOOLS)).toBe('read_file')
  expect(suggestToolName('runcommand', TOOLS)).toBe('run_command')
  expect(suggestToolName('websearch', TOOLS)).toBe('web_search')
})

test('suggestToolName catches a substring near-miss', () => {
  expect(suggestToolName('read', TOOLS)).toBe('read_file')
  expect(suggestToolName('search', TOOLS)).toBe('web_search')
})

test('suggestToolName returns undefined for something unrelated', () => {
  expect(suggestToolName('print_tree', TOOLS)).toBeUndefined()
  expect(suggestToolName('xyzzy', TOOLS)).toBeUndefined()
})

test('unknownToolMessage lists the real names and a suggestion when there is one', () => {
  const withHint = unknownToolMessage('list_file', TOOLS)
  expect(withHint).toContain('No tool named "list_file"')
  expect(withHint).toContain('Did you mean "list_files"?')
  expect(withHint).toContain('grep')

  const noHint = unknownToolMessage('print_tree', TOOLS)
  expect(noHint).toContain('No tool named "print_tree"')
  expect(noHint).not.toContain('Did you mean')
  expect(noHint).toContain('list_files')
})
