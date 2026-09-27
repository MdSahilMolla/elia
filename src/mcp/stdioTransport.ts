import { mcpParseError, type JsonRpcResponse } from './protocol.ts'
import type { McpProtocolBackend, McpProtocolRequestOptions } from './protocol.ts'

const DEFAULT_MAX_LINE_BYTES = 1_048_576

type StdioChunk = Uint8Array | string
type StdioInput = ReadableStream<Uint8Array> | AsyncIterable<StdioChunk>
type StdioOutput = WritableStream<Uint8Array> | { write(chunk: Uint8Array): unknown }

export interface StdioTransportOptions {
  backend: McpProtocolBackend
  requestOptions: McpProtocolRequestOptions | ((message: unknown) => McpProtocolRequestOptions)
  input?: StdioInput
  output?: StdioOutput
  maxLineBytes?: number
  onError?: (error: unknown) => void
  signal?: AbortSignal
}

export interface McpStdioTransport {
  readonly closed: Promise<void>
  start: () => Promise<void>
  close: () => Promise<void>
}

function defaultInput(): StdioInput {
  return Bun.stdin.stream() as ReadableStream<Uint8Array>
}

function defaultOutput(): StdioOutput {
  return Bun.stdout as unknown as WritableStream<Uint8Array>
}

function isAsyncIterable(value: StdioInput): value is AsyncIterable<StdioChunk> {
  return Symbol.asyncIterator in value
}

function readChunks(input: StdioInput): AsyncIterable<StdioChunk> {
  if (isAsyncIterable(input)) return input
  const stream = input as ReadableStream<Uint8Array>
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader()
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          yield next.value
        }
      } finally {
        reader.releaseLock()
      }
    },
  }
}

function outputWriter(output: StdioOutput): (text: string) => Promise<void> {
  let queue = Promise.resolve()
  if ('getWriter' in output && typeof output.getWriter === 'function') {
    const writer = output.getWriter()
    return async (text) => {
      queue = queue.then(() => writer.write(new TextEncoder().encode(text))).then(() => undefined)
      await queue
    }
  }
  const sink = output as { write(chunk: Uint8Array): unknown }
  return async (text) => {
    queue = queue.then(async () => {
      await sink.write(new TextEncoder().encode(text))
    })
    await queue
  }
}

export function createStdioTransport(options: StdioTransportOptions): McpStdioTransport {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < 256 || maxLineBytes > 64 * 1_048_576) throw new Error('stdio maxLineBytes must be an integer from 256 to 67108864')
  const input = options.input ?? defaultInput()
  const write = outputWriter(options.output ?? defaultOutput())
  const abort = new AbortController()
  const inFlight = new Set<Promise<void>>()
  let closeRequested = false
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  let signalListener: (() => void) | undefined
  let processingError: unknown

  const report = (error: unknown): void => {
    processingError ??= error
    options.onError?.(error)
  }

  const send = async (response: JsonRpcResponse | JsonRpcResponse[]): Promise<void> => {
    try {
      await write(`${JSON.stringify(response)}\n`)
    } catch (error) {
      report(error)
    }
  }

  const dispatch = (value: unknown): Promise<void> => {
    const task = (async () => {
      try {
        const { handleMcpMessage } = await import('./protocol.ts')
        const requestOptions = typeof options.requestOptions === 'function' ? options.requestOptions(value) : options.requestOptions
        const response = await handleMcpMessage(value, options.backend, {
          ...requestOptions,
          signal: options.signal ?? abort.signal,
        })
        if (response !== undefined) await send(response)
      } catch (error) {
        report(error)
        await send(mcpParseError(error instanceof Error ? error.message : String(error)))
      }
    })()
    inFlight.add(task)
    void task.finally(() => inFlight.delete(task))
    return task
  }

  let remainder = new Uint8Array()
  let droppingOversizedLine = false
  const processChunk = (chunk: StdioChunk): void => {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    let start = 0
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 10) continue
      if (droppingOversizedLine) {
        droppingOversizedLine = false
        remainder = new Uint8Array()
        start = index + 1
        continue
      }
      const line = bytes.subarray(start, index)
      start = index + 1
      if (line.length > maxLineBytes) void send(mcpParseError(`stdio message exceeds ${maxLineBytes} bytes`))
      else if (line.length > 0) void dispatchSafely(new TextDecoder().decode(line))
    }
    if (droppingOversizedLine || start >= bytes.length) return
    const tail = bytes.subarray(start)
    const combined = new Uint8Array(remainder.length + tail.length)
    combined.set(remainder)
    combined.set(tail, remainder.length)
    if (combined.length > maxLineBytes) {
      remainder = new Uint8Array()
      droppingOversizedLine = true
      void send(mcpParseError(`stdio message exceeds ${maxLineBytes} bytes`))
    } else {
      remainder = combined
    }
  }

  const dispatchSafely = (line: string): Promise<void> => {
    if (line.length === 0) return Promise.resolve()
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      void send(mcpParseError(error instanceof Error ? error.message : String(error))
      )
      return Promise.resolve()
    }
    return dispatch(value)
  }

  const start = async (): Promise<void> => {
    signalListener = () => {
      void close()
    }
    if (options.signal) {
      if (options.signal.aborted) closeRequested = true
      else options.signal.addEventListener('abort', signalListener, { once: true })
    }
    const chunks = await readChunks(input)
    try {
      for await (const chunk of chunks) {
        if (closeRequested) break
        processChunk(chunk)
      }
      if (!closeRequested && remainder.length > 0 && !droppingOversizedLine) void dispatchSafely(new TextDecoder().decode(remainder))
      await Promise.all([...inFlight])
    } catch (error) {
      if (!closeRequested) report(error)
    } finally {
      if (options.signal && signalListener) options.signal.removeEventListener('abort', signalListener)
      resolveClosed()
    }
    if (processingError !== undefined && !closeRequested) throw processingError
  }

  const close = async (): Promise<void> => {
    if (closeRequested) return closed
    closeRequested = true
    abort.abort()
    await Promise.allSettled([...inFlight])
    resolveClosed()
    return closed
  }

  return { closed, start, close }
}

export async function startStdioTransport(options: StdioTransportOptions): Promise<McpStdioTransport> {
  const transport = createStdioTransport(options)
  void transport.start().catch((error: unknown) => options.onError?.(error))
  return transport
}
