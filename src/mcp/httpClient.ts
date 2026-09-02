import type { McpServerConfig } from './config.ts'
import type { McpTransport } from './transport.ts'
import { isJsonRpcResponse, MCP_CLIENT_INFO, MCP_PROTOCOL_VERSION, type JsonRpcResponse, type McpToolCallResult, type McpToolsListResult } from './protocol.ts'

const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000

/**
 * One live connection to a **remote** MCP server (a "connector") over the MCP
 * Streamable HTTP transport: every JSON-RPC request is an HTTP POST to a single
 * URL; the server replies either with `application/json` (one response) or
 * `text/event-stream` (SSE, one or more `data:` events — we read to the response
 * that matches our request id). A `Mcp-Session-Id` header handed back on
 * `initialize` is echoed on every later request. Custom `headers` from the
 * config carry auth (e.g. `Authorization: Bearer …`).
 *
 * Legacy SSE-only servers (`"transport": "sse"`, separate GET channel) are not
 * supported — the error message says so rather than hanging.
 */
export class McpHttpClient implements McpTransport {
  readonly name: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private nextId = 1
  private sessionId: string | undefined
  private closed = false

  constructor(private readonly config: McpServerConfig) {
    this.name = config.name
    if (!config.url) throw new Error(`connector "${config.name}" has no url`)
    if (config.transport === 'sse') {
      throw new Error(`connector "${config.name}" uses the legacy SSE transport, which elia does not support — ask the provider for a Streamable HTTP (\`/mcp\`) endpoint`)
    }
    this.url = config.url
    this.headers = { ...(config.headers ?? {}) }
  }

  async connect(): Promise<void> {
    const result = await this.rpc(
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO },
      CONNECT_TIMEOUT_MS,
      `connector "${this.name}" did not respond to initialize within ${CONNECT_TIMEOUT_MS}ms`,
    )
    void result
    await this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolsListResult> {
    const result = await this.rpc('tools/list', {}, CONNECT_TIMEOUT_MS, `connector "${this.name}" did not respond to tools/list`)
    return result as McpToolsListResult
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.rpc('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS, `connector "${this.name}" timed out calling tool "${name}"`)
    return result as McpToolCallResult
  }

  close(): void {
    this.closed = true
  }

  async closeAndWait(): Promise<void> {
    this.close()
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...this.headers,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    return headers
  }

  private async rpc(method: string, params: unknown, timeoutMs: number, timeoutMessage: string): Promise<unknown> {
    if (this.closed) throw new Error(`connector "${this.name}" is closed`)
    const id = this.nextId++
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    let response: Response
    try {
      response = await fetch(this.url, { method: 'POST', headers: this.buildHeaders(), body, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new Error(timeoutMessage)
      throw new Error(`connector "${this.name}" request failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const handedSession = response.headers.get('mcp-session-id')
    if (handedSession) this.sessionId = handedSession

    if (!response.ok) {
      const text = (await safeText(response)).slice(0, 300)
      throw new Error(`connector "${this.name}" returned HTTP ${response.status}${text ? `: ${text}` : ''}`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    const raw = await safeText(response)
    const message = contentType.includes('text/event-stream') ? extractSseResponse(raw, id) : parseJsonResponse(raw, id)
    if (!message) {
      // A notification (e.g. notifications/initialized) legitimately gets an empty 202 — only real requests demand a body.
      throw new Error(`connector "${this.name}" sent no JSON-RPC response for ${method}`)
    }
    if ('error' in message) throw new Error(`${message.error.message} (${message.error.code})`)
    return message.result
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      })
    } catch {
      // Best-effort — a notification expects no reply, and initialize already succeeded.
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function parseJsonResponse(raw: string, id: number): JsonRpcResponse | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  for (const entry of list) {
    if (isJsonRpcResponse(entry) && entry.id === id) return entry
  }
  return undefined
}

/** Pull the JSON-RPC response with the matching id out of an SSE body (`event:`/`data:` blocks). */
function extractSseResponse(raw: string, id: number): JsonRpcResponse | undefined {
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (!data) continue
    const found = parseJsonResponse(data, id)
    if (found) return found
  }
  return undefined
}
