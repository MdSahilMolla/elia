import { expect, test } from 'bun:test'
import { createTranscriptStore } from './store.ts'
import type { ToolEvent } from '../../agentLoop.ts'

const evt = (over: Partial<ToolEvent> & { id?: string } = {}): ToolEvent & { id?: string } => ({
  name: 'grep',
  input: { pattern: 'x' },
  result: 'match',
  isError: false,
  durationMs: 5,
  cached: false,
  ...over,
})

test('streams assistant deltas into one live item', () => {
  const s = createTranscriptStore()
  s.appendUser('hi')
  s.assistantDelta('Hel')
  s.assistantDelta('lo')
  const { live } = s.getSnapshot()
  expect(live.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  expect((live.find((i) => i.kind === 'assistant') as { text: string }).text).toBe('Hello')
})

test('a tool call splits the streaming assistant paragraph', () => {
  const s = createTranscriptStore()
  s.assistantDelta('working')
  s.toolStart({ id: 't1', name: 'read_file', input: { path: 'a' } })
  const assistant = s.getSnapshot().live.find((i) => i.kind === 'assistant') as { streaming: boolean }
  expect(assistant.streaming).toBe(false)
})

test('toolEnd matches the running card by id', () => {
  const s = createTranscriptStore()
  s.toolStart({ id: 't1', name: 'read_file', input: { path: 'a' } })
  s.toolEnd(evt({ id: 't1', name: 'read_file', result: 'contents' }))
  const tool = s.lastTool()
  expect(tool?.status).toBe('ok')
  expect(tool?.result).toBe('contents')
  expect(s.toolCount()).toBe(1)
})

test('commit freezes live into committed and advances the turn', () => {
  const s = createTranscriptStore()
  s.appendUser('q')
  s.assistantDelta('a')
  s.commit()
  const snap = s.getSnapshot()
  expect(snap.live).toHaveLength(0)
  expect(snap.committed).toHaveLength(2)
  expect(snap.turn).toBe(1)
})

test('subscribe fires on mutation and version increases', () => {
  const s = createTranscriptStore()
  let hits = 0
  s.subscribe(() => (hits += 1))
  const v0 = s.getSnapshot().version
  s.notice('x')
  expect(hits).toBe(1)
  expect(s.getSnapshot().version).toBeGreaterThan(v0)
})

test('toMarkdown renders committed and live turns', () => {
  const s = createTranscriptStore()
  s.appendUser('build it')
  s.toolStart({ id: 't1', name: 'write_file', input: { path: 'x' } })
  s.toolEnd(evt({ id: 't1', name: 'write_file', result: 'ok' }))
  s.assistantDelta('done')
  const md = s.toMarkdown('S')
  expect(md).toContain('# S')
  expect(md).toContain('## Turn 1')
  expect(md).toContain('🔧 write_file')
})

test('redacts secrets in tool input', () => {
  const s = createTranscriptStore()
  s.toolStart({ id: 't1', name: 'run', input: { token: 'ghp_0123456789abcdef0123' } }) // pragma: allowlist secret
  expect(JSON.stringify(s.lastTool()?.input)).not.toContain('ghp_0123456789abcdef0123') // pragma: allowlist secret
})
