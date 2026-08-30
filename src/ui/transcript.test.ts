import { expect, test } from 'bun:test'
import { createTranscript } from './transcript.ts'
import type { ToolEvent } from '../agentLoop.ts'

function toolEvent(over: Partial<ToolEvent> = {}): ToolEvent {
  return { name: 'grep', input: { pattern: 'foo' }, result: 'a\nb\nc', isError: false, durationMs: 12, cached: false, ...over }
}

test('records turns, tools, and assistant replies in order', () => {
  const t = createTranscript()
  t.appendUser('find foo')
  t.recordTool(toolEvent())
  t.appendAssistant('found it')
  t.endTurn()
  expect(t.turns()).toBe(1)
  expect(t.items().map((i) => i.kind)).toEqual(['user', 'tool', 'assistant'])
  expect(t.tool()?.name).toBe('grep')
  expect(t.toolCount()).toBe(1)
})

test('tool(n) indexes tool items and skips non-tool items', () => {
  const t = createTranscript()
  t.recordTool(toolEvent({ name: 'read_file' }))
  t.notice('hello')
  t.recordTool(toolEvent({ name: 'edit_file', isError: true }))
  expect(t.tool(0)?.name).toBe('read_file')
  expect(t.tool(1)?.name).toBe('edit_file')
  expect(t.tool(1)?.status).toBe('error')
  expect(t.tool()?.name).toBe('edit_file')
})

test('drops empty assistant/thinking text', () => {
  const t = createTranscript()
  t.appendAssistant('   ')
  t.appendThinking('')
  expect(t.items()).toHaveLength(0)
})

test('redacts secrets in recorded tool input', () => {
  const t = createTranscript()
  t.recordTool(toolEvent({ input: { token: 'sk-abcdef0123456789abcdef' } }))
  expect(JSON.stringify(t.tool()?.input)).not.toContain('sk-abcdef0123456789abcdef')
})

test('toMarkdown renders turns, replies, and folded tool output', () => {
  const t = createTranscript()
  t.appendUser('hi')
  t.recordTool(toolEvent())
  t.appendAssistant('done')
  const md = t.toMarkdown('My session')
  expect(md).toContain('# My session')
  expect(md).toContain('## Turn 1')
  expect(md).toContain('**You:**')
  expect(md).toContain('**elia:**')
  expect(md).toContain('<details><summary>🔧 grep')
})

test('clear resets ids and turn counter', () => {
  const t = createTranscript()
  t.appendUser('a')
  t.endTurn()
  t.clear()
  expect(t.items()).toHaveLength(0)
  expect(t.turns()).toBe(0)
})
