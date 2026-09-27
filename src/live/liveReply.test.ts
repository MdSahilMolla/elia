import { expect, test } from 'bun:test'
import { answerWhileWorking, buildLivePrompt, looksLikeDirection, parseLiveAnswer, parsePlanEdits, renderConversation, stripUnbackedClaims, type LiveContext } from './liveReply.ts'
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
  expect(prompt).toContain('2. [in_progress] Fix timezone handling')
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
  expect(forgot.steer).toBe("The person's note: also add a regression test for this")
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

test('the reply carries the thinking, what the person wants, and the plan change against the numbered plan', () => {
  const text = [
    'THINKING: They want the flake fixed without mocking the clock; step 2 should say so, and a DST test is missing.',
    'WANTS: a real-clock fix plus a DST regression test',
    'ANSWER: I will fix it against the real clock and add a DST test.',
    'PLAN:',
    '~ 2 => Fix timezone handling without mocking the clock',
    '+ after 2: Add a DST regression test',
    '- 7',
    '- 1',
  ].join('\n')
  expect(parseLiveAnswer(text, 2)).toEqual({
    answer: 'I will fix it against the real clock and add a DST test.',
    wants: 'a real-clock fix plus a DST regression test',
    thinking: 'They want the flake fixed without mocking the clock; step 2 should say so, and a DST test is missing.',
    // step 7 does not exist and is dropped; step 1 does.
    edits: [
      { kind: 'change', step: 2, to: 'Fix timezone handling without mocking the clock' },
      { kind: 'add', after: 2, title: 'Add a DST regression test' },
      { kind: 'remove', step: 1 },
    ],
  })
  expect(parseLiveAnswer('THINKING: just a question\nWANTS: none\nANSWER: About halfway.\nPLAN: none', 2)).toEqual({ answer: 'About halfway.', thinking: 'just a question' })
  expect(parsePlanEdits('+ Write the docs', 3)).toEqual([{ kind: 'add', after: 3, title: 'Write the docs' }])
})

test('a reply never claims work that nothing ran', () => {
  const none = stripUnbackedClaims('I set up the Postgres database and ran the migrations. The tests are next.', [])
  expect(none).toEqual({ text: 'The tests are next.', dropped: 1 })
  const edited = [{ name: 'edit_file', input: 'Editing src/date.ts', outcome: 'ok', isError: false }]
  expect(stripUnbackedClaims('I fixed date.ts. I also updated auth.ts.', edited)).toEqual({ text: 'I fixed date.ts.', dropped: 1 })
  expect(stripUnbackedClaims('Working on it — nothing is built yet.', []).dropped).toBe(0)
  // A claim about the plan is backed when this reply changed the plan — but not one that names a file.
  expect(stripUnbackedClaims("I've updated the plan to add a remove() test.", [], true)).toEqual({ text: "I've updated the plan to add a remove() test.", dropped: 0 })
  expect(stripUnbackedClaims("I've updated the plan to add a remove() test.", [])).toEqual({ text: '', dropped: 1 })
  expect(stripUnbackedClaims('I added sample notes to fixtures.json as step 3.', [], true).dropped).toBe(1)
})

test('the thinking streams while the reply is written, and the answer loses unbacked claims', async () => {
  const seen: string[] = []
  const reply = await answerWhileWorking(context({ recentTools: [] }), 'use a real clock, not a mock', {
    onThinking: (text) => seen.push(text),
    responder: async ({ onText }) => {
      const text = 'THINKING: They do not want the clock mocked.\nWANTS: a real-clock fix\nANSWER: I fixed it already. Step 2 will use the real clock.\nPLAN:\n~ 2 => Fix timezone handling against the real clock'
      for (const chunk of text.match(/[\s\S]{1,20}/g)!) onText?.(chunk)
      return { text, model: 'm' }
    },
  })
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.at(-1)).toContain('They do not want the clock mocked.')
  expect(seen.some((text) => text.includes('ANSWER'))).toBe(false)
  expect(reply.answer).toBe('Step 2 will use the real clock.')
  expect(reply.dropped).toBe(1)
  expect(reply.wants).toBe('a real-clock fix')
  expect(reply.edits).toEqual([{ kind: 'change', step: 2, to: 'Fix timezone handling against the real clock' }])
  expect(reply.steer).toBe("The person's note: use a real clock, not a mock\nThey want: a real-clock fix")
})
