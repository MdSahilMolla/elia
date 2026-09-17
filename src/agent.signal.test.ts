import { expect, test } from 'bun:test'
import type { ContentBlock } from './providers/types.ts'
import { ZERO_USAGE } from './usage.ts'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-agent-signal-test'
const { runTurn } = await import('./agent.ts')

test('stopping a chat turn reaches the work its tools started', async () => {
  const controller = new AbortController()
  let call = 0
  const provider = {
    async streamTurn() {
      call += 1
      if (call > 1) return { content: [{ type: 'text', text: 'stopped' }] as ContentBlock[], usage: ZERO_USAGE }
      setTimeout(() => controller.abort(), 500)
      return {
        content: [{ type: 'tool_use', id: 'slow', name: 'run_command', input: { command: 'bun -e "setTimeout(() => {}, 20000)"', timeoutMs: 60000 } }] as ContentBlock[],
        usage: ZERO_USAGE,
      }
    },
  }
  const startedAt = Date.now()
  await runTurn([{ role: 'user', content: [{ type: 'text', text: 'run it' }] }], {
    provider,
    providerName: 'stub',
    model: 'stub',
    signal: controller.signal,
    silent: true,
    skipStats: true,
    governanceMode: 'supervised',
    approveAction: async () => true,
  })
  // Before, the tool never saw the signal and the turn waited out the full 20s.
  expect(Date.now() - startedAt).toBeLessThan(10_000)
}, 30_000)
