import { afterEach, expect, test } from 'bun:test'
import { createOpenAICompatibleProvider, toContentBlocks, toOpenAIMessages } from './openaiCompatible.ts'
import type { ChatMessage } from './types.ts'

// The fake server below is plain http://127.0.0.1 — allow that explicitly for
// these tests the same way networkPolicy.test.ts does, restoring afterward so
// it doesn't leak into other files sharing this test process.
const PREVIOUS_ALLOW_INSECURE = process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
  if (PREVIOUS_ALLOW_INSECURE === undefined) delete process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT
  else process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT = PREVIOUS_ALLOW_INSECURE
})

/** One SSE `data:` frame per event, exactly what the openai SDK's Stream.fromSSEResponse parses. */
function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
}

const USER_MESSAGES: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

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

test('an attached image is sent as a data-URL image_url part alongside the text', () => {
  const messages = toOpenAIMessages('SYS', [
    {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'aGk=', alt: 'shot.png' },
        { type: 'text', text: 'explain' },
      ],
    },
  ])

  expect(messages[1]).toEqual({
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
      { type: 'text', text: 'explain' },
    ],
  })
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

test('a reasoning field becomes a thinking block, ordered before text', () => {
  const blocks = toContentBlocks({ reasoning: '17*24 = 408', content: '408' })

  expect(blocks).toEqual([
    { type: 'thinking', text: '17*24 = 408', signature: '' },
    { type: 'text', text: '408' },
  ])
})

test('reasoning_content is read the same way as reasoning', () => {
  const blocks = toContentBlocks({ reasoning_content: 'because X', content: 'answer' })

  expect(blocks[0]).toEqual({ type: 'thinking', text: 'because X', signature: '' })
})

test('reasoning is omitted from content blocks when includeReasoning is false', () => {
  const blocks = toContentBlocks({ reasoning: 'hidden', content: 'answer' }, false)

  expect(blocks).toEqual([{ type: 'text', text: 'answer' }])
})

test('an empty reasoning string produces no thinking block', () => {
  expect(toContentBlocks({ reasoning: '', content: 'answer' })).toEqual([{ type: 'text', text: 'answer' }])
})

test('a streaming failure after partial content propagates instead of silently replaying the whole response', async () => {
  process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT = '1'
  let requestCount = 0
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestCount += 1
      const body = (await request.json()) as { stream?: boolean }
      if (body.stream) {
        // A gateway that streams real partial content, then fails mid-response
        // with wording matching isStreamingUnsupported()'s broad regex.
        return new Response(
          sse(
            {
              id: '1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'm',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'partial answer' }, finish_reason: null }],
            },
            { error: { message: 'streaming is not supported for this endpoint' } },
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      // A silent fallback landing here — after content already reached onText —
      // is exactly the double-send bug this test guards against.
      return Response.json({
        id: '2',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'DUPLICATE' }, finish_reason: 'stop' }],
      })
    },
  })
  const provider = createOpenAICompatibleProvider('key', 'model', `http://127.0.0.1:${server.port}`)

  const texts: string[] = []
  let error: unknown
  try {
    await provider.streamTurn({ system: 'sys', messages: USER_MESSAGES, tools: [], onText: (delta) => texts.push(delta) })
  } catch (err) {
    error = err
  }

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('streaming is not supported')
  // The partial content already reached onText — it must show up exactly once.
  expect(texts).toEqual(['partial answer'])
  // No non-streaming fallback request was made.
  expect(requestCount).toBe(1)
})

test('a streaming failure with no content emitted yet safely falls back to a non-streaming replay', async () => {
  process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT = '1'
  let requestCount = 0
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestCount += 1
      const body = (await request.json()) as { stream?: boolean }
      if (body.stream) {
        // Fails before a single chunk arrives — genuinely safe to retry, the
        // same case "request ended without sending any chunks" already covered.
        return new Response(sse({ error: { message: 'streaming is not supported for this endpoint' } }), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return Response.json({
        id: '2',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'fallback answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })
    },
  })
  const provider = createOpenAICompatibleProvider('key', 'model', `http://127.0.0.1:${server.port}`)

  const texts: string[] = []
  const result = await provider.streamTurn({ system: 'sys', messages: USER_MESSAGES, tools: [], onText: (delta) => texts.push(delta) })

  expect(texts).toEqual(['fallback answer'])
  expect(result.content).toEqual([{ type: 'text', text: 'fallback answer' }])
  expect(requestCount).toBe(2)
})
