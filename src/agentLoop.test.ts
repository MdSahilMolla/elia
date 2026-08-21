import { expect, test } from 'bun:test'
import type { ConversationMessage } from './agentLoop.ts'
import type { ContentBlock } from './providers/types.ts'
import type { Tool } from './tools/types.ts'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads; we swap in a stub
// provider below so no real network call ever happens.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-agentloop-test'

const { config } = await import('./config.ts')
const { resetProviderHealthForTests, runAgentLoop } = await import('./agentLoop.ts')

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
