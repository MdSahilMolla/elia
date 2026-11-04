import { expect, test } from 'bun:test'
import { CUT_OFF_TEXT_NOTE, createOutputLimitGuard } from './outputLimit.ts'

test('a response ending in a cut-off tool call keeps what came before and drops the call', () => {
  const guard = createOutputLimitGuard()
  const cut = guard.observe([
    { type: 'text', text: 'Writing it now.' },
    { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'x' } },
    { type: 'tool_use', id: 'b', name: 'write_file', input: {} },
  ])
  expect(cut.dropped).toBe('write_file')
  expect(cut.content.map((block) => block.type === 'tool_use' ? block.id : block.type)).toEqual(['text', 'a'])
  expect(cut.note).toContain('partial: true')
})

test('a cut-off answer keeps its text and asks for the rest', () => {
  const cut = createOutputLimitGuard().observe([{ type: 'text', text: 'half' }])
  expect(cut.dropped).toBeUndefined()
  expect(cut.content).toEqual([{ type: 'text', text: 'half' }])
  expect(cut.note).toBe(CUT_OFF_TEXT_NOTE)
})

test('continuations are bounded; after that the call is still dropped but no note is sent', () => {
  const guard = createOutputLimitGuard(1)
  expect(guard.observe([{ type: 'text', text: 'a' }]).note).toBeDefined()
  const spent = guard.observe([{ type: 'tool_use', id: 'c', name: 'grep', input: {} }])
  expect(spent.note).toBeUndefined()
  expect(spent.content).toEqual([])
})
