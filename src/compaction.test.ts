import { expect, test } from 'bun:test'
import type { ChatMessage, ContentBlock } from './providers/types.ts'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads; we swap in a stub
// provider below so no real network call ever happens.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-compaction-test'

const { config } = await import('./config.ts')
const { estimateTokens, findSafeCutIndex, maybeCompact, renderContextStatus, COMPACTION_TOKEN_THRESHOLD } = await import(
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
