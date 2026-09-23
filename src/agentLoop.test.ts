import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConversationMessage } from './agentLoop.ts'
import type { ContentBlock, ProviderActivity } from './providers/types.ts'
import type { Tool } from './tools/types.ts'
import { createActionGovernor, withActionGovernor } from './autonomy/governor.ts'
import { parseToolHooks, withToolHooks } from './autonomy/devHooks.ts'
import { createTranscript, withSessionTranscript } from './ui/transcript.ts'
import { withAgentIdentity } from './autonomy/context.ts'
import { ZERO_USAGE, onLiveOutput, type LiveOutput } from './usage.ts'
import { createToolResultCache } from './speculation/cache.ts'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads; we swap in a stub
// provider below so no real network call ever happens.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-agentloop-test'

const { config } = await import('./config.ts')
const { resetProviderHealthForTests, runAgentLoop, toolBatchConcurrency, DEFAULT_PARALLEL_TOOLS, lastAssistantText } = await import('./agentLoop.ts')
const { resetCodexSubscriptionApprovalForTests } = await import('./providers/codexSubscription.ts')

test('session recording captures nested agent tools and provider activity without crossing session boundaries', async () => {
  const transcript = createTranscript()
  const outside = createTranscript()
  let call = 0
  let childCall = 0
  const inner = () => withAgentIdentity({ name: 'scout#1', role: 'scout' }, () => runAgentLoop({
    messages: [], systemPrompt: 'test', providerName: 'anthropic', model: 'recording-test', useAnimation: false, verbose: false,
    tools: [{ name: 'grep', description: 'Test child read', input_schema: { type: 'object', properties: {} }, async execute() { return 'Child search result' } }],
    provider: { async streamTurn(params) {
      if (++childCall === 1) return { content: [{ type: 'tool_use', id: 'child-1', name: 'grep', input: { pattern: 'parser' } }], usage: ZERO_USAGE }
      params.onActivity?.({ kind: 'file_change', title: 'Changed parser', detail: 'src/parser.ts\n+ fix' })
      params.onText('Child report')
      return { content: [{ type: 'text', text: 'Child report' }], usage: ZERO_USAGE }
    } },
  }))
  await Promise.all([
    withSessionTranscript(transcript, () => runAgentLoop({
      messages: [], systemPrompt: 'test', providerName: 'anthropic', model: 'recording-test', useAnimation: false, verbose: false,
      tools: [{ name: 'read_file', description: 'Test nested work', input_schema: { type: 'object', properties: {} }, async execute() { await inner(); return 'nested result' } }],
      provider: { async streamTurn(params) {
        call += 1
        if (call === 1) return { content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'test.ts' } }], usage: ZERO_USAGE }
        params.onText('Lead reply')
        return { content: [{ type: 'text', text: 'Lead reply' }], usage: ZERO_USAGE }
      } },
    })),
    withSessionTranscript(outside, async () => { await Promise.resolve(); outside.appendAssistant('Other session') }),
  ])
  expect(transcript.toolCount()).toBe(2)
  expect(transcript.tool(0)?.actor).toBe('scout#1')
  const saved = JSON.stringify(transcript.snapshot())
  expect(saved).toContain('nested result')
  expect(saved).toContain('[scout#1] Child report')
  expect(saved).toContain('Changed parser')
  expect(saved).not.toContain('Other session')
  expect(transcript.items().filter((item) => item.kind === 'assistant' && item.text === 'Lead reply')).toHaveLength(1)
})

test('session recording keeps partial replies when a provider fails midstream', async () => {
  const transcript = createTranscript()
  await expect(withSessionTranscript(transcript, () => runAgentLoop({
    messages: [], systemPrompt: 'test', tools: [], providerName: 'anthropic', model: 'partial-recording-test', useAnimation: false, verbose: false,
    provider: { async streamTurn(params) { params.onText('Partial explanation'); throw new Error('stream interrupted') } },
  }))).rejects.toThrow('stream interrupted')
  expect(transcript.toMarkdown()).toContain('Partial explanation')
})

test('safe read-only tool batches use bounded fast concurrency while mutating batches stay conservative', () => {
  const original = process.env.ELIA_TOOL_CONCURRENCY
  try {
    delete process.env.ELIA_TOOL_CONCURRENCY
    // Unconfigured, a read-only batch gets the CPU-derived default (4 on a
    // 4-core box, wider on bigger machines, hard-capped at 8).
    expect(DEFAULT_PARALLEL_TOOLS).toBeGreaterThanOrEqual(4)
    expect(DEFAULT_PARALLEL_TOOLS).toBeLessThanOrEqual(8)
    expect(toolBatchConcurrency([{ name: 'read_file', input: { path: 'src/a.ts' } }, { name: 'grep', input: { pattern: 'x' } }])).toBe(DEFAULT_PARALLEL_TOOLS)
    expect(toolBatchConcurrency([{ name: 'read_file', input: { path: 'src/a.ts' } }, { name: 'read_file', input: { path: 'src/b.ts' } }, { name: 'read_file', input: { path: 'src/c.ts' } }, { name: 'read_file', input: { path: 'src/d.ts' } }, { name: 'read_file', input: { path: 'src/e.ts' } }])).toBe(DEFAULT_PARALLEL_TOOLS)
    // Any write in the batch pins it to the conservative ceiling regardless of cores.
    expect(toolBatchConcurrency([{ name: 'write_file', input: { path: 'src/a.ts' } }, { name: 'read_file', input: { path: 'src/b.ts' } }])).toBe(4)
    process.env.ELIA_TOOL_CONCURRENCY = '99'
    expect(toolBatchConcurrency([{ name: 'read_file', input: { path: 'src/a.ts' } }])).toBe(8)
    expect(toolBatchConcurrency([{ name: 'write_file', input: { path: 'src/a.ts' } }])).toBe(4)
    expect(toolBatchConcurrency([{ name: 'browser', input: { action: 'snapshot' } }])).toBe(8)
    expect(toolBatchConcurrency([{ name: 'browser', input: { action: 'navigate', url: 'https://example.com' } }])).toBe(4)
  } finally {
    if (original === undefined) delete process.env.ELIA_TOOL_CONCURRENCY
    else process.env.ELIA_TOOL_CONCURRENCY = original
  }
})

test('ChatGPT subscription execution requires one explicit delegated-agent approval', async () => {
  resetCodexSubscriptionApprovalForTests()
  let calls = 0
  const codexProvider = {
    async streamTurn(params: { onActivity?: (activity: ProviderActivity) => void }) {
      calls += 1
      // Codex's internal activity stream is forwarded in full — its plan and
      // evidence belong to Elia's run, not just its warnings and reroutes.
      params.onActivity?.({ kind: 'command', title: 'Running command', status: 'started' })
      params.onActivity?.({ kind: 'warning', title: 'Codex warning', status: 'warning' })
      return { content: [{ type: 'text', text: 'completed' }] as ContentBlock[], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
  const options = {
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'fix the bug' }] }],
    systemPrompt: 'test',
    tools: [],
    provider: codexProvider,
    providerName: 'codex',
    model: 'gpt-5.3-codex',
    useAnimation: false,
    verbose: false,
  }

  await expect(withActionGovernor(createActionGovernor({ mode: 'unattended' }), () => runAgentLoop(options))).rejects.toThrow('unattended policy')
  expect(calls).toBe(0)

  const events: string[] = []
  const activities: string[] = []
  await withActionGovernor(createActionGovernor({ mode: 'supervised', approve: async () => true }), () => runAgentLoop({
    ...options,
    onTool: (event) => events.push(event.name),
    onActivity: (activity) => activities.push(activity.title),
  }))
  expect(calls).toBe(1)
  expect(events).toEqual(['codex_delegate'])
  expect(activities).toEqual(['Running command', 'Codex warning'])

  // Second turn in the same session: approved once already, so no approval
  // callback is consulted and the turn just runs.
  let approvals = 0
  await withActionGovernor(createActionGovernor({ mode: 'supervised', approve: async () => { approvals += 1; return true } }), () => runAgentLoop(options))
  expect(approvals).toBe(0)
  expect(calls).toBe(2)
})

test('runAgentLoop sums usage across multiple tool-call round trips, not just the last one', async () => {
  let call = 0
  config.provider = {
    async streamTurn() {
      call += 1
      if (call === 1) {
        return {
          content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }] as ContentBlock[],
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
      }
      return {
        content: [{ type: 'text', text: 'done' }] as ContentBlock[],
        usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0 },
      }
    },
  }

  const noopTool: Tool = {
    name: 'noop',
    description: 'does nothing',
    input_schema: { type: 'object', properties: {} },
    async execute() {
      return 'ok'
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]

  const { usage } = await runAgentLoop({
    messages,
    systemPrompt: 'test',
    tools: [noopTool],
    useAnimation: false,
    verbose: false,
  })

  expect(usage).toEqual({ inputTokens: 150, outputTokens: 15, cacheReadTokens: 20, cacheWriteTokens: 0 })
  expect(call).toBe(2)
})

test('a read-only tool_use block streamed mid-turn is executed speculatively and the real dispatch takes the cached result', async () => {
  const { createToolResultCache } = await import('./speculation/cache.ts')
  const originalProvider = config.provider
  let execCount = 0
  const readTool: Tool = {
    name: 'read_file',
    description: 'read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    async execute(input) {
      execCount += 1
      return `contents of ${(input as { path: string }).path}`
    },
  }

  let call = 0
  config.provider = {
    async streamTurn(params) {
      call += 1
      if (call === 1) {
        const block = { type: 'tool_use' as const, id: 'r1', name: 'read_file', input: { path: 'x.ts' } }
        // Model emits the block mid-stream; the rest of the turn is still going.
        params.onToolBlock?.(block)
        // Let the speculative read settle before the turn "finishes".
        await new Promise((resolve) => setTimeout(resolve, 25))
        return { content: [block] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      }
      return { content: [{ type: 'text', text: 'done' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }

  const cache = createToolResultCache()
  const events: { name: string; cached: boolean; result: string }[] = []
  try {
    await runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: 'test',
      tools: [readTool],
      cache,
      useAnimation: false,
      verbose: false,
      onTool: (event) => events.push({ name: event.name, cached: event.cached, result: event.result }),
    })
  } finally {
    config.provider = originalProvider
  }

  expect(execCount).toBe(1) // run once speculatively, not again on dispatch
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ name: 'read_file', cached: true, result: 'contents of x.ts' })
  expect(cache.stats().hits).toBe(1)
})

test('systemDynamicPrompt is forwarded to the provider separately from the stable system prompt', async () => {
  const originalProvider = config.provider
  const seen: { system: string; systemDynamic?: string }[] = []
  config.provider = {
    async streamTurn({ system, systemDynamic }) {
      seen.push({ system, systemDynamic })
      return { content: [{ type: 'text', text: 'done' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
  try {
    await runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: 'STABLE PROMPT',
      systemDynamicPrompt: 'RANKED MEMORY',
      tools: [],
      useAnimation: false,
      verbose: false,
    })
  } finally {
    config.provider = originalProvider
  }
  expect(seen).toEqual([{ system: 'STABLE PROMPT', systemDynamic: 'RANKED MEMORY' }])
})

test('the profiler records one sample per model call only when ELIA_PROFILE is set', async () => {
  const { resetProfilerForTests, profileReport } = await import('./profile.ts')
  const originalProvider = config.provider
  const originalEnv = process.env.ELIA_PROFILE
  let call = 0
  config.provider = {
    async streamTurn({ onText }) {
      call += 1
      if (call === 1) {
        onText('hello')
        return { content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }] as ContentBlock[], usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 900 } }
      }
      return { content: [{ type: 'text', text: 'done' }] as ContentBlock[], usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 950, cacheWriteTokens: 5 } }
    },
  }
  const noopTool: Tool = { name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} }, async execute() { return 'ok' } }
  try {
    process.env.ELIA_PROFILE = '1'
    resetProfilerForTests()
    await runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: 'S',
      tools: [noopTool],
      useAnimation: false,
      verbose: false,
    })
    const report = profileReport()
    expect(report.calls).toBe(2)
    expect(report.totalCacheWrite).toBe(905)
    expect(report.totalCacheRead).toBe(950)
  } finally {
    config.provider = originalProvider
    if (originalEnv === undefined) delete process.env.ELIA_PROFILE
    else process.env.ELIA_PROFILE = originalEnv
    resetProfilerForTests()
  }
})

test('operator steering is spliced into the running turn at the next step boundary', async () => {
  const originalProvider = config.provider
  const seen: string[] = []
  const steering: string[] = []
  let call = 0
  config.provider = {
    async streamTurn({ messages }) {
      call += 1
      // Record the text of the last user message the model was handed.
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      seen.push(lastUser!.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' '))
      if (call === 1) {
        // The operator types this while the first tool call is running.
        steering.push('actually use a token bucket')
        return { content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      }
      return { content: [{ type: 'text', text: 'done' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
  const noopTool: Tool = { name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} }, async execute() { return 'ok' } }
  try {
    await runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'add rate limiting' }] }],
      systemPrompt: 'S',
      tools: [noopTool],
      useAnimation: false,
      verbose: false,
      drainSteering: () => steering.splice(0),
    })
  } finally {
    config.provider = originalProvider
  }
  // Call 1 saw only the original ask; call 2 (after the tool round-trip) saw the steering folded in.
  expect(seen[0]).toContain('add rate limiting')
  expect(seen[1]).toContain('token bucket')
  expect(seen[1]).toContain('Operator steering')
})

test('steering after the model is ready to stop keeps the turn going instead of ending', async () => {
  const originalProvider = config.provider
  const steering: string[] = []
  let call = 0
  config.provider = {
    async streamTurn() {
      call += 1
      if (call === 1) {
        steering.push('one more thing: add a comment explaining why')
        return { content: [{ type: 'text', text: 'all done' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      }
      return { content: [{ type: 'text', text: 'done for real' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
  try {
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: 'S',
      tools: [],
      useAnimation: false,
      verbose: false,
      drainSteering: () => steering.splice(0),
    })
    expect(call).toBe(2)
    expect(result.stopReason).toBe('complete')
  } finally {
    config.provider = originalProvider
  }
})

test('a run aborted mid-turn does not dispatch the queued tool batch and stops as aborted', async () => {
  const originalProvider = config.provider
  const controller = new AbortController()
  let providerCalls = 0
  let toolExecutions = 0
  config.provider = {
    async streamTurn() {
      providerCalls += 1
      // The operator hits Ctrl+C while the model is producing this turn's tool calls.
      controller.abort()
      return {
        content: [
          { type: 'tool_use', id: 'a', name: 'noop', input: {} },
          { type: 'tool_use', id: 'b', name: 'noop', input: {} },
        ] as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    },
  }
  const noopTool: Tool = { name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} }, async execute() { toolExecutions += 1; return 'ok' } }
  try {
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: 'S',
      tools: [noopTool],
      useAnimation: false,
      verbose: false,
      signal: controller.signal,
    })
    expect(result.stopReason).toBe('aborted')
    expect(providerCalls).toBe(1)
    expect(toolExecutions).toBe(0)
  } finally {
    config.provider = originalProvider
  }
})

test('dev hooks block a matching tool before execution and preserve the normal tool-result loop', async () => {
  const originalProvider = config.provider
  let calls = 0
  let executions = 0
  config.provider = {
    async streamTurn() {
      calls += 1
      if (calls === 1) return { content: [{ type: 'tool_use', id: 'hooked', name: 'noop', input: { value: 'blocked' } }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      return { content: [{ type: 'text', text: 'continued after hook' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
  const noopTool: Tool = {
    name: 'noop',
    description: 'does nothing',
    input_schema: { type: 'object', properties: {} },
    async execute() {
      executions += 1
      return 'should not execute'
    },
  }
  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  const hooks = parseToolHooks(JSON.stringify([{ id: 'block-noop', tool: 'noop', message: 'noop is disabled for this dev run' }]))

  try {
    const result = await withToolHooks(hooks, () => withActionGovernor(createActionGovernor({ mode: 'unattended' }), () => runAgentLoop({
      messages,
      systemPrompt: 'test',
      tools: [noopTool],
      useAnimation: false,
      verbose: false,
    })))
    expect(result.stopReason).toBe('complete')
    expect(executions).toBe(0)
    expect(messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result' && block.is_error && block.content.includes('block-noop')))).toBe(true)
  } finally {
    config.provider = originalProvider
  }
})

test('runAgentLoop ends the step early when every tool call keeps failing', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn(params) {
      calls += 1
      // After enough failed turns elia lifts tool use and asks for a report; the
      // model then answers with text and the loop finishes.
      const askedForReport = params.messages.some(
        (m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.includes('Every tool call has failed')),
      )
      if (askedForReport) {
        return { content: [{ type: 'text', text: 'I could not get past the error.' }] as ContentBlock[], usage: ZERO_USAGE }
      }
      return {
        content: [{ type: 'tool_use', id: `t${calls}`, name: 'edit_file', input: { path: 'x.ts', old_string: 'a', new_string: 'b' } }] as ContentBlock[],
        usage: ZERO_USAGE,
      }
    },
  }

  const alwaysFails: Tool = {
    name: 'edit_file',
    description: 'always fails',
    input_schema: { type: 'object', properties: {} },
    async execute() {
      throw new Error('old_string not found')
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  const result = await runAgentLoop({ messages, systemPrompt: 'test', tools: [alwaysFails], useAnimation: false, verbose: false, maxSteps: 80 })

  expect(result.stopReason).toBe('no-progress')
  // 6 failing turns + 1 wrap-up, not the full 80-call budget.
  expect(result.steps).toBeLessThanOrEqual(8)
  expect(lastAssistantText(messages, '')).toContain('could not get past')
})

test('runAgentLoop retries transient provider failures before output', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn() {
      calls += 1
      if (calls < 3) throw new Error('The server had an error while processing your request.')
      return {
        content: [{ type: 'text', text: 'done' }] as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  const result = await runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false })

  expect(result.stopReason).toBe('complete')
  expect(calls).toBe(3)
})

// What Inception's server sends mid-stream when mercury garbles a tool call; the
// OpenAI SDK throws it as an APIError with no status. Run 2026-09-15-lot0-alkr
// died outright on it.
const GARBLED = 'Failed to parse tool call arguments as JSON'

test('a tool call the model garbled is asked for again, even after text streamed', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn({ onText }) {
      calls += 1
      onText('Let me build the page. ')
      if (calls === 1) throw new Error(GARBLED)
      return {
        content: [{ type: 'text', text: 'Let me build the page. Done.' }] as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  const result = await runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false, onText: () => {} })

  expect(result.stopReason).toBe('complete')
  expect(calls).toBe(2)
  // The failed attempt left nothing in the conversation.
  expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
})

test('a garbled tool call is not asked for again once the provider has acted', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn({ onActivity }) {
      calls += 1
      onActivity?.({ kind: 'command', title: 'bun install', status: 'completed' })
      throw new Error(GARBLED)
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  await expect(
    runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false, onActivity: () => {} }),
  ).rejects.toThrow(GARBLED)
  expect(calls).toBe(1)
})

test('a model that keeps garbling its tool calls gives up after the attempt limit', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn() {
      calls += 1
      throw new Error(GARBLED)
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  await expect(
    runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false }),
  ).rejects.toThrow(GARBLED)
  expect(calls).toBe(3)
})

// mercury reports overload as an SSE error chunk, after text has streamed. Run
// 2026-09-21-jynj-3z2u died on it eight minutes into proposing its plan.
const OVERLOADED = 'Service temporarily overloaded'

test('a provider overloaded mid-stream is asked again, even after text streamed', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn({ onText }) {
      calls += 1
      onText('Planning the API. ')
      if (calls < 3) throw new Error(OVERLOADED)
      return {
        content: [{ type: 'text', text: 'Planning the API. Done.' }] as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  const result = await runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false, onText: () => {} })

  expect(result.stopReason).toBe('complete')
  expect(calls).toBe(3)
  expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
})

test('an overloaded provider is not asked again once it has acted', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn({ onActivity }) {
      calls += 1
      onActivity?.({ kind: 'command', title: 'bun install', status: 'completed' })
      throw new Error(OVERLOADED)
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  await expect(
    runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false, onActivity: () => {} }),
  ).rejects.toThrow(OVERLOADED)
  expect(calls).toBe(1)
})

test('a provider that stays overloaded gives up once the waits run out', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn() {
      calls += 1
      throw new Error(OVERLOADED)
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  await expect(
    runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false }),
  ).rejects.toThrow(OVERLOADED)
  // The first attempt plus one per configured wait.
  expect(calls).toBe(4)
})

test('stopping the turn cuts a wait for an overloaded provider short', async () => {
  config.routingMode = 'selected'
  const previous = process.env.ELIA_TRANSIENT_RETRY_DELAYS_MS
  process.env.ELIA_TRANSIENT_RETRY_DELAYS_MS = '60000'
  const controller = new AbortController()
  let calls = 0
  config.provider = {
    async streamTurn() {
      calls += 1
      throw new Error(OVERLOADED)
    },
  }
  try {
    const startedAt = Date.now()
    const pending = runAgentLoop({ messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], systemPrompt: 'test', tools: [], useAnimation: false, verbose: false, signal: controller.signal })
    await Bun.sleep(20)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(calls).toBe(1)
  } finally {
    if (previous === undefined) delete process.env.ELIA_TRANSIENT_RETRY_DELAYS_MS
    else process.env.ELIA_TRANSIENT_RETRY_DELAYS_MS = previous
  }
})

test('runAgentLoop does not retry permanent provider errors', async () => {
  config.routingMode = 'selected'
  let calls = 0
  config.provider = {
    async streamTurn() {
      calls += 1
      throw new Error('invalid API key')
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  await expect(
    runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false }),
  ).rejects.toThrow('invalid API key')
  expect(calls).toBe(1)
})

test('an in-flight provider request becomes an aborted loop result', async () => {
  const controller = new AbortController()
  config.provider = {
    async streamTurn({ signal }: { signal?: AbortSignal }) {
      await new Promise<never>((_, reject) => {
        if (signal?.aborted) return reject(new Error('request aborted'))
        signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
      })
      throw new Error('unreachable')
    },
  }
  const pending = runAgentLoop({ messages: [{ role: 'user', content: [{ type: 'text', text: 'wait' }] }], systemPrompt: 'test', tools: [], useAnimation: false, verbose: false, signal: controller.signal })
  await Bun.sleep(10)
  controller.abort()
  await expect(pending).resolves.toMatchObject({ stopReason: 'aborted' })
})

test('provider health cooldown skips a recently failing route on the next turn', async () => {
  resetProviderHealthForTests()
  const original = { provider: config.provider, providerName: config.providerName, model: config.model, providerLabel: config.providerLabel, routingMode: config.routingMode, fallbacks: config.fallbacks }
  let primaryCalls = 0
  let fallbackCalls = 0
  config.provider = { async streamTurn() { primaryCalls += 1; throw new Error('404 model not found') } }
  config.providerName = 'cooldown-primary'
  config.model = 'primary-model'
  config.providerLabel = 'cooldown-primary (primary-model)'
  config.routingMode = 'auto'
  config.fallbacks = [{
    provider: { async streamTurn() { fallbackCalls += 1; return { content: [{ type: 'text', text: 'backup' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } } },
    providerName: 'cooldown-backup', model: 'backup-model', label: 'cooldown-backup (backup-model)',
  }]
  try {
    const first = await runAgentLoop({ messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], systemPrompt: 'test', tools: [], useAnimation: false, verbose: false })
    const second = await runAgentLoop({ messages: [{ role: 'user', content: [{ type: 'text', text: 'go again' }] }], systemPrompt: 'test', tools: [], useAnimation: false, verbose: false })
    expect(first.stopReason).toBe('complete')
    expect(second.stopReason).toBe('complete')
    expect(primaryCalls).toBe(1)
    expect(fallbackCalls).toBe(2)
  } finally {
    resetProviderHealthForTests()
    config.provider = original.provider
    config.providerName = original.providerName
    config.model = original.model
    config.providerLabel = original.providerLabel
    config.routingMode = original.routingMode
    config.fallbacks = original.fallbacks
  }
})

test('auto mode falls back to another provider on model unavailability without changing the primary selection', async () => {
  const original = {
    provider: config.provider,
    providerName: config.providerName,
    model: config.model,
    providerLabel: config.providerLabel,
    routingMode: config.routingMode,
    fallbacks: config.fallbacks,
  }
  let primaryCalls = 0
  let fallbackCalls = 0
  const fallback = {
    provider: {
      async streamTurn() {
        fallbackCalls += 1
        return {
          content: [{ type: 'text', text: 'backup response' }] as ContentBlock[],
          usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
      },
    },
    providerName: 'backup-provider',
    model: 'backup-model',
    label: 'backup-provider (backup-model)',
  }

  config.provider = {
    async streamTurn() {
      primaryCalls += 1
      throw new Error('404 model not found')
    },
  }
  config.providerName = 'primary-provider'
  config.model = 'primary-model'
  config.providerLabel = 'primary-provider (primary-model)'
  config.routingMode = 'auto'
  config.fallbacks = [fallback]

  try {
    const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
    const result = await runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false })

    expect(result.stopReason).toBe('complete')
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'backup response' }])
    expect(primaryCalls).toBe(1)
    expect(fallbackCalls).toBe(1)
    expect(config.providerName).toBe('primary-provider')
    expect(config.model).toBe('primary-model')
  } finally {
    config.provider = original.provider
    config.providerName = original.providerName
    config.model = original.model
    config.providerLabel = original.providerLabel
    config.routingMode = original.routingMode
    config.fallbacks = original.fallbacks
  }
})

test('a blocked repeat of an already-failed action reports the original reason and how to proceed', async () => {
  // Regression: this message used to be a bare "Action <key> is failed; Elia
  // will not repeat it automatically. Human review is required." — which told an
  // unattended agent nothing about what to change, so it would retry the same
  // doomed edit and burn turns. Observed live in an `elia auto` run that got
  // stuck looping on a non-unique edit_file old_string.
  const { GoalGraphStore, withGoalGraph } = await import('./autonomy/goalGraph.ts')
  const directory = mkdtempSync(join(tmpdir(), 'elia-blocked-action-'))
  try {
    const graph = GoalGraphStore.open({ runId: 'blocked-action-run', goal: 'exercise the blocked path', dir: directory })
    const request = { name: 'edit_file', input: { path: 'src/server.ts', old_string: 'const x', new_string: 'const y' } }

    // First attempt fails the way a real non-unique edit does.
    const first = graph.reserveAction(request)
    expect(first.decision).toBe('execute')
    graph.startAction(first.action.id)
    graph.finishAction(first.action.id, { ok: false, error: 'old_string matches multiple locations in src/server.ts — include more surrounding context to make it unique' })

    const failingTool: Tool = {
      name: 'edit_file',
      description: 'edit a file',
      input_schema: { type: 'object', properties: {} },
      async execute() {
        throw new Error('the tool must never actually run for a blocked repeat')
      },
    }

    let turn = 0
    config.provider = {
      async streamTurn() {
        turn += 1
        if (turn === 1) {
          return {
            content: [{ type: 'tool_use', id: 'repeat', name: 'edit_file', input: request.input }] as ContentBlock[],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          }
        }
        return { content: [{ type: 'text', text: 'stopping' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      },
    }

    const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'retry that edit' }] }]
    await withGoalGraph(graph, () => runAgentLoop({ messages, systemPrompt: 'test', tools: [failingTool], useAnimation: false, verbose: false }))

    const toolResult = messages.flatMap((message) => message.content).find((block) => block.type === 'tool_result')
    const text = JSON.stringify(toolResult)
    // The agent must learn what actually went wrong...
    expect(text).toContain('already')
    expect(text).toContain('old_string matches multiple locations')
    // ...and what to do about it, rather than a dead-end "human review required".
    expect(text).toContain('Do not retry it unchanged')
    expect(text).toContain('more surrounding context')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed postcondition preserves the tool\'s real output, not just the generic failure line', async () => {
  // Regression: this used to replace resultText outright with "Action
  // postcondition failed: ...", discarding stdout/stderr entirely — so a
  // failing `bun test` reported only "exit code 1" with no assertion output,
  // no stack trace, nothing to act on. Observed live: an unattended tester
  // agent cycled through --reporter=json/dot/spec/list trying to coax out
  // output it could actually see, burning its step budget doing it.
  const failingOutput = 'exit code: 1\nstdout:\nFAIL src/server.test.ts\n  expect(received).toBe(expected)\n  Expected: 200\n  Received: 500\nstderr:\n'
  const runCommandStub: Tool = {
    name: 'run_command',
    description: 'run a shell command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    async execute() {
      return failingOutput
    },
  }

  let turn = 0
  config.provider = {
    async streamTurn() {
      turn += 1
      if (turn === 1) {
        return {
          content: [{ type: 'tool_use', id: 'run1', name: 'run_command', input: { command: 'bun test' } }] as ContentBlock[],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
      }
      return { content: [{ type: 'text', text: 'stopping' }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'run the tests' }] }]
  await runAgentLoop({ messages, systemPrompt: 'test', tools: [runCommandStub], useAnimation: false, verbose: false })

  const toolResult = messages.flatMap((message) => message.content).find((block) => block.type === 'tool_result')
  const text = JSON.stringify(toolResult)
  expect(text).toContain('Action postcondition failed')
  // The actual failing assertion must survive, not just the generic wrapper.
  expect(text).toContain('FAIL src/server.test.ts')
  expect(text).toContain('Expected: 200')
  expect(text).toContain('Received: 500')
})

test('the plan follows the work when the model never calls todo_write: ticks from evidence, a note, then a nudge for the step elia cannot judge', async () => {
  const { createTodoList, withTodoList } = await import('./autonomy/todoList.ts')
  const { beginPlanRequest } = await import('./autonomy/planProgress.ts')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'elia-plan-progress-'))
  const list = createTodoList()
  beginPlanRequest(list)
  list.write([
    { content: 'Create `site/index.html` with the page structure', status: 'in_progress' },
    { content: 'Add responsive styling', status: 'pending' },
    { content: 'Run `bun run build` to verify', status: 'pending' },
  ])
  // mercury-2.5's habit, as recorded: it does the work and never touches the plan.
  const script: ContentBlock[][] = [
    [{ type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'site/index.html', content: '<main></main>' } }],
    ...Array.from({ length: 6 }, (_, i): ContentBlock[] => [{ type: 'tool_use', id: `s${i}`, name: 'write_file', input: { path: `site/style${i}.css`, content: 'main{}' } }]),
    [{ type: 'tool_use', id: 'b1', name: 'run_command', input: { command: 'bun run build' } }],
    [{ type: 'text', text: 'Done.' }],
  ]
  let call = 0
  const seen: string[][] = []
  const updates: string[] = []
  const tools: Tool[] = [
    {
      name: 'write_file', description: 'write', input_schema: { type: 'object', properties: {} },
      async execute(input) {
        const target = join(dir, String(input.path))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, String(input.content))
        return `Created ${input.path} (+1 −0)`
      },
    },
    { name: 'run_command', description: 'run', input_schema: { type: 'object', properties: {} }, async execute() { return 'exit code: 0\nstdout: built' } },
  ]
  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'build the page' }] }]
  try {
    await withAgentIdentity({ name: 'lead', role: 'lead', cwd: dir }, () => withTodoList(list, () => withActionGovernor(createActionGovernor({ mode: 'supervised', cwd: dir, approve: async () => true }), () => runAgentLoop({
      messages, systemPrompt: 'test', tools, providerName: 'anthropic', model: 'plan-progress-test', useAnimation: false, verbose: false,
      provider: { async streamTurn(params) {
        seen.push(params.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'text' && b.text.startsWith('[elia]') ? [b.text] : []))))
        return { content: script[call++]!, usage: ZERO_USAGE }
      } },
      onPlanProgress: (update) => updates.push(update.items.map((item) => item.status[0]).join('')),
    }))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // Step 1 ticked by the write, step 3 by the build; step 2 names nothing, so it stays the model's call.
  expect(updates).toEqual(['cip', 'cic'])
  expect(list.read().map((item) => item.status)).toEqual(['completed', 'in_progress', 'completed'])
  const told = seen.at(-1)!
  expect(told.some((text) => text.includes('Plan updated from what just ran: ✓ 1. Create `site/index.html`'))).toBe(true)
  expect(told.some((text) => text.includes('Your plan has not changed in 6 actions') && text.includes('◐ 2. Add responsive styling'))).toBe(true)
})

test('finishAfterTool ends the loop as soon as the report tool succeeds', async () => {
  let call = 0
  const report: Tool = {
    name: 'submit_assumptions',
    description: 'report',
    input_schema: { type: 'object', properties: {} },
    async execute() {
      return 'Recorded.'
    },
  }
  const stub = {
    async streamTurn() {
      call += 1
      // A failed first submission must not end the loop; the second one does.
      return {
        content: [{ type: 'tool_use', id: `t${call}`, name: call === 1 ? 'missing_tool' : 'submit_assumptions', input: {} }] as ContentBlock[],
        usage: ZERO_USAGE,
      }
    },
  }
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    systemPrompt: 'test',
    tools: [report],
    provider: stub,
    providerName: 'stub',
    model: 'stub',
    fallbacks: [],
    useAnimation: false,
    verbose: false,
    finishAfterTool: 'submit_assumptions',
  })
  expect(result.stopReason).toBe('complete')
  expect(call).toBe(2)
})

test('auto mode hands a turn on when the selected provider is out of credit or refuses its key', async () => {
  const original = { provider: config.provider, providerName: config.providerName, model: config.model, providerLabel: config.providerLabel, routingMode: config.routingMode, fallbacks: config.fallbacks }
  config.routingMode = 'auto'
  config.fallbacks = [{
    provider: { async streamTurn() { return { content: [{ type: 'text', text: 'backup' }] as ContentBlock[], usage: ZERO_USAGE } } },
    providerName: 'credit-backup', model: 'backup-model', label: 'credit-backup (backup-model)',
  }]
  try {
    for (const failure of ['402 Insufficient credits. This account never purchased credits.', '401 Incorrect API key provided']) {
      resetProviderHealthForTests()
      config.provider = { async streamTurn() { throw new Error(failure) } }
      config.providerName = 'credit-primary'
      config.model = 'primary-model'
      const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
      const result = await runAgentLoop({ messages, systemPrompt: 'test', tools: [], useAnimation: false, verbose: false })
      expect(result.stopReason).toBe('complete')
      expect(lastAssistantText(messages, '')).toBe('backup')
    }
  } finally {
    resetProviderHealthForTests()
    Object.assign(config, original)
  }
})

test('a running loop follows a model switch on its next call', async () => {
  resetProviderHealthForTests()
  const used: string[] = []
  const reply = (name: string, content: ContentBlock[]) => ({
    async streamTurn() {
      used.push(name)
      return { content, usage: ZERO_USAGE }
    },
  })
  const route = {
    provider: reply('stuck', [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'package.json' } }]),
    providerName: 'stuck',
    model: 'rate-limited',
  }
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    systemPrompt: 'test',
    tools: [],
    resolveRoute: () => route,
    fallbacks: [],
    useAnimation: false,
    verbose: false,
    onTool: () => {
      // The operator switches while the first call's tool runs.
      Object.assign(route, { provider: reply('switched', [{ type: 'text', text: 'done' }]), providerName: 'switched', model: 'working' })
    },
  })
  expect(result.stopReason).toBe('complete')
  expect(used).toEqual(['stuck', 'switched'])
})

test("a worker whose cheap model refuses hands the call to the session's model, without waiting", async () => {
  resetProviderHealthForTests()
  const used: string[] = []
  const fast = {
    async streamTurn(): Promise<never> {
      used.push('fast')
      throw new Error('429 Rate limit reached for model openai/gpt-oss-20b on tokens per minute (TPM): Limit 8000')
    },
  }
  const deep = {
    async streamTurn() {
      used.push('deep')
      return { content: [{ type: 'text', text: 'done' }] as ContentBlock[], usage: ZERO_USAGE }
    },
  }
  const started = Date.now()
  try {
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: 'test',
      tools: [],
      resolveRoute: () => ({ provider: fast, providerName: 'groq', model: 'openai/gpt-oss-20b' }),
      resolveFallbacks: () => [{ provider: deep, providerName: 'mercury', model: 'mercury-2.5' }],
      fallbacks: [],
      useAnimation: false,
      verbose: false,
    })
    expect(result.stopReason).toBe('complete')
    expect(used).toEqual(['fast', 'deep'])
    expect(Date.now() - started).toBeLessThan(1_000)
  } finally {
    resetProviderHealthForTests()
  }
})

test('a fallback naming the route already in use is not tried twice', async () => {
  resetProviderHealthForTests()
  let calls = 0
  const failing = {
    async streamTurn(): Promise<never> {
      calls += 1
      throw new Error('402 Payment Required')
    },
  }
  try {
    await expect(runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: 'test',
      tools: [],
      resolveRoute: () => ({ provider: failing, providerName: 'mercury', model: 'mercury-2.5' }),
      resolveFallbacks: () => [{ provider: failing, providerName: 'mercury', model: 'mercury-2.5' }],
      fallbacks: [],
      useAnimation: false,
      verbose: false,
    })).rejects.toThrow('402')
    expect(calls).toBe(1)
  } finally {
    resetProviderHealthForTests()
  }
})

test('a running turn reports what it produced call by call, not only at the end', async () => {
  const seen: LiveOutput[] = []
  const stop = onLiveOutput((event) => seen.push(event))
  let call = 0
  try {
    await runAgentLoop({
      messages: [], systemPrompt: 'test', providerName: 'anthropic', model: 'live-output-test', useAnimation: false, verbose: false,
      // A real turn runs with the speculative read cache, which is what hands
      // finished tool arguments up mid-stream.
      cache: createToolResultCache(),
      tools: [{ name: 'write_file', description: 'Test write', input_schema: { type: 'object', properties: {} }, async execute() { return 'written' } }],
      provider: { async streamTurn(params) {
        if (++call === 1) {
          const input = { path: 'src/big.ts', contents: 'x'.repeat(400) }
          // The arguments finish streaming well before the call does — that is
          // the long silence the working line has to keep counting through.
          params.onToolBlock?.({ type: 'tool_use', id: 'w1', name: 'write_file', input })
          return { content: [{ type: 'tool_use', id: 'w1', name: 'write_file', input }], usage: { ...ZERO_USAGE, outputTokens: 120 } }
        }
        params.onText('done')
        return { content: [{ type: 'text', text: 'done' }], usage: { ...ZERO_USAGE, outputTokens: 30 } }
      } },
    })
  } finally {
    stop()
  }
  const streamed = seen.filter((event) => event.kind === 'streaming')
  expect(streamed).toHaveLength(1)
  expect(streamed[0]).toMatchObject({ kind: 'streaming' })
  expect((streamed[0] as { chars: number }).chars).toBeGreaterThan(400)
  // The estimate lands first, then each call's real usage — in that order.
  expect(seen.indexOf(streamed[0]!)).toBe(0)
  expect(seen.filter((event) => event.kind === 'settled')).toEqual([
    { kind: 'settled', outputTokens: 120 },
    { kind: 'settled', outputTokens: 30 },
  ])
})

test('nobody listening costs the turn nothing, and a listener that throws does not take it down', async () => {
  const stop = onLiveOutput(() => {
    throw new Error('listener exploded')
  })
  try {
    const result = await runAgentLoop({
      messages: [], systemPrompt: 'test', tools: [], providerName: 'anthropic', model: 'live-output-throw-test', useAnimation: false, verbose: false,
      provider: { async streamTurn(params) { params.onText('fine'); return { content: [{ type: 'text', text: 'fine' }], usage: { ...ZERO_USAGE, outputTokens: 7 } } } },
    })
    expect(result.usage.outputTokens).toBe(7)
  } finally {
    stop()
  }
})
