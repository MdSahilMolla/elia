import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mcpParseError } from './protocol.ts'
import { handleMcpMessage, initializeProtocolVersion, MCP_PROTOCOL_VERSION } from './protocol.ts'
import type {
  McpClientCapabilities,
  McpProgressEvent,
  McpToolExecutionContext,
} from './serverTypes.ts'
import type { McpProtocolBackend, McpProtocolRequestOptions } from './protocol.ts'

const DEFAULT_MAX_BODY_BYTES = 4_194_304
const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const MAX_SESSIONS = 1_000

export interface HttpMcpTransportOptions {
  backend: McpProtocolBackend
  requestOptions: McpProtocolRequestOptions
  token: string
  host?: string
  port?: number
  maxBodyBytes?: number
  allowRemoteHost?: boolean
  getRunStatus?: (runId: string, context: McpToolExecutionContext) => unknown | Promise<unknown>
  subscribeProgress?: (listener: (event: McpProgressEvent) => void) => () => void
  onError?: (error: unknown) => void
}

export interface McpHttpServer {
  readonly url: URL
  readonly hostname: string
  readonly port: number
  stop: (closeActiveConnections?: boolean) => void
}

class RequestBodyError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RequestBodyError'
    this.status = status
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function emptyError(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true
}

function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length > 256) return false
  const providedHash = createHash('sha256').update(provided).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedHash, expectedHash)
}

function isAuthorized(request: Request, expectedToken: string): boolean {
  const authorization = request.headers.get('authorization')
  if (!authorization) return false
  const match = /^Bearer ([^\s,]+)$/.exec(authorization)
  return match !== null && tokenMatches(match[1]!, expectedToken)
}

async function readJsonBody(request: Request, maxBodyBytes: number): Promise<unknown> {
  if (!isJsonContentType(request.headers.get('content-type'))) throw new RequestBodyError(415, 'Content-Type must be application/json')
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (!Number.isInteger(declared) || declared < 0) throw new RequestBodyError(400, 'Invalid Content-Length')
    if (declared > maxBodyBytes) throw new RequestBodyError(413, `MCP request body exceeds ${maxBodyBytes} bytes`)
  }
  if (!request.body) throw new RequestBodyError(400, 'MCP request body is required')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel()
        throw new RequestBodyError(413, `MCP request body exceeds ${maxBodyBytes} bytes`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (body.length === 0) throw new RequestBodyError(400, 'MCP request body is empty')
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch (error) {
    throw new RequestBodyError(400, error instanceof Error ? error.message : 'Invalid JSON')
  }
}

function clientCapabilities(message: unknown): McpClientCapabilities | undefined {
  const single = Array.isArray(message) ? message.find((entry) => isRecord(entry) && entry.method === 'initialize') : message
  if (!isRecord(single) || single.method !== 'initialize' || !isRecord(single.params) || !isRecord(single.params.capabilities)) return undefined
  return single.params.capabilities as McpClientCapabilities
}

interface McpSessionState {
  clientCapabilities: McpClientCapabilities
  protocolVersion: string
}

function requestSessionId(request: Request, sessions: Map<string, McpSessionState>): { id: string; created: boolean; valid: boolean } {
  const supplied = request.headers.get('mcp-session-id')
  if (supplied !== null) {
    if (!SESSION_PATTERN.test(supplied)) return { id: supplied, created: false, valid: false }
    return { id: supplied, created: false, valid: sessions.has(supplied) }
  }
  const id = randomUUID()
  sessions.set(id, { clientCapabilities: {}, protocolVersion: MCP_PROTOCOL_VERSION })
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined
    if (!oldest) break
    sessions.delete(oldest)
  }
  return { id, created: true, valid: true }
}

function sseEvent(value: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(value)}\n\n`)
}

function progressMessage(event: McpProgressEvent): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'notifications/progress', params: event }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function createHttpMcpTransport(options: HttpMcpTransportOptions): McpHttpServer {
  if (!options.token) throw new Error('HTTP MCP transport requires an authentication token')
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 3284
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 64 * 1_048_576) throw new Error('HTTP MCP maxBodyBytes must be an integer from 1024 to 67108864')
  if (!isLoopbackHost(host) && options.allowRemoteHost !== true) throw new Error('Remote MCP binding requires an explicit remote-host override')
  const sessions = new Map<string, McpSessionState>()

  const handleMcp = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === '/runs' || url.pathname.startsWith('/runs/')) {
      if (!isAuthorized(request, options.token)) return emptyError(401, 'Unauthorized', { 'www-authenticate': 'Bearer' })
      const match = /^\/runs\/([^/]+)\/status$/.exec(url.pathname)
      if (!match || request.method !== 'GET') return emptyError(404, 'Not found')
      const runId = decodeURIComponent(match[1]!)
      if (!RUN_ID_PATTERN.test(runId)) return emptyError(400, 'Invalid run id')
      if (!options.getRunStatus) return emptyError(404, 'Not found')
      try {
        const result = await options.getRunStatus(runId, options.requestOptions.context)
        return jsonResponse({ runId, status: result })
      } catch (error) {
        options.onError?.(error)
        return emptyError(404, 'Run not found')
      }
    }
    if (url.pathname !== '/mcp') return emptyError(404, 'Not found')
    if (!isAuthorized(request, options.token)) return emptyError(401, 'Unauthorized', { 'www-authenticate': 'Bearer' })
    const session = requestSessionId(request, sessions)
    if (!session.valid) return emptyError(404, 'MCP session not found', { 'mcp-session-id': session.id })
    const sessionHeaders = { 'mcp-session-id': session.id }
    if (request.method === 'DELETE') {
      sessions.delete(session.id)
      return new Response(null, { status: 204, headers: sessionHeaders })
    }
    if (request.method === 'GET') {
      const accept = request.headers.get('accept') ?? ''
      if (!accept.split(',').some((entry) => {
        const mediaType = entry.trim().split(';', 1)[0]?.toLowerCase()
        return mediaType === 'text/event-stream' || mediaType === 'text/*' || mediaType === '*/*'
      })) {
        return emptyError(406, 'Accept must include text/event-stream', sessionHeaders)
      }
      let unsubscribe: (() => void) | undefined
      let keepAlive: ReturnType<typeof setInterval> | undefined
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': connected\n\n'))
          if (options.subscribeProgress) {
            unsubscribe = options.subscribeProgress((event) => {
              try {
                controller.enqueue(sseEvent(progressMessage(event)))
              } catch {
                unsubscribe?.()
              }
            })
          }
          keepAlive = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(': keepalive\n\n'))
            } catch {
              if (keepAlive) clearInterval(keepAlive)
            }
          }, 15_000)
          request.signal.addEventListener('abort', () => {
            if (keepAlive) clearInterval(keepAlive)
            unsubscribe?.()
            try {
              controller.close()
            } catch {}
          }, { once: true })
        },
        cancel() {
          if (keepAlive) clearInterval(keepAlive)
          unsubscribe?.()
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          ...sessionHeaders,
        },
      })
    }
    if (request.method !== 'POST') return emptyError(405, 'Method not allowed', { allow: 'GET, POST, DELETE', ...sessionHeaders })
    let message: unknown
    try {
      message = await readJsonBody(request, maxBodyBytes)
    } catch (error) {
      if (error instanceof RequestBodyError) return jsonResponse(mcpParseError(error.message), error.status, sessionHeaders)
      options.onError?.(error)
      return jsonResponse(mcpParseError('Unable to read MCP request'), 500, sessionHeaders)
    }
    const capabilities = clientCapabilities(message)
    const version = initializeProtocolVersion(message)
    const existing = sessions.get(session.id)
    const state: McpSessionState = {
      clientCapabilities: capabilities ?? existing?.clientCapabilities ?? {},
      protocolVersion: version ?? existing?.protocolVersion ?? MCP_PROTOCOL_VERSION,
    }
    sessions.set(session.id, state)
    const requestOptions: McpProtocolRequestOptions = {
      ...options.requestOptions,
      clientCapabilities: state.clientCapabilities,
      protocolVersion: state.protocolVersion,
      signal: request.signal,
    }
    const accept = request.headers.get('accept') ?? ''
    if (accept.split(',').some((entry) => entry.trim().startsWith('text/event-stream'))) {
      let eventQueue = Promise.resolve()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: McpProgressEvent): void => {
            eventQueue = eventQueue.then(async () => {
              controller.enqueue(sseEvent(progressMessage(event)))
            }).catch((error: unknown) => options.onError?.(error))
          }
          void handleMcpMessage(message, options.backend, { ...requestOptions, context: { ...requestOptions.context, emit } })
            .then((response) => {
              if (response !== undefined) eventQueue = eventQueue.then(async () => {
                controller.enqueue(sseEvent(response))
              })
            })
            .catch((error: unknown) => options.onError?.(error))
            .finally(async () => {
              await eventQueue
              try {
                controller.close()
              } catch {}
            })
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          ...sessionHeaders,
        },
      })
    }
    try {
      const response = await handleMcpMessage(message, options.backend, requestOptions)
      if (response === undefined) return new Response(null, { status: 202, headers: sessionHeaders })
      return jsonResponse(response, 200, sessionHeaders)
    } catch (error) {
      options.onError?.(error)
      return jsonResponse(mcpParseError(error instanceof Error ? error.message : String(error)), 500, sessionHeaders)
    }
  }

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: handleMcp,
    maxRequestBodySize: maxBodyBytes,
    development: false,
  })
  return {
    url: new URL(server.url),
    hostname: host,
    port,
    stop: (closeActiveConnections = true) => server.stop(closeActiveConnections),
  }
}

export function startHttpMcpTransport(options: HttpMcpTransportOptions): McpHttpServer {
  return createHttpMcpTransport(options)
}
