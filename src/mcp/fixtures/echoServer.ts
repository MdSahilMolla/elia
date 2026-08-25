/**
 * A minimal MCP server over stdio, used only by mcp/*.test.ts to exercise the
 * real client against a real subprocess instead of a mocked transport. Exposes
 * one tool, `echo`, which returns its `text` argument, and an `explode` tool
 * that reports isError:true — enough to cover both the success and error paths.
 */

export {}

const decoder = new TextDecoder()
let buffer = ''

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(line: string): void {
  let message: { id?: number; method?: string; params?: Record<string, unknown> }
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (typeof message.method !== 'string') return

  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'echo-fixture', version: '0.0.0' } } })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echoes back the given text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
          { name: 'explode', description: 'Always returns an error', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    const params = message.params as { name: string; arguments?: Record<string, unknown> }
    if (params.name === 'echo') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo: ${params.arguments?.text}` }] } })
    } else if (params.name === 'explode') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } })
    } else {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown tool ${params.name}` } })
    }
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
}

for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk as Uint8Array, { stream: true })
  let newlineIndex: number
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (line) handle(line)
  }
}
