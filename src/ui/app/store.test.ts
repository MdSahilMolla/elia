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
  // The settled paragraph is flushed into committed the moment the tool starts.
  const { committed, live } = s.getSnapshot()
  const assistant = [...committed, ...live].find((i) => i.kind === 'assistant') as { streaming: boolean }
  expect(assistant.streaming).toBe(false)
})

test('flushSettled keeps the live region bounded across a long tool batch', () => {
  const s = createTranscriptStore()
  s.appendUser('do a lot')
  const naive: string[] = []
  for (let i = 0; i < 30; i += 1) {
    s.toolStart({ id: `t${i}`, name: 'grep', input: { pattern: String(i) } })
    s.toolEnd(evt({ id: `t${i}`, name: 'grep', result: `r${i}` }))
    naive.push(`t${i}`)
  }
  s.assistantDelta('all done')
  const snap = s.getSnapshot()
  // Everything that settled moved to <Static>; the live region never piles up.
  expect(snap.live.length).toBeLessThanOrEqual(3)
  // Order across the two lists still matches a single append-only list.
  const toolIds = [...snap.committed, ...snap.live].filter((i) => i.kind === 'tool').map((i) => i.id)
  expect(toolIds).toEqual(naive)
  expect(s.toolCount()).toBe(30)
  expect(s.turnItems().filter((i) => i.kind === 'tool')).toHaveLength(30)
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

test('an immediately-repeated notice collapses to one line with a ×N counter', () => {
  const s = createTranscriptStore()
  s.notice('Press Esc again to force-quit.')
  s.notice('Press Esc again to force-quit.')
  s.notice('Press Esc again to force-quit.')
  const isNotice = (i: { kind: string }): i is { kind: 'notice'; id: string; text: string } => i.kind === 'notice'
  const notices = [...s.getSnapshot().committed, ...s.getSnapshot().live].filter(isNotice)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.text).toBe('Press Esc again to force-quit.  ×3')
  // A different notice in between resets the run.
  s.notice('other')
  s.notice('Press Esc again to force-quit.')
  const after = [...s.getSnapshot().committed, ...s.getSnapshot().live].filter(isNotice)
  expect(after).toHaveLength(3)
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

test('redacts secrets in a tool result at ingestion, so every render path (expanded, diff, shell) is already safe', () => {
  const s = createTranscriptStore()
  const secret = 'ghp_0123456789abcdefghij' // pragma: allowlist secret
  s.toolStart({ id: 't1', name: 'run_command', input: { command: 'echo secret' } })
  s.toolEnd(evt({ id: 't1', name: 'run_command', result: `exit code: 0\nstdout:\ntoken=${secret}\nstderr:\n` }))
  const result = s.lastTool()?.result ?? ''
  expect(result).not.toContain(secret)
  expect(result).toContain('[REDACTED]')
  // Multiline structure is preserved (not flattened/truncated the way redactText would).
  expect(result.split('\n').length).toBeGreaterThan(1)
})

test('redacts secrets in shell-escape (!command) output', () => {
  const s = createTranscriptStore()
  const secret = 'AKIAABCDEFGHIJKLMNOP' // pragma: allowlist secret
  s.shell('printenv', `AWS_ACCESS_KEY_ID=${secret}`)
  const { live } = s.getSnapshot()
  const shellItem = live.find((i) => i.kind === 'shell') as { text: string } | undefined
  expect(shellItem?.text).not.toContain(secret)
  expect(shellItem?.text).toContain('[REDACTED]')
})
