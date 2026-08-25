/**
 * A minimal LSP server over stdio, used only by lsp/*.test.ts to exercise the
 * real client against a real subprocess and real Content-Length framing
 * instead of a mocked transport. On every didOpen/didChange it publishes one
 * diagnostic if the document text contains the literal marker "ERROR_MARKER",
 * otherwise publishes an empty diagnostics list — enough to cover both the
 * "found a problem" and "clean" paths.
 */
export {}

let buffer = Buffer.alloc(0)

function send(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  process.stdout.write(Buffer.concat([header, body]))
}

function publishFor(uri: string, text: string): void {
  const diagnostics = text.includes('ERROR_MARKER')
    ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'found ERROR_MARKER' }]
    : []
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } })
}

function handle(message: { id?: number; method?: string; params?: Record<string, unknown> }): void {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
    return
  }
  if (message.method === 'initialized') return
  if (message.method === 'textDocument/didOpen') {
    const doc = message.params?.textDocument as { uri: string; text: string }
    publishFor(doc.uri, doc.text)
    return
  }
  if (message.method === 'textDocument/didChange') {
    const doc = message.params?.textDocument as { uri: string }
    const change = (message.params?.contentChanges as { text: string }[])[0]
    publishFor(doc.uri, change?.text ?? '')
    return
  }
  if (typeof message.id === 'number') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
  }
}

function drain(): void {
  while (true) {
    const text = buffer.toString('latin1')
    const headerEnd = text.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(text.slice(0, headerEnd))
    if (!lengthMatch) {
      buffer = Buffer.alloc(0)
      return
    }
    const contentLength = Number(lengthMatch[1])
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + contentLength) return
    const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
    buffer = buffer.subarray(bodyStart + contentLength)
    try {
      handle(JSON.parse(body))
    } catch {
      // ignore malformed frames
    }
  }
}

for await (const chunk of process.stdin) {
  buffer = Buffer.concat([buffer, chunk as Uint8Array])
  drain()
}
