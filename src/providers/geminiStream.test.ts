import { expect, test } from 'bun:test'
import { numberToolCalls, numberToolCallsInStream } from './geminiStream.ts'

test('tool calls without an index are numbered in order across chunks', () => {
  const next = new Map<number, number>()
  const first = { choices: [{ index: 0, delta: { tool_calls: [{ id: 'a' }] } }] }
  const second = { choices: [{ index: 0, delta: { tool_calls: [{ id: 'b' }, { id: 'c' }] } }] }
  expect(numberToolCalls(first, next)).toBe(true)
  numberToolCalls(second, next)
  expect([first, second].flatMap((chunk) => chunk.choices[0]!.delta.tool_calls.map((call) => (call as { index?: number }).index))).toEqual([0, 1, 2])
})

test('an endpoint that already numbers its tool calls is left alone', () => {
  const chunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a' }] } }] }
  expect(numberToolCalls(chunk, new Map())).toBe(false)
})

test('the stream is rewritten even when a line arrives in pieces', async () => {
  const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{}' } }] } }] })}\n\ndata: [DONE]\n\n`
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame.slice(0, 30)))
      controller.enqueue(encoder.encode(frame.slice(30)))
      controller.close()
    },
  })
  const text = await new Response(numberToolCallsInStream(body)).text()
  const [data] = text.split('\n').filter((line) => line.startsWith('data: {'))
  expect(JSON.parse(data!.slice(6)).choices[0].delta.tool_calls[0].index).toBe(0)
  expect(text).toContain('data: [DONE]')
})
