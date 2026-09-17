import { expect, test } from 'bun:test'
import { rollupLine, rollupTools, shellExitStat, summarizeTool } from './toolSummary.ts'
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

test('read_file with a window shows the line range', () => {
  expect(summarizeTool(tool({ name: 'read_file', input: { path: 'a/engine.ts', offset: 1, limit: 50 } })).target).toBe('engine.ts:1-50')
  expect(summarizeTool(tool({ name: 'read_file', input: { path: 'a/engine.ts', offset: 200, limit: 50 } })).target).toBe('engine.ts:200-249')
})

test('edit_file surfaces the diff stat from a (+N −M) result', () => {
  const s = summarizeTool(
    tool({ name: 'edit_file', input: { path: 'a/b/store.ts' }, result: 'Edited store.ts (+16 −2)\n```diff\n@@\n```' }),
  )
  expect(s.verb).toBe('Edited')
  expect(s.target).toBe('a/b/store.ts')
  expect(s.stat).toBe('+16 −2')
})

test('run_command → "Ran <cmd>" truncated', () => {
  const s = summarizeTool(tool({ name: 'run_command', input: { command: 'bun test' } }))
  expect(s.verb).toBe('Ran')
  expect(s.target).toBe('bun test')
})

test('run_command surfaces the exit code as its stat', () => {
  expect(summarizeTool(tool({ name: 'run_command', input: { command: 'x' }, result: 'exit code: 0\nstdout:\nok' })).stat).toBe('exit 0')
  expect(summarizeTool(tool({ name: 'run_command', input: { command: 'x' }, result: 'exit code: 1\nstderr:\nboom' })).stat).toBe('exit 1')
  expect(summarizeTool(tool({ name: 'run_command', input: { command: 'x' }, result: 'timed out after 5000ms (killed)' })).stat).toBe('timed out')
})

test('shellExitStat ignores a running command with no result yet', () => {
  expect(shellExitStat(undefined)).toBe('')
  expect(shellExitStat('some other tool output')).toBe('')
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

test('rollupTools counts files, not calls, and a failed call changed nothing', () => {
  const tools = [
    tool({ id: 'e1', name: 'edit_file', input: { path: 'src/stats.ts' }, result: 'Edited (+1 −1)' }),
    tool({ id: 'e2', name: 'edit_file', input: { path: 'src/stats.ts' }, result: 'Edited (+1 −1)' }),
    tool({ id: 'e3', name: 'edit_file', input: { path: 'src/other.ts' }, status: 'error', result: 'old_string not found' }),
    tool({ id: 'w1', name: 'write_file', input: { path: 'notes.md' }, result: 'Wrote notes.md' }),
    tool({ id: 'e4', name: 'edit_file', input: { path: 'notes.md' }, result: 'Edited (+2 −0)' }),
    tool({ id: 'r1', name: 'read_file', input: { path: 'src/stats.ts' } }),
    tool({ id: 'r2', name: 'read_file', input: { path: 'src/stats.ts', offset: 5, limit: 10 } }),
  ]
  const rollup = rollupTools(tools)
  expect(rollup.edited).toBe(1)
  expect(rollup.created).toBe(1)
  expect(rollup.read).toBe(1)
  expect(rollupLine(rollup)).toContain('Edited 1 file, created 1 file')
})

test('visualize surfaces the chart title', () => {
  const s = summarizeTool(tool({ name: 'visualize', input: { type: 'bar', title: 'Quarterly revenue' } }))
  expect(s.verb).toBe('Visualized')
  expect(s.target).toBe('Quarterly revenue')
  expect(s.expandable).toBe(true)
})
