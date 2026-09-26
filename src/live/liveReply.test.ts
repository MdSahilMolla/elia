import { expect, test } from 'bun:test'
import { answerWhileWorking, buildLivePrompt, looksLikeDirection, parseLiveAnswer, renderConversation, type LiveContext } from './liveReply.ts'
import type { ChatMessage } from '../providers/types.ts'

const conversation: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'fix the flaky date test' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Looking at the test first.' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/date.test.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'expect(parse("2026-01-01")).toBe(...)', is_error: false }] },
]

function context(overrides: Partial<LiveContext> = {}): LiveContext {
  return {
    request: 'fix the flaky date test',
    elapsedMs: 42_000,
    status: 'Running bun test',
    runningTools: ['Running bun test'],
    plan: [{ content: 'Reproduce the flake', status: 'completed' }, { content: 'Fix timezone handling', status: 'in_progress' }],
    recentTools: [{ name: 'read_file', input: 'Reading date.test.ts', outcome: 'expect(parse(...', isError: false }],
    assistantSoFar: 'The test assumes UTC.',
    steering: [],
    conversation,
    exchanges: [],
    cwd: process.cwd(),
    ...overrides,
  }
}

test('the reply is split into what the person reads and the instruction for the work', () => {
  expect(parseLiveAnswer('Fixing timezone handling now.')).toEqual({ answer: 'Fixing timezone handling now.' })
  expect(parseLiveAnswer('Will do.\nSTEER: Also add a regression test for DST.')).toEqual({ answer: 'Will do.', steer: 'Also add a regression test for DST.' })
  expect(parseLiveAnswer('Ok.\n**STEER:** `stop editing auth.ts`')).toEqual({ answer: 'Ok.', steer: 'stop editing auth.ts' })
  expect(parseLiveAnswer('Just a question.\nSTEER: none')).toEqual({ answer: 'Just a question.' })
})

test('the conversation renders tool calls and results, and keeps the newest when it must cut', () => {
  const text = renderConversation(conversation)
  expect(text).toContain('USER: fix the flaky date test')
  expect(text).toContain('[tool call read_file {"path":"src/date.test.ts"}]')
  expect(text).toContain('[tool result: expect(parse(')
  const long: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: `message ${i} ${'x'.repeat(400)}` }] }))
  const cut = renderConversation(long, 2_000)
  expect(cut).toContain('message 49')
  expect(cut).not.toContain('message 0 ')
  expect(cut).toContain('earlier message(s) omitted')
})

test('the prompt carries the live state of the turn, the pilot and earlier exchanges', () => {
  const prompt = buildLivePrompt(context({ pilot: 'autopilot abc — work\nworking on: g2 Add tags', exchanges: [{ question: 'eta?', answer: 'a few minutes' }], progress: ['◆ measuring health', '✗ npm test — fail'] }), 'what now?')
  expect(prompt).toContain('- ✗ npm test — fail')
  expect(prompt).toContain('# Their message (sent 42s into the running turn)')
  expect(prompt).toContain('running: Running bun test')
  expect(prompt).toContain('- [in_progress] Fix timezone handling')
  expect(prompt).toContain('- read_file Reading date.test.ts')
  expect(prompt).toContain('working on: g2 Add tags')
  expect(prompt).toContain('Q: eta?')
  expect(prompt).toContain('USER: fix the flaky date test')
})

test('answerWhileWorking parses the steer and times out cleanly', async () => {
  const answer = await answerWhileWorking(context(), 'also cover DST', { responder: async () => ({ text: 'Adding it.\nSTEER: Add a DST regression test.', model: 'm' }) })
  expect(answer).toEqual({ answer: 'Adding it.', steer: 'Add a DST regression test.', model: 'm' })

  const slow = answerWhileWorking(context(), 'hello?', {
    timeoutMs: 20,
    responder: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: '', model: 'm' }))),
  })
  await expect(slow).rejects.toThrow('no answer within')
})

test('a direction the model forgot to STEER still reaches the work; a question never does', async () => {
  const forgot = await answerWhileWorking(context(), 'also add a regression test for this', { responder: async () => ({ text: "Sure, I'll add a test for remove().", model: 'm' }) })
  expect(forgot.steer).toBe('also add a regression test for this')
  const asked = await answerWhileWorking(context(), 'how far along are you?', { responder: async () => ({ text: 'About halfway.', model: 'm' }) })
  expect(asked.steer).toBeUndefined()
})

test('directions and questions are told apart', () => {
  for (const direction of ['also add tests', 'use postgres instead of sqlite', "don't touch auth.ts", 'please stop after this step', 'ok now refactor the parser', 'make sure the docs are updated']) {
    expect(looksLikeDirection(direction)).toBe(true)
  }
  for (const question of ['what are you doing?', 'how long will this take', 'is the build green', 'why did the test fail?', 'status', 'nice work']) {
    expect(looksLikeDirection(question)).toBe(false)
  }
})
