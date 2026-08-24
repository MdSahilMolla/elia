import { expect, test } from 'bun:test'
import { toAnthropicMessage } from './anthropic.ts'
import type { ChatMessage } from './types.ts'

test('a thinking block round-trips into history with its signature intact', () => {
  const message: ChatMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'let me work through this', signature: 'sig-abc' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
    ],
  }

  expect(toAnthropicMessage(message)).toEqual({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'let me work through this', signature: 'sig-abc' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
    ],
  })
})

test('a redacted_thinking block round-trips its opaque data verbatim', () => {
  const message: ChatMessage = {
    role: 'assistant',
    content: [{ type: 'redacted_thinking', data: 'opaque-blob' }],
  }

  expect(toAnthropicMessage(message)).toEqual({
    role: 'assistant',
    content: [{ type: 'redacted_thinking', data: 'opaque-blob' }],
  })
})

test('text and tool_result blocks still convert as before, unaffected by thinking support', () => {
  const message: ChatMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
  }

  expect(toAnthropicMessage(message)).toEqual({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
  })
})
