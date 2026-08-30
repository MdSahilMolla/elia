export {}

const decoder = new TextDecoder()
let buffer = ''
let initialized = false
let nextTurn = 1

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(line: string): void {
  const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fixture' } })
    return
  }
  if (message.method === 'initialized') {
    initialized = true
    return
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32002, message: 'not initialized' } })
    return
  }
  if (message.method === 'model/list') {
    send({ id: message.id, result: { data: [{ model: 'fixture-model', displayName: 'Fixture Model' }] } })
    return
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-1' } } })
    return
  }
  if (message.method === 'turn/start') {
    const turnId = `turn-${nextTurn++}`
    const params = message.params ?? {}
    const input = Array.isArray(params.input) ? params.input[0] : undefined
    const text = input && typeof input === 'object' && 'text' in input ? String(input.text) : ''
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
    if (text === 'first') {
      send({ method: 'turn/plan/updated', params: { turnId, explanation: 'Build safely', plan: [{ step: 'Inspect files', status: 'inProgress' }] } })
      send({ method: 'item/started', params: { threadId: 'thread-1', turnId, item: { id: 'command-1', type: 'commandExecution', command: 'bun test', cwd: process.cwd(), status: 'inProgress' } } })
      send({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-1', turnId, itemId: 'command-1', delta: 'one line\npartial' } })
      send({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-1', turnId, itemId: 'command-1', delta: ' output\n' } })
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, item: { id: 'command-1', type: 'commandExecution', command: 'bun test', status: 'completed', exitCode: 0, durationMs: 25 } } })
      send({ method: 'item/started', params: { threadId: 'thread-1', turnId, item: { id: 'change-1', type: 'fileChange', status: 'inProgress', changes: [{ path: 'index.html', kind: 'add' }] } } })
      send({ method: 'turn/diff/updated', params: { threadId: 'thread-1', turnId, diff: '+++ index.html\n+<main>Elia</main>' } })
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, item: { id: 'change-1', type: 'fileChange', status: 'completed', changes: [{ path: 'index.html', kind: 'add', diff: '+<main>Elia</main>' }] } } })
      send({ method: 'model/rerouted', params: { threadId: 'thread-1', turnId, fromModel: 'fixture-model', toModel: 'fixture-fast', reason: 'capacity' } })
      send({ method: 'warning', params: { threadId: 'thread-1', turnId, message: 'fixture warning' } })
    }
    send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId, itemId: 'reasoning-1', delta: 'checking' } })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, itemId: 'message-1', delta: `done:${text}` } })
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId,
        tokenUsage: { last: { inputTokens: 15, cachedInputTokens: 5, cacheWriteInputTokens: 2, outputTokens: 4 } },
      },
    })
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] } } })
    return
  }
  send({ id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } })
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let newline: number
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(line)
  }
}
