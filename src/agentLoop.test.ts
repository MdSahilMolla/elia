import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConversationMessage } from './agentLoop.ts'
import type { ContentBlock } from './providers/types.ts'
import type { Tool } from './tools/types.ts'
import { createActionGovernor, withActionGovernor } from './autonomy/governor.ts'
import { parseToolHooks, withToolHooks } from './autonomy/devHooks.ts'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads; we swap in a stub
// provider below so no real network call ever happens.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-agentloop-test'

const { config } = await import('./config.ts')
const { resetProviderHealthForTests, runAgentLoop, toolBatchConcurrency } = await import('./agentLoop.ts')

test('safe read-only tool batches use bounded fast concurrency while mutating batches stay conservative', () => {
  const original = process.env.ELIA_TOOL_CONCURRENCY
  try {
    delete process.env.ELIA_TOOL_CONCURRENCY
    expect(toolBatchConcurrency([{ name: 'read_file', input: { path: 'src/a.ts' } }, { name: 'grep', input: { pattern: 'x' } }])).toBe(4)
    expect(toolBatchConcurrency([{ name: 'read_file', input: { path: 'src/a.ts' } }, { name: 'read_file', input: { path: 'src/b.ts' } }, { name: 'read_file', input: { path: 'src/c.ts' } }, { name: 'read_file', input: { path: 'src/d.ts' } }, { name: 'read_file', input: { path: 'src/e.ts' } }])).toBe(4)
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
  let calls = 0
  const codexProvider = {
    async streamTurn(params: { onActivity?: (activity: { kind: 'command'; title: string; status: 'started' }) => void }) {
      calls += 1
      params.onActivity?.({ kind: 'command', title: 'Running command', status: 'started' })
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
  expect(activities).toEqual(['Running command'])
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
