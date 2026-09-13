import { expect, test } from 'bun:test'
import type { ChatMessage, ContentBlock } from './providers/types.ts'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads; we swap in a stub
// provider below so no real network call ever happens.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-compaction-test'

const { config } = await import('./config.ts')
const { beginCompaction, estimateTokens, findSafeCutIndex, maybeCompact, renderContextStatus, shrinkForOversizedRequest, COMPACTION_TOKEN_THRESHOLD } = await import(
  './compaction.ts'
)

function userText(text: string): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistantText(text: string): ChatMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function toolUse(id: string, name = 'read_file'): ChatMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { path: 'x.ts' } }] }
}

function toolResult(id: string, content = 'file contents'): ChatMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] }
}

test('estimateTokens grows with content length', () => {
  const small = estimateTokens([userText('hi')])
  const big = estimateTokens([userText('x'.repeat(4000))])
  expect(big).toBeGreaterThan(small)
  expect(big).toBeGreaterThanOrEqual(1000)
})

test('findSafeCutIndex finds the nearest plain user-text message at or before the target', () => {
  const messages: ChatMessage[] = [
    userText('turn 1'), // 0
    assistantText('ok'), // 1
    userText('turn 2'), // 2 <- safe boundary
    toolUse('t1'), // 3
    toolResult('t1'), // 4 (user role, but tool_result — not safe)
    assistantText('done'), // 5
  ]
  expect(findSafeCutIndex(messages, 4)).toBe(2)
})

test('findSafeCutIndex returns undefined when nothing safe exists in range', () => {
  const messages: ChatMessage[] = [userText('turn 1'), toolUse('t1'), toolResult('t1'), assistantText('done')]
  expect(findSafeCutIndex(messages, 2)).toBeUndefined()
})

test('a user message with an attached image is still a safe cut boundary and counts toward the token estimate', () => {
  const withImage: ChatMessage = {
    role: 'user',
    content: [
      { type: 'image', mediaType: 'image/png', data: 'x'.repeat(200), alt: 'a.png' },
      { type: 'text', text: 'take a look' },
    ],
  }
  const messages: ChatMessage[] = [userText('turn 1'), assistantText('ok'), withImage, toolUse('t1'), toolResult('t1')]
  expect(findSafeCutIndex(messages, 4)).toBe(2)
  // The image contributes a flat ~1.5k-token estimate, dwarfing the short text.
  expect(estimateTokens([withImage])).toBeGreaterThan(1000)
})

test('maybeCompact does nothing under the token threshold', async () => {
  const messages: ChatMessage[] = [userText('hello'), assistantText('hi there')]
  const before = JSON.stringify(messages)
  const fired = await maybeCompact(messages)
  expect(fired).toBe(false)
  expect(JSON.stringify(messages)).toBe(before)
})

test('maybeCompact does nothing when there are too few messages to trim', async () => {
  // Individually large, but too few messages to leave a KEEP_RECENT_MESSAGES tail after cutting.
  const messages: ChatMessage[] = [userText('x'.repeat(200_000))]
  const fired = await maybeCompact(messages)
  expect(fired).toBe(false)
})

test('maybeCompact folds old history into the boundary message and preserves the tail verbatim', async () => {
  config.tiers.fast.provider = {
    async streamTurn({ onText }) {
      onText('SUMMARY: earlier work happened.')
      return {
        content: [{ type: 'text', text: 'SUMMARY: earlier work happened.' }] as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    },
  }

  const filler = 'lorem ipsum '.repeat(2000) // well over the per-message threshold contribution
  const old: ChatMessage[] = []
  for (let i = 0; i < 6; i++) {
    old.push(userText(`${filler} old turn ${i}`))
    old.push(assistantText(`${filler} old reply ${i}`))
  }

  const recent: ChatMessage[] = []
  for (let i = 0; i < 8; i++) {
    recent.push(userText(`recent turn ${i}`))
    recent.push(assistantText(`recent reply ${i}`))
  }

  const messages: ChatMessage[] = [...old, ...recent]
  const totalBefore = messages.length

  const fired = await maybeCompact(messages)

  expect(fired).toBe(true)
  expect(messages.length).toBeLessThan(totalBefore)
  expect(messages[0]!.role).toBe('user')
  const firstBlock = messages[0]!.content[0]
  expect(firstBlock?.type).toBe('text')
  expect((firstBlock as { text: string }).text).toContain('auto-compacted')
  expect((firstBlock as { text: string }).text).toContain('SUMMARY: earlier work happened')

  // The tail is untouched, verbatim.
  const tail = messages.slice(-4)
  expect(tail.some((message) => message.content.some((block) => block.type === 'text' && block.text.includes('recent reply 7')))).toBe(
    true,
  )
})

test('maybeCompact never separates a tool_use from its tool_result', async () => {
  config.tiers.fast.provider = {
    async streamTurn({ onText }) {
      onText('summary')
      return {
        content: [{ type: 'text', text: 'summary' }] as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    },
  }

  const filler = 'x'.repeat(3000)
  const messages: ChatMessage[] = []
  for (let i = 0; i < 20; i++) {
    messages.push(userText(`${filler} request ${i}`))
    messages.push(toolUse(`call-${i}`))
    messages.push(toolResult(`call-${i}`, `${filler} result ${i}`))
    messages.push(assistantText(`${filler} reply ${i}`))
  }

  await maybeCompact(messages)

  // Every tool_use must still be immediately followed by its own tool_result.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      const next = messages[i + 1]
      const hasMatchingResult = next?.content.some((b) => b.type === 'tool_result' && b.tool_use_id === block.id)
      expect(hasMatchingResult).toBe(true)
    }
  }
})

test('renderContextStatus reports plain usage with no archived episodes', () => {
  const line = renderContextStatus([userText('hi')], 0)
  expect(line).toContain('context:')
  expect(line).toContain(`/ ${COMPACTION_TOKEN_THRESHOLD.toLocaleString('en-US')} tokens`)
  expect(line).not.toContain('archived')
})

test('renderContextStatus mentions archived episodes and represents them as effectively unbounded', () => {
  const line = renderContextStatus([userText('hi')], 3)
  expect(line).toContain('3 episodes archived')
  expect(line).toContain('recallable')
})

test('renderContextStatus caps the percentage at 100 for a history well past the threshold', () => {
  const huge = [userText('x'.repeat(COMPACTION_TOKEN_THRESHOLD * 10))]
  const line = renderContextStatus(huge, 0)
  expect(line).toContain('(100%)')
})

function bigHistory(turns = 10): ChatMessage[] {
  const filler = 'lorem ipsum '.repeat(3000)
  const messages: ChatMessage[] = []
  for (let i = 0; i < turns; i++) {
    messages.push(userText(`${filler} old turn ${i}`))
    messages.push(assistantText(`${filler} old reply ${i}`))
  }
  for (let i = 0; i < 8; i++) {
    messages.push(userText(`recent turn ${i}`))
    messages.push(assistantText(`recent reply ${i}`))
  }
  return messages
}

test('beginCompaction returns undefined below the threshold', () => {
  expect(beginCompaction([userText('hi'), assistantText('hey')])).toBeUndefined()
})

test('beginCompaction runs the archive in the background: apply() is a no-op until it settles, then folds in', async () => {
  let release: (summary: string) => void = () => {}
  config.tiers.fast.provider = {
    async streamTurn({ onText }) {
      const summary = await new Promise<string>((resolve) => {
        release = resolve
      })
      onText(summary)
      return { content: [{ type: 'text', text: summary }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }

  const messages = bigHistory()
  const lengthBefore = messages.length
  const pending = beginCompaction(messages)
  expect(pending).toBeDefined()

  // Archive still in flight — the loop can keep going, history is untouched.
  expect(pending!.settled).toBe(false)
  expect(pending!.apply(messages)).toBe(false)
  expect(messages.length).toBe(lengthBefore)

  release('SUMMARY: the earlier turns, condensed.')
  await pending!.flush(messages)

  expect(pending!.settled).toBe(true)
  expect(messages.length).toBeLessThan(lengthBefore)
  expect((messages[0]!.content[0] as { text: string }).text).toContain('SUMMARY: the earlier turns, condensed.')
  // Idempotent — a second apply() does nothing.
  const afterFirst = messages.length
  expect(pending!.apply(messages)).toBe(false)
  expect(messages.length).toBe(afterFirst)
})

test('beginCompaction: a failed archive settles without touching the history', async () => {
  config.tiers.fast.provider = {
    async streamTurn() {
      throw new Error('provider down')
    },
  }
  const messages = bigHistory()
  const before = JSON.stringify(messages)
  const pending = beginCompaction(messages)!
  const foldedIn = await pending.flush(messages)

  expect(foldedIn).toBe(false)
  expect(pending.settled).toBe(true)
  expect(JSON.stringify(messages)).toBe(before)
})

test('maybeCompact leaves messages untouched if the summarizer fails', async () => {
  config.tiers.fast.provider = {
    async streamTurn() {
      throw new Error('provider down')
    },
  }

  const filler = 'lorem ipsum '.repeat(3000)
  const messages: ChatMessage[] = []
  for (let i = 0; i < 10; i++) {
    messages.push(userText(`${filler} ${i}`))
    messages.push(assistantText(`${filler} ${i}`))
  }
  const before = JSON.stringify(messages)

  const fired = await maybeCompact(messages)

  expect(fired).toBe(false)
  expect(JSON.stringify(messages)).toBe(before)
})

/** A history whose bulk is old tool output — the shape every real coding turn takes. */
function historyWithLargeToolResults(count = 20): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `ask ${i}` }] })
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `src/f${i}.ts` } }],
    })
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(8_000), is_error: false }],
    })
  }
  return messages
}

// Run 2026-09-13-l0av-rnq0: a step failed at 42,323 tokens against an 8,000
// TPM cap, and its single retry re-sent 41,888 tokens — the same request. The
// ordinary compaction path cannot help here: it needs a model call, and the
// provider is refusing calls.
test('an oversized request is shrunk without a model call', () => {
  const messages = historyWithLargeToolResults()
  const before = estimateTokens(messages)
  expect(shrinkForOversizedRequest(messages)).toBe(true)
  expect(estimateTokens(messages)).toBeLessThan(before / 2)
})

test('the most recent turns survive the shrink intact', () => {
  const messages = historyWithLargeToolResults()
  const tail = messages.slice(-12).map((message) => JSON.stringify(message))
  shrinkForOversizedRequest(messages)
  expect(messages.slice(-12).map((message) => JSON.stringify(message))).toEqual(tail)
})

// The caller uses the return value to decide between "retry smaller" and
// "there is nothing left to cut" — a wrong answer either loops or gives up early.
test('shrinking reports false once there is nothing left to cut', () => {
  const messages = historyWithLargeToolResults()
  expect(shrinkForOversizedRequest(messages)).toBe(true)
  expect(shrinkForOversizedRequest(messages)).toBe(false)
})

test('a short history has nothing to shrink', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]
  expect(shrinkForOversizedRequest(messages)).toBe(false)
})

// Truncation has to leave the model able to tell what it lost, or it will
// silently reason from a half-read file.
test('a truncated result says it was truncated and why', () => {
  const messages = historyWithLargeToolResults()
  shrinkForOversizedRequest(messages)
  const truncated = messages[2]!.content[0]!
  expect(truncated.type).toBe('tool_result')
  if (truncated.type === 'tool_result') {
    expect(truncated.content).toContain('characters dropped')
    expect(truncated.content).toContain('too large')
  }
})
