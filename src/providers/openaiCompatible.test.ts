import { expect, test } from 'bun:test'
import { toContentBlocks } from './openaiCompatible.ts'

test('text content becomes a text block', () => {
  expect(toContentBlocks({ content: 'hello' })).toEqual([{ type: 'text', text: 'hello' }])
})

test('empty or null content produces no text block', () => {
  expect(toContentBlocks({ content: null })).toEqual([])
  expect(toContentBlocks({ content: '' })).toEqual([])
  expect(toContentBlocks({})).toEqual([])
})

test('a tool call becomes a tool_use block with parsed arguments', () => {
  const blocks = toContentBlocks({
    tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
  })

  expect(blocks).toEqual([{ type: 'tool_use', id: 'call_abc', name: 'read_file', input: { path: 'a.ts' } }])
})

test('a hole in the tool_calls array is skipped instead of crashing the turn', () => {
  // The SDK indexes streamed tool calls by the provider's own index, so a provider
  // that emits them out of order leaves genuine holes here.
  const sparse: ({ id: string; type: string; function: { name: string; arguments: string } } | undefined)[] = []
  sparse[1] = { id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }

  const blocks = toContentBlocks({ tool_calls: sparse })

  expect(blocks).toEqual([{ type: 'tool_use', id: 'call_1', name: 'grep', input: { pattern: 'x' } }])
})

test('explicit null entries are skipped too', () => {
  const blocks = toContentBlocks({
    tool_calls: [null, { id: 'ok', type: 'function', function: { name: 'read_file', arguments: '{}' } }, undefined],
  })

  expect(blocks.length).toBe(1)
  expect(blocks[0]).toMatchObject({ id: 'ok' })
})

test('a tool call with no name is dropped rather than dispatched as an unknown tool', () => {
  expect(toContentBlocks({ tool_calls: [{ id: 'x', type: 'function', function: { arguments: '{}' } }] })).toEqual([])
})

test('a missing id is replaced by a turn-unique one so the tool_result can refer back', () => {
  const blocks = toContentBlocks({
    tool_calls: [
      { type: 'function', function: { name: 'a', arguments: '{}' } },
      { type: 'function', function: { name: 'b', arguments: '{}' } },
    ],
  })

  const ids = blocks.map((block) => (block.type === 'tool_use' ? block.id : ''))
  expect(new Set(ids).size).toBe(2)
})

test('a tool call with no type is still accepted — some providers omit it', () => {
  const blocks = toContentBlocks({ tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: '{}' } }] })

  expect(blocks.length).toBe(1)
})

test('a non-function tool call type is ignored', () => {
  expect(toContentBlocks({ tool_calls: [{ id: 'x', type: 'custom', function: { name: 'y', arguments: '{}' } }] })).toEqual(
    [],
  )
})

test('unparsable arguments become an empty object rather than throwing', () => {
  // Truncated streams produce half-written JSON; the model can recover from an
  // empty input far better than the loop can recover from an exception.
  const blocks = toContentBlocks({
    tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{"path": "unclos' } }],
  })

  expect(blocks[0]).toMatchObject({ name: 'read_file', input: {} })
})

test('text and tool calls come back together, text first', () => {
  const blocks = toContentBlocks({
    content: 'let me look',
    tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  })

  expect(blocks.map((block) => block.type)).toEqual(['text', 'tool_use'])
})
