import { expect, test } from 'bun:test'
import { BARE_OUTPUT_LIMIT, BARE_SYSTEM_PROMPT, BARE_TOOLS, clipOutput, runBareLoop } from './bareLoop.ts'
import type { ContentBlock, StreamTurnParams, Usage } from '../providers/types.ts'

const usage = (input: number, output: number): Usage => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 })

/** A model that plays back a fixed script, one turn per call, and remembers what it was sent. */
function scripted(turns: ContentBlock[][]) {
  const seen: StreamTurnParams[] = []
  let index = 0
  return {
    seen,
    provider: {
      async streamTurn(params: StreamTurnParams) {
        seen.push({ ...params, messages: [...params.messages] })
        const content = turns[index++] ?? [{ type: 'text' as const, text: 'done' }]
        for (const block of content) if (block.type === 'text') params.onText(block.text)
        return { content, usage: usage(100, 10) }
      },
    },
  }
}

const bash = (id: string, command: string): ContentBlock => ({ type: 'tool_use', id, name: 'bash', input: { command } })

const noWrite = async (): Promise<string> => {
  throw new Error('no writes in this test')
}

test('the bare arm offers a shell, a file writer and a short prompt, runs what the model asks, and stops when it stops calling tools', async () => {
  const model = scripted([[bash('1', 'cat a.ts')], [{ type: 'tool_use', id: '2', name: 'write_file', input: { path: 'a.ts', content: 'fixed' } }], [{ type: 'text', text: 'fixed it' }]])
  const ran: string[] = []
  const wrote: string[] = []
  const result = await runBareLoop({
    provider: model.provider,
    prompt: 'fix the bug',
    cwd: '/repo',
    maxSteps: 10,
    exec: async (command) => (ran.push(command), 'exit code: 0'),
    write: async (path, content) => (wrote.push(`${path}=${content}`), `wrote ${path}`),
  })

  expect(result).toEqual({ steps: 3, usage: usage(300, 30), stopReason: 'completed' })
  expect(ran).toEqual(['cat a.ts'])
  expect(wrote).toEqual(['a.ts=fixed'])
  expect(model.seen[0]!.tools.map((tool) => tool.name)).toEqual(['bash', 'write_file'])
  expect(model.seen[0]!.tools).toEqual(BARE_TOOLS)
  expect(model.seen[0]!.system).toBe(BARE_SYSTEM_PROMPT)
  // The second call carries the command's result back, paired to its call.
  const reply = model.seen[1]!.messages.at(-1)!
  expect(reply.content).toEqual([{ type: 'tool_result', tool_use_id: '1', content: 'exit code: 0', is_error: false }])
})

test('the step budget is the task’s, and running out of it is reported rather than hidden', async () => {
  const model = scripted([[bash('1', 'ls')], [bash('2', 'ls')], [bash('3', 'ls')]])
  const result = await runBareLoop({ provider: model.provider, prompt: 'p', cwd: '/r', maxSteps: 2, exec: async () => '', write: noWrite })
  expect(result.steps).toBe(2)
  expect(result.stopReason).toBe('step-budget')
})

test('a refused command reaches the model as an error, and the run goes on', async () => {
  const model = scripted([[bash('1', 'git push')], [{ type: 'text', text: 'ok' }]])
  const events: unknown[] = []
  await runBareLoop({
    provider: model.provider,
    prompt: 'p',
    cwd: '/r',
    maxSteps: 5,
    exec: async () => {
      throw new Error('refused by the safety policy')
    },
    write: noWrite,
    onEvent: (event) => events.push(event),
  })
  const reply = model.seen[1]!.messages.at(-1)!
  expect(reply.content).toEqual([{ type: 'tool_result', tool_use_id: '1', content: 'refused by the safety policy', is_error: true }])
  expect(events).toContainEqual({ tool: 'bash', id: '1', input: 'git push', ok: false, result: 'refused by the safety policy' })
})

test('a call to a tool the bare arm does not have, or without its arguments, is answered, not executed', async () => {
  const model = scripted([
    [
      { type: 'tool_use', id: '1', name: 'edit_file', input: { path: 'x' } },
      { type: 'tool_use', id: '2', name: 'write_file', input: { path: 'x' } },
    ],
    [{ type: 'text', text: 'ok' }],
  ])
  const ran: string[] = []
  await runBareLoop({ provider: model.provider, prompt: 'p', cwd: '/r', maxSteps: 5, exec: async (command) => (ran.push(command), ''), write: async (path) => (ran.push(path), '') })
  expect(ran).toEqual([])
  expect((model.seen[1]!.messages.at(-1)!.content[1] as { is_error: boolean }).is_error).toBe(true)
  expect((model.seen[1]!.messages.at(-1)!.content[0] as { is_error: boolean }).is_error).toBe(true)
})

test('a provider blip is retried like elia retries it; a real error is not', async () => {
  let calls = 0
  const flaky = {
    async streamTurn() {
      calls += 1
      if (calls === 1) throw new Error('503 Service Unavailable')
      return { content: [{ type: 'text' as const, text: 'done' }], usage: usage(1, 1) }
    },
  }
  const slept: number[] = []
  const result = await runBareLoop({ provider: flaky, prompt: 'p', cwd: '/r', maxSteps: 3, exec: async () => '', write: noWrite, retryDelaysMs: [5], sleep: async (ms) => void slept.push(ms) })
  expect(result.stopReason).toBe('completed')
  expect(slept).toEqual([5])

  const broken = {
    async streamTurn(): Promise<{ content: ContentBlock[]; usage: Usage }> {
      throw new Error('invalid request: bad schema')
    },
  }
  await expect(runBareLoop({ provider: broken, prompt: 'p', cwd: '/r', maxSteps: 3, exec: async () => '', write: noWrite, retryDelaysMs: [5], sleep: async () => {} })).rejects.toThrow('bad schema')
})

test('long output keeps its head and tail, like mini-swe-agent', () => {
  const long = `${'a'.repeat(BARE_OUTPUT_LIMIT)}${'b'.repeat(BARE_OUTPUT_LIMIT)}`
  const clipped = clipOutput(long)
  expect(clipped.startsWith('a')).toBe(true)
  expect(clipped.endsWith('b')).toBe(true)
  expect(clipped).toContain('characters elided')
  expect(clipOutput('short')).toBe('short')
})
