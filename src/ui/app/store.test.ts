import { expect, test } from 'bun:test'
import { createTranscriptStore, stableCut, toolsOf } from './store.ts'
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
    // Alternate a lookup with a command so nothing merges into one group.
    const name = i % 2 ? 'run_command' : 'grep'
    s.toolStart({ id: `t${i}`, name, input: { pattern: String(i) } })
    s.toolEnd(evt({ id: `t${i}`, name, result: `r${i}` }))
    naive.push(`t${i}`)
  }
  s.assistantDelta('all done')
  const snap = s.getSnapshot()
  // Everything that settled moved to <Static>; the live region never piles up.
  expect(snap.live.length).toBeLessThanOrEqual(3)
  // Order across the two lists still matches a single append-only list.
  expect(toolsOf([...snap.committed, ...snap.live]).map((t) => t.id)).toEqual(naive)
  expect(s.toolCount()).toBe(30)
  expect(toolsOf(s.turnItems())).toHaveLength(30)
})

test('consecutive lookups share one group row; anything else closes it', () => {
  const s = createTranscriptStore()
  s.appendUser('look around')
  for (const [id, name] of [['r1', 'read_file'], ['r2', 'grep'], ['r3', 'list_files']] as const) {
    s.toolStart({ id, name, input: { path: id } })
  }
  // Results land out of order, as parallel calls do.
  s.toolEnd(evt({ id: 'r2', name: 'grep', result: 'x.ts:1:hit' }))
  s.toolEnd(evt({ id: 'r1', name: 'read_file', result: '1\tline' }))
  s.toolEnd(evt({ id: 'r3', name: 'list_files', result: 'a.ts' }))
  s.toolStart({ id: 'e1', name: 'edit_file', input: { path: 'a.ts' } })
  s.toolStart({ id: 'r4', name: 'read_file', input: { path: 'b.ts' } })

  const items = [...s.getSnapshot().committed, ...s.getSnapshot().live]
  const groups = items.filter((i) => i.kind === 'group')
  expect(groups).toHaveLength(2)
  const first = groups[0] as { tools: { id: string; status: string }[] }
  expect(first.tools.map((t) => t.id)).toEqual(['r1', 'r2', 'r3'])
  expect(first.tools.every((t) => t.status === 'ok')).toBe(true)
  // The edit sits between the two groups, not inside either.
  expect(items.map((i) => i.kind)).toEqual(['user', 'group', 'tool', 'group'])
  expect(s.toolCount()).toBe(5)
})

test('a long reply commits finished paragraphs so only the one in flight stays live', () => {
  const s = createTranscriptStore()
  s.appendUser('explain')
  const paragraphs = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} explains one more thing.`)
  for (const p of paragraphs) s.assistantDelta(`${p}\n\n`)
  s.assistantDelta('And the tail is still streaming')
  const { committed, live } = s.getSnapshot()
  const replies = [...committed, ...live].filter((i) => i.kind === 'assistant') as { text: string; continuation?: boolean; streaming: boolean }[]
  // Nothing lost, nothing duplicated, in order.
  expect(replies.map((r) => r.text).join('\n\n')).toBe([...paragraphs, 'And the tail is still streaming'].join('\n\n'))
  // Only the reply's first part carries the leading ●.
  expect(replies[0]!.continuation).toBeFalsy()
  expect(replies.slice(1).every((r) => r.continuation)).toBe(true)
  // The live region holds just the paragraph still streaming.
  expect(live.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  expect((live.at(-1) as { streaming: boolean }).streaming).toBe(true)
})

test('stableCut never splits inside a code fence', () => {
  expect(stableCut('intro\n\n```ts\nconst a = 1\n\nconst b = 2')).toBe('intro\n\n'.length)
  expect(stableCut('```ts\nconst a = 1\n\nconst b = 2')).toBe(-1)
  expect(stableCut('no break yet')).toBe(-1)
  // A trailing blank line with nothing after it is not a cut yet.
  expect(stableCut('done paragraph\n\n')).toBe(-1)
})

test('the header prints once, straight into scrollback', () => {
  const s = createTranscriptStore()
  s.header({ version: '1.2.3', greeting: 'dev mode', location: 'elia ⎇ main', lessons: 4 })
  const { committed, live } = s.getSnapshot()
  expect(live).toHaveLength(0)
  expect(committed).toEqual([expect.objectContaining({ kind: 'header', version: '1.2.3', lessons: 4 })])
  expect(s.toMarkdown()).not.toContain('1.2.3')
})

test('an activity keeps its line breaks instead of flattening a checklist onto one line', () => {
  const s = createTranscriptStore()
  s.activity({ kind: 'status', status: 'completed', title: 'Checks', detail: '✓ build\n✗ tests' })
  const notice = s.getSnapshot().live.find((i) => i.kind === 'notice') as { text: string }
  expect(notice.text).toBe('Checks\n✓ build\n✗ tests')
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

test('a repair loop\'s repeated verdict collapses to a short pointer even with a check-result line in between', () => {
  const s = createTranscriptStore()
  const verdict = '✗ critic#1: the deliverable is missing from the git diff.'
  s.activity({ kind: 'status', title: verdict })
  // A verification pass/fail line — a different activity — lands in between,
  // exactly like the interleaved `✓ $ type index.html` line from a real repair
  // loop. Before this fix each identical verdict after it stacked as its own
  // full-text duplicate row instead of collapsing (see store.ts `activity()`).
  s.activity({ kind: 'status', title: '✓ $ type index.html' })
  s.activity({ kind: 'status', title: verdict })
  s.activity({ kind: 'status', title: verdict })

  const isNotice = (i: { kind: string }): i is { kind: 'notice'; id: string; text: string } => i.kind === 'notice'
  const notices = [...s.getSnapshot().committed, ...s.getSnapshot().live].filter(isNotice)
  // One pointer, rewritten in place as the count climbs — not one new pointer
  // per repeat. This assertion used to expect a line per repeat ("×2" *and*
  // "×3" as separate rows), which is the behaviour it was named for collapsing:
  // the back-to-back matcher compares against the raw text, and a pointer line
  // carries a "(same as before · ×N)" suffix, so it never matched its own
  // output and appended forever. Two alternating statuses produced twelve rows.
  expect(notices).toHaveLength(3)
  expect(notices[0]!.text).toBe(verdict)
  expect(notices[1]!.text).toBe('✓ $ type index.html')
  expect(notices[2]!.text).toContain('same as before · ×3')
  // The full verdict text is never printed a second time.
  expect(notices.filter((n) => n.text === verdict)).toHaveLength(1)
})

// The property that actually matters to an operator watching a long run: a
// phase that keeps reporting itself must not grow scrollback without bound.
test('a repeating activity costs a bounded number of rows however often it repeats', () => {
  const rows = (repeats: number): number => {
    const s = createTranscriptStore()
    s.appendUser('build it')
    for (let i = 0; i < repeats; i += 1) {
      s.activity({ kind: 'status', title: 'Orienting' })
      s.activity({ kind: 'status', title: 'scout starting' })
    }
    return [...s.getSnapshot().committed, ...s.getSnapshot().live].length
  }

  expect(rows(10)).toBe(rows(200))
  expect(rows(200)).toBeLessThanOrEqual(6)
})

// Bounding repeats must not silence genuinely different messages.
test('distinct activities each still print', () => {
  const s = createTranscriptStore()
  for (const title of ['alpha', 'beta', 'gamma', 'delta']) s.activity({ kind: 'status', title })
  const texts = [...s.getSnapshot().committed, ...s.getSnapshot().live]
    .flatMap((item) => (item.kind === 'notice' ? [item.text] : []))
  expect(texts).toEqual(['alpha', 'beta', 'gamma', 'delta'])
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

// --- Empty deltas must not shatter the transcript -----------------------------

test('empty deltas interleaved with reasoning keep it as one thinking item', () => {
  // Exactly what mercury-2.5 streams: an empty `content` chunk between every
  // reasoning chunk. Each one used to append an empty assistant item, which
  // displaced the streaming thinking item from the tail and forced the next
  // reasoning token into a brand-new `✻` block — one word per line on screen.
  const s = createTranscriptStore()
  s.appendUser('build a birds website')
  for (const word of ['The ', 'plan ', 'says ', 'create ', 'a ', 'birds ', 'website']) {
    s.assistantDelta('')
    s.thinkingDelta(word)
  }
  const { live } = s.getSnapshot()
  expect(live.filter((i) => i.kind === 'thinking')).toHaveLength(1)
  expect(live.filter((i) => i.kind === 'assistant')).toHaveLength(0)
  expect((live.find((i) => i.kind === 'thinking') as { text: string }).text).toBe('The plan says create a birds website')
})

test('finished reasoning lines settle while the line in flight keeps streaming', () => {
  const s = createTranscriptStore()
  s.appendUser('think')
  s.thinkingDelta('first line\nsecond line\nthird ')
  s.thinkingDelta('line still going')
  const { committed, live } = s.getSnapshot()
  const thoughts = [...committed, ...live].filter((i) => i.kind === 'thinking') as { text: string; continuation?: boolean }[]
  expect(thoughts.map((t) => t.text)).toEqual(['first line\nsecond line', 'third line still going'])
  expect(thoughts[1]!.continuation).toBe(true)
})

test('an empty assistant delta adds no bullet-only item', () => {
  const s = createTranscriptStore()
  s.appendUser('hi')
  s.assistantDelta('')
  expect(s.getSnapshot().live.filter((i) => i.kind === 'assistant')).toHaveLength(0)
  s.assistantDelta('real')
  expect(s.getSnapshot().live.filter((i) => i.kind === 'assistant')).toHaveLength(1)
})
