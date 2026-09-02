import { afterEach, expect, test } from 'bun:test'
import { McpHttpClient } from './httpClient.ts'

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

interface FixtureOptions {
  /** Reply to tools/list and tools/call as an SSE stream rather than plain JSON. */
  sse?: boolean
  /** Require this exact Authorization header or answer 401. */
  requireAuth?: string
  /** Hand back a session id on initialize and require it thereafter. */
  session?: string
}

function startFixture(options: FixtureOptions = {}): string {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (options.requireAuth && request.headers.get('authorization') !== options.requireAuth) {
        return new Response('unauthorized', { status: 401 })
      }
      const message = (await request.json()) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }

      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })

      let result: unknown
      if (message.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '0.0.0' } }
      } else if (options.session && request.headers.get('mcp-session-id') !== options.session) {
        return new Response('missing session', { status: 400 })
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'ping', description: 'returns pong', inputSchema: { type: 'object', properties: {} } }] }
      } else if (message.method === 'tools/call') {
        result = message.params?.name === 'ping'
          ? { content: [{ type: 'text', text: `pong:${(message.params?.arguments as { note?: string })?.note ?? ''}` }] }
          : { content: [{ type: 'text', text: 'unknown tool' }], isError: true }
      } else {
        return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } })
      }

      const body = { jsonrpc: '2.0', id: message.id, result }
      const headers: Record<string, string> = {}
      if (options.session && message.method === 'initialize') headers['mcp-session-id'] = options.session

      if (options.sse && message.method !== 'initialize') {
        return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
          headers: { ...headers, 'content-type': 'text/event-stream' },
        })
      }
      return Response.json(body, { headers })
    },
  })
  return `http://127.0.0.1:${server.port}/mcp`
}

test('connects, lists tools, and calls a tool over plain JSON', async () => {
  const url = startFixture()
  const client = new McpHttpClient({ name: 'fx', url })
  try {
    await client.connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['ping'])
    const result = await client.callTool('ping', { note: 'hi' })
    expect(result.content?.[0]?.text).toBe('pong:hi')
  } finally {
    await client.closeAndWait()
  }
})

test('parses a text/event-stream response body', async () => {
  const url = startFixture({ sse: true })
  const client = new McpHttpClient({ name: 'fx', url })
  try {
    await client.connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['ping'])
  } finally {
    await client.closeAndWait()
  }
})

test('an isError tool result is surfaced on the result, not thrown', async () => {
  const url = startFixture()
  const client = new McpHttpClient({ name: 'fx', url })
  try {
    await client.connect()
    const result = await client.callTool('nope', {})
    expect(result.isError).toBe(true)
  } finally {
    await client.closeAndWait()
  }
})

test('sends the configured auth header', async () => {
  const url = startFixture({ requireAuth: 'Bearer secret' })
  const bad = new McpHttpClient({ name: 'fx', url })
  let threw = false
  try {
    await bad.connect()
  } catch (err) {
    threw = true
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('401')
  } finally {
    await bad.closeAndWait()
  }
  expect(threw).toBe(true)

  const good = new McpHttpClient({ name: 'fx', url, headers: { Authorization: 'Bearer secret' } })
  try {
    await good.connect()
    expect((await good.listTools()).tools).toHaveLength(1)
  } finally {
    await good.closeAndWait()
  }
})

test('echoes the Mcp-Session-Id handed back on initialize', async () => {
  const url = startFixture({ session: 'sess-123' })
  const client = new McpHttpClient({ name: 'fx', url })
  try {
    await client.connect()
    expect((await client.listTools()).tools).toHaveLength(1)
  } finally {
    await client.closeAndWait()
  }
})

test('refuses a legacy SSE-transport connector up front', () => {
  expect(() => new McpHttpClient({ name: 'fx', url: 'https://e.com/sse', transport: 'sse' })).toThrow(/legacy SSE/)
})
