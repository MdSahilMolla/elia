import { expect, test } from 'bun:test'
import { rollupLine, rollupTools, summarizeTool } from './toolSummary.ts'
import type { ToolItem } from './store.ts'

const tool = (over: Partial<ToolItem>): ToolItem => ({
  id: 't',
  kind: 'tool',
  name: 'read_file',
  input: {},
  status: 'ok',
  result: '',
  durationMs: 1,
  ...over,
})

test('read_file → "Read <basename>"', () => {
  const s = summarizeTool(tool({ name: 'read_file', input: { path: 'src/ui/app/App.tsx' } }))
  expect(s.verb).toBe('Read')
  expect(s.target).toBe('App.tsx')
})

test('edit_file surfaces the diff stat from a (+N −M) result', () => {
  const s = summarizeTool(
    tool({ name: 'edit_file', input: { path: 'a/b/store.ts' }, result: 'Edited store.ts (+16 −2)\n```diff\n@@\n```' }),
  )
  expect(s.verb).toBe('Edited')
  expect(s.target).toBe('store.ts')
  expect(s.stat).toBe('+16 −2')
})

test('run_command → "Ran <cmd>" truncated', () => {
  const s = summarizeTool(tool({ name: 'run_command', input: { command: 'bun test' } }))
  expect(s.verb).toBe('Ran')
  expect(s.target).toBe('bun test')
})

test('rollupLine summarizes a mixed batch', () => {
  const tools = [
    tool({ name: 'run_command', input: { command: 'x' } }),
    tool({ name: 'edit_file', input: { path: 'a.ts' }, result: 'Edited a.ts (+3 −1)' }),
    tool({ name: 'edit_file', input: { path: 'b.ts' }, result: 'Edited b.ts (+5 −0)' }),
    tool({ name: 'read_file', input: { path: 'c.ts' } }),
  ]
  const line = rollupLine(rollupTools(tools))
  expect(line).toContain('Edited 2 files')
  expect(line).toContain('ran 1 command')
  expect(line).toContain('read 1 file')
  expect(line).toContain('+8 −1')
})

test('visualize surfaces the chart title', () => {
  const s = summarizeTool(tool({ name: 'visualize', input: { type: 'bar', title: 'Quarterly revenue' } }))
  expect(s.verb).toBe('Visualized')
  expect(s.target).toBe('Quarterly revenue')
  expect(s.expandable).toBe(true)
})
