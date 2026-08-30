import { expect, test } from 'bun:test'
import { buildAnthropicRequest, toAnthropicMessage } from './anthropic.ts'
import type { ChatMessage, ToolDefinition } from './types.ts'

const tool: ToolDefinition = {
  name: 'read_file',
  description: 'read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const userTurn: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

test('the stable system prompt and the tool block get the 1-hour cache TTL', () => {
  const request = buildAnthropicRequest({ model: 'claude-sonnet-5', system: 'STABLE', messages: userTurn, tools: [tool] })

  const system = request.system as { type: string; text: string; cache_control?: { type: string; ttl?: string } }[]
  expect(system).toHaveLength(1)
  expect(system[0]).toMatchObject({ text: 'STABLE', cache_control: { type: 'ephemeral', ttl: '1h' } })

  const tools = request.tools as { cache_control?: { type: string; ttl?: string } }[]
  expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
})

test('a dynamic system suffix becomes a second block on the default (5m) TTL so it never evicts the stable prefix', () => {
  const request = buildAnthropicRequest({
    model: 'claude-sonnet-5',
    system: 'STABLE',
    systemDynamic: 'RANKED MEMORY',
    messages: userTurn,
    tools: [tool],
  })

  const system = request.system as { text: string; cache_control?: { type: string; ttl?: string } }[]
  expect(system).toHaveLength(2)
  expect(system[0]).toMatchObject({ text: 'STABLE', cache_control: { type: 'ephemeral', ttl: '1h' } })
  expect(system[1]).toMatchObject({ text: 'RANKED MEMORY', cache_control: { type: 'ephemeral' } })
  expect((system[1]!.cache_control as { ttl?: string }).ttl).toBeUndefined()
})

test('an empty or whitespace dynamic suffix does not add a second system block', () => {
  const request = buildAnthropicRequest({ model: 'm', system: 'STABLE', systemDynamic: '   ', messages: userTurn, tools: [tool] })
  expect(request.system as unknown[]).toHaveLength(1)
})

test('the last conversation block carries a cache breakpoint for incremental history caching', () => {
  const request = buildAnthropicRequest({ model: 'm', system: 'S', messages: userTurn, tools: [tool] })
  const messages = request.messages as { content: { cache_control?: { type: string } }[] }[]
  expect(messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' })
})

test('extended-thinking budget lifts max_tokens to leave room for the answer', () => {
  const withThinking = buildAnthropicRequest({ model: 'm', thinkingBudget: 30_000, system: 'S', messages: userTurn, tools: [tool] })
  expect(withThinking.thinking).toEqual({ type: 'enabled', budget_tokens: 30_000 })
  expect(withThinking.max_tokens).toBeGreaterThan(30_000)

  const noThinking = buildAnthropicRequest({ model: 'm', system: 'S', messages: userTurn, tools: [tool] })
  expect(noThinking.thinking).toBeUndefined()
})

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
