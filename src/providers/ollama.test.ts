import { afterEach, beforeEach, expect, test } from 'bun:test'
import { clearDeclaredContextWindows, compactionThresholdFor, contextWindowFor } from '../contextWindow.ts'
import { estimateCostUsd } from '../usage.ts'
import { classifyProbeError, probeModel } from './probe.ts'
import { withActiveMode } from '../autonomy/mode.ts'
import {
  acquireOllamaSlot,
  assertOllamaHost,
  chooseNumCtx,
  createOllamaProvider,
  DEFAULT_NUM_CTX,
  describeOllamaModel,
  detectOllama,
  kvBytesPerToken,
  LOCAL_MODEL_OMITTED_TOOLS,
  MAX_AUTO_NUM_CTX,
  memoryFitNumCtx,
  ollamaHost,
  ollamaKeepAlive,
  ollamaModelWarning,
  ollamaOmittedTools,
  ollamaParallelSlots,
  parseShow,
  rankOllamaModels,
  resetOllamaDetection,
  toOllamaMessages,
} from './ollama.ts'
import type { ChatMessage, ContentBlock } from './types.ts'

/**
 * A fake Ollama: `/api/tags`, `/api/show` and a streaming `/api/chat`, on a
 * real socket, so the adapter's HTTP and NDJSON handling are what is tested.
 */
interface FakeModel {
  name: string
  capabilities?: string[]
  contextLength?: number
}

let server: ReturnType<typeof Bun.serve> | undefined
let requests: Array<{ path: string; body: Record<string, unknown> }>
const ENV_KEYS = ['OLLAMA_HOST', 'OLLAMA_API_KEY', 'ELIA_OLLAMA_NUM_CTX', 'ELIA_OLLAMA_DETECT', 'ELIA_STREAM_IDLE_MS', 'ELIA_OLLAMA_KEEP_ALIVE', 'ELIA_OLLAMA_TOOLS', 'OLLAMA_NUM_PARALLEL'] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  requests = []
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  resetOllamaDetection()
  clearDeclaredContextWindows()
})

afterEach(() => {
  server?.stop(true)
  server = undefined
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearDeclaredContextWindows()
})

function startFake(models: FakeModel[], chat: (body: Record<string, unknown>) => Response | object[] = () => [{ message: { role: 'assistant', content: 'ok' }, done: true }]): string {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {}
      requests.push({ path, body })
      if (path === '/api/tags') {
        return Response.json({ models: models.map((model) => ({ name: model.name, model: model.name, size: 5_200_000_000, details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M', family: 'qwen3' } })) })
      }
      if (path === '/api/show') {
        const model = models.find((candidate) => candidate.name === body.model)
        if (!model) return Response.json({ error: `model '${String(body.model)}' not found` }, { status: 404 })
        return Response.json({
          ...(model.capabilities ? { capabilities: model.capabilities } : {}),
          model_info: { 'general.architecture': 'qwen3', ...(model.contextLength ? { 'qwen3.context_length': model.contextLength } : {}) },
        })
      }
      if (path === '/api/chat') {
        const known = models.some((candidate) => candidate.name === body.model)
        if (!known) return Response.json({ error: `model "${String(body.model)}" not found, try pulling it first` }, { status: 404 })
        const reply = chat(body)
        if (reply instanceof Response) return reply
        return new Response(reply.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''), { headers: { 'Content-Type': 'application/x-ndjson' } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return `http://127.0.0.1:${server.port}`
}

/** A port nothing listens on: bind one, then let it go. */
function closedPort(): string {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const url = `http://127.0.0.1:${probe.port}`
  probe.stop(true)
  return url
}

const USER: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'read a.ts' }] }]

function streamParams(overrides: Partial<Parameters<ReturnType<typeof createOllamaProvider>['streamTurn']>[0]> = {}) {
  const text: string[] = []
  const thinking: string[] = []
  const blocks: ContentBlock[] = []
  return {
    text,
    thinking,
    blocks,
    params: {
      cwd: process.cwd(),
      system: 'You are elia.',
      messages: USER,
      tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } }],
      onText: (delta: string) => text.push(delta),
      onThinking: (delta: string) => thinking.push(delta),
      onToolBlock: (block: ContentBlock) => blocks.push(block),
      ...overrides,
    },
  }
}

test('OLLAMA_HOST is read the way Ollama reads it', () => {
  expect(ollamaHost({})).toBe('http://127.0.0.1:11434')
  expect(ollamaHost({ OLLAMA_HOST: '0.0.0.0' })).toBe('http://127.0.0.1:11434')
  expect(ollamaHost({ OLLAMA_HOST: '0.0.0.0:8080' })).toBe('http://127.0.0.1:8080')
  expect(ollamaHost({ OLLAMA_HOST: 'localhost:11500' })).toBe('http://localhost:11500')
  expect(ollamaHost({ OLLAMA_HOST: 'http://127.0.0.1:80' })).toBe('http://127.0.0.1')
  expect(ollamaHost({ OLLAMA_HOST: 'https://ollama.example.com' })).toBe('https://ollama.example.com')
  expect(ollamaHost({ OLLAMA_HOST: 'https://gpu.example.com/ollama/' })).toBe('https://gpu.example.com/ollama')
})

test('plain HTTP is allowed only to this machine; a remote server must use HTTPS', () => {
  expect(() => assertOllamaHost('http://127.0.0.1:11434')).not.toThrow()
  expect(() => assertOllamaHost('http://localhost:11434')).not.toThrow()
  expect(() => assertOllamaHost('https://ollama.example.com')).not.toThrow()
  expect(() => assertOllamaHost('http://ollama.example.com:11434')).toThrow('insecure')
  expect(() => assertOllamaHost('http://192.168.1.20:11434')).toThrow()
})

test('detection lists the local models, and asks each what it can do', async () => {
  const host = startFake([
    { name: 'qwen3:8b', capabilities: ['completion', 'tools', 'thinking'], contextLength: 40_960 },
    { name: 'gemma3:4b', capabilities: ['completion', 'vision'], contextLength: 131_072 },
    { name: 'tinyllama:latest', capabilities: ['completion', 'tools'], contextLength: 2_048 },
  ])
  const detection = await detectOllama({ host, details: true })
  expect(detection.running).toBe(true)
  expect(detection.models.map((model) => model.name)).toEqual(['gemma3:4b', 'qwen3:8b', 'tinyllama:latest'])
  const qwen = detection.models.find((model) => model.name === 'qwen3:8b')!
  expect(qwen.capabilities).toContain('tools')
  expect(qwen.contextLength).toBe(40_960)

  // What elia can actually use comes first; what it cannot is said plainly.
  expect(rankOllamaModels(detection.models).map((model) => model.name)).toEqual(['qwen3:8b', 'gemma3:4b', 'tinyllama:latest'])
  expect(describeOllamaModel(qwen)).toBe('8.2B · Q4_K_M · 4.8 GB · tools · thinking · 40k context')
  expect(describeOllamaModel(detection.models.find((model) => model.name === 'gemma3:4b')!)).toContain('no tool calling')
  expect(ollamaModelWarning(qwen)).toBeUndefined()
  expect(ollamaModelWarning(detection.models.find((model) => model.name === 'gemma3:4b')!)).toContain('cannot call tools')
  expect(ollamaModelWarning(detection.models.find((model) => model.name === 'tinyllama:latest')!)).toContain('less than elia')
})

test('a server that is not there is reported as not running, with what to do', async () => {
  const host = closedPort()
  const detection = await detectOllama({ host })
  expect(detection.running).toBe(false)
  expect(detection.error).toContain('ollama serve')

  const empty = startFake([])
  const none = await detectOllama({ host: empty })
  expect(none.running).toBe(true)
  expect(none.error).toContain('ollama pull')

  expect((await detectOllama({ host: empty, env: { ELIA_OLLAMA_DETECT: 'off' } })).running).toBe(false)
})

test('a chat streams text, thinking and tool calls, and runs at a window that holds the prompt', async () => {
  const host = startFake([{ name: 'qwen3:8b', capabilities: ['completion', 'tools', 'thinking'], contextLength: 40_960 }], () => [
    { message: { role: 'assistant', content: '', thinking: 'The user wants a.ts. ' } },
    { message: { role: 'assistant', content: 'Reading ' } },
    { message: { role: 'assistant', content: 'it.' } },
    { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] } },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 812, eval_count: 31 },
  ])
  const provider = createOllamaProvider('qwen3:8b', host)
  const { params, text, thinking, blocks } = streamParams()
  const result = await provider.streamTurn(params)

  expect(text.join('')).toBe('Reading it.')
  expect(thinking.join('')).toBe('The user wants a.ts. ')
  expect(blocks).toHaveLength(1)
  expect(result.content.map((block) => block.type)).toEqual(['thinking', 'text', 'tool_use'])
  const call = result.content.find((block) => block.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>
  expect(call.name).toBe('read_file')
  expect(call.input).toEqual({ path: 'a.ts' })
  expect(result.usage).toEqual({ inputTokens: 812, outputTokens: 31, cacheReadTokens: 0, cacheWriteTokens: 0 })

  const chat = requests.find((request) => request.path === '/api/chat')!.body
  // The model's own 40k, under the 32k cap — so the cap wins.
  expect((chat.options as { num_ctx: number }).num_ctx).toBe(DEFAULT_NUM_CTX)
  expect(chat.think).toBe(true)
  expect(chat.stream).toBe(true)
  expect((chat.tools as Array<{ function: { name: string } }>)[0]!.function.name).toBe('read_file')
  // And compaction plans for the window that is really there.
  expect(contextWindowFor('qwen3:8b')).toBe(DEFAULT_NUM_CTX)
  expect(compactionThresholdFor('qwen3:8b')).toBeLessThan(DEFAULT_NUM_CTX - 17_000)
  // A model on this machine has no API price: $0, not "cost unknown".
  expect(estimateCostUsd('qwen3:8b', result.usage, process.cwd())).toBe(0)
})

test('a small model runs at its own maximum, `think` is never sent to a model without it, and the window can be set', async () => {
  const host = startFake([{ name: 'llama3.2:3b', capabilities: ['completion', 'tools'], contextLength: 16_384 }])
  await createOllamaProvider('llama3.2:3b', host).streamTurn(streamParams().params)
  const chat = requests.find((request) => request.path === '/api/chat')!.body
  expect((chat.options as { num_ctx: number }).num_ctx).toBe(16_384)
  expect('think' in chat).toBe(false)
  expect(contextWindowFor('llama3.2:3b')).toBe(16_384)

  expect(chooseNumCtx(131_072, { ELIA_OLLAMA_NUM_CTX: '65536' })).toBe(65_536)
  expect(chooseNumCtx(undefined, {})).toBe(DEFAULT_NUM_CTX)
  expect(chooseNumCtx(8_192, { ELIA_OLLAMA_NUM_CTX: 'lots' })).toBe(8_192)
})

test('a model that is not pulled, a stopped server and a mid-stream error each say what went wrong', async () => {
  const host = startFake([{ name: 'qwen3:8b', capabilities: ['tools'] }], () => [
    { message: { role: 'assistant', content: 'par' } },
    { error: 'model runner has unexpectedly stopped' },
  ])
  const missing = createOllamaProvider('llama9:70b', host)
  const notPulled = await missing.streamTurn(streamParams().params).catch((error: Error) => error.message)
  expect(notPulled).toContain('ollama pull llama9:70b')
  expect(classifyProbeError(String(notPulled))).toBe('not_found')

  const midStream = await createOllamaProvider('qwen3:8b', host).streamTurn(streamParams().params).catch((error: Error) => error.message)
  expect(midStream).toContain('unexpectedly stopped')

  const stopped = await createOllamaProvider('qwen3:8b', closedPort()).streamTurn(streamParams().params).catch((error: Error) => error.message)
  expect(stopped).toContain('Ollama is not running')
})

test('the model probe /model runs gets a real answer through the adapter', async () => {
  const host = startFake([{ name: 'qwen3:8b', capabilities: ['completion', 'tools'] }])
  const probe = await probeModel(createOllamaProvider('qwen3:8b', host), { timeoutMs: 10_000 })
  expect(probe.ok).toBe(true)
  // The probe offers no tools, and none are sent.
  expect('tools' in requests.find((request) => request.path === '/api/chat')!.body).toBe(false)
})

test('history converts to Ollama messages: results answer their call, by name, before any new text', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'private', signature: '' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'ollama_1_0', name: 'read_file', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'ollama_1_0', content: 'export const a = 1', is_error: false },
        { type: 'text', text: 'also check b.ts' },
      ],
    },
  ]
  expect(toOllamaMessages('sys', messages)).toEqual([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'look', images: ['iVBORw0KGgo='] },
    { role: 'assistant', content: 'Reading.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] },
    { role: 'tool', content: 'export const a = 1', tool_name: 'read_file' },
    { role: 'user', content: 'also check b.ts' },
  ])
})

test('/api/show is read for capabilities and the context length, whatever the architecture', () => {
  expect(parseShow({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 131_072, 'llama.embedding_length': 4096 } })).toEqual({
    capabilities: ['completion', 'tools'],
    contextLength: 131_072,
  })
  // An older server reports no capabilities: unknown, not "no tools".
  expect(parseShow({ model_info: {} })).toEqual({})
})

const GIB = 1024 ** 3

test('the KV cost of a token is read off the attention shape, counting only the layers that have attention', () => {
  // qwen3.5:9b as Ollama reports it: attention on every fourth of 32 layers, 4 KV heads of 256.
  const qwen35 = {
    'general.architecture': 'qwen35',
    'qwen35.block_count': 32,
    'qwen35.attention.head_count': 16,
    'qwen35.attention.key_length': 256,
    'qwen35.attention.value_length': 256,
    'qwen35.embedding_length': 4096,
    'qwen35.full_attention_interval': 4,
    'qwen35.attention.head_count_kv': Array.from({ length: 32 }, (_, layer) => (layer % 4 === 3 ? 4 : 0)),
  }
  expect(kvBytesPerToken(qwen35)).toBe(8 * 4 * 512 * 2)
  // llama3.1:8b: 32 layers, 8 KV heads, head size from the embedding.
  expect(kvBytesPerToken({ 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096 })).toBe(32 * 8 * 256 * 2)
  expect(kvBytesPerToken({ 'general.architecture': 'llama', 'llama.block_count': 32 })).toBeUndefined()
  expect(parseShow({ model_info: qwen35 }).kvBytesPerToken).toBe(32_768)
})

test('the window grows to what unified memory holds beside the model, and never shrinks below the default', () => {
  const qwen = { kvBytesPerToken: 32_768, modelBytes: 6.6e9, unifiedMemory: true }
  // 16 GB: two thirds for the GPU, less the model and 2 GB of buffers, leaves ~2 GB of KV.
  const fit16 = memoryFitNumCtx({ ...qwen, totalMemoryBytes: 16 * GIB })!
  expect(fit16).toBeGreaterThan(DEFAULT_NUM_CTX)
  expect(fit16 % 8_192).toBe(0)
  expect(fit16 * 32_768 + 6.6e9 + 2 * GIB).toBeLessThanOrEqual(16 * GIB * 0.66)
  expect(chooseNumCtx(262_144, {}, fit16)).toBe(fit16)
  // Plenty of memory: capped, and never past the model's own maximum.
  expect(chooseNumCtx(262_144, {}, memoryFitNumCtx({ ...qwen, totalMemoryBytes: 64 * GIB }))).toBe(MAX_AUTO_NUM_CTX)
  expect(chooseNumCtx(40_960, {}, memoryFitNumCtx({ ...qwen, totalMemoryBytes: 64 * GIB }))).toBe(40_960)
  // Tight memory keeps today's default rather than starving the prompt.
  expect(chooseNumCtx(262_144, {}, memoryFitNumCtx({ ...qwen, totalMemoryBytes: 8 * GIB }))).toBe(DEFAULT_NUM_CTX)
  // Unknowns assume nothing: a discrete GPU, an unreported shape, an unknown size.
  expect(memoryFitNumCtx({ ...qwen, totalMemoryBytes: 64 * GIB, unifiedMemory: false })).toBeUndefined()
  expect(memoryFitNumCtx({ ...qwen, totalMemoryBytes: 64 * GIB, kvBytesPerToken: undefined })).toBeUndefined()
  expect(memoryFitNumCtx({ ...qwen, totalMemoryBytes: 64 * GIB, modelBytes: undefined })).toBeUndefined()
  // The override still wins.
  expect(chooseNumCtx(262_144, { ELIA_OLLAMA_NUM_CTX: '16384' }, fit16)).toBe(16_384)
})

test('the model stays loaded between turns, for 30 minutes unless told otherwise', async () => {
  expect(ollamaKeepAlive({})).toBe('30m')
  expect(ollamaKeepAlive({ ELIA_OLLAMA_KEEP_ALIVE: '2h' })).toBe('2h')
  expect(ollamaKeepAlive({ ELIA_OLLAMA_KEEP_ALIVE: '-1' })).toBe(-1)
  const host = startFake([{ name: 'qwen3:8b', capabilities: ['completion', 'tools'], contextLength: 40_960 }])
  await createOllamaProvider('qwen3:8b', host).streamTurn(streamParams().params)
  expect(requests.find((request) => request.path === '/api/chat')!.body.keep_alive).toBe('30m')
})

test('requests to one server take turns, and time spent queued is not a stall', async () => {
  expect(ollamaParallelSlots({})).toBe(1)
  expect(ollamaParallelSlots({ OLLAMA_NUM_PARALLEL: '3' })).toBe(3)
  let inFlight = 0
  let peak = 0
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/api/show') return Response.json({ capabilities: ['completion', 'tools'], model_info: {} })
      if (path !== '/api/chat') return new Response('not found', { status: 404 })
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(150)
      inFlight--
      return new Response(`${JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true })}\n`)
    },
  })
  // Each request takes 150ms; a stall timer shorter than two of them must not fire on the queued one.
  process.env.ELIA_STREAM_IDLE_MS = '250'
  const provider = createOllamaProvider('qwen3:8b', `http://127.0.0.1:${server.port}`)
  const results = await Promise.all([1, 2, 3].map(() => provider.streamTurn(streamParams().params)))
  expect(results.map((result) => (result.content[0] as { text: string }).text)).toEqual(['ok', 'ok', 'ok'])
  expect(peak).toBe(1)
})

test('a request waiting for a slot can be cancelled, and gives its place up', async () => {
  const host = 'http://slot-test'
  const releaseFirst = await acquireOllamaSlot(host, 1)
  const controller = new AbortController()
  const waiting = acquireOllamaSlot(host, 1, controller.signal)
  controller.abort(new Error('stopped'))
  await expect(waiting).rejects.toThrow('stopped')
  releaseFirst()
  // The slot is free again, not held by the cancelled waiter.
  const again = await acquireOllamaSlot(host, 1)
  again()
})

test('in dev mode a local model is offered the core tools, not the specialist ones', async () => {
  await withActiveMode('dev', async () => {
    expect(ollamaOmittedTools({}).has('github')).toBe(true)
    for (const core of ['read_file', 'write_file', 'edit_file', 'grep', 'list_files', 'run_command', 'todo_write', 'brain', 'web_search']) expect(ollamaOmittedTools({}).has(core)).toBe(false)
    expect(ollamaOmittedTools({ ELIA_OLLAMA_TOOLS: 'full' }).size).toBe(0)
  })
  // Other modes are built on their specialist tools.
  await withActiveMode('fitness', async () => expect(ollamaOmittedTools({}).size).toBe(0))
  expect(LOCAL_MODEL_OMITTED_TOOLS.has('read_file')).toBe(false)
})
