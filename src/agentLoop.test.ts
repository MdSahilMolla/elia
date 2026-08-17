import { expect, test } from 'bun:test'
import type { ConversationMessage } from './agentLoop.ts'
import type { ContentBlock } from './providers/types.ts'
import type { Tool } from './tools/types.ts'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads; we swap in a stub
// provider below so no real network call ever happens.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-agentloop-test'

const { config } = await import('./config.ts')
const { runAgentLoop } = await import('./agentLoop.ts')

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
