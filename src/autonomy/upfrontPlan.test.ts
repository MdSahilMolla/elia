import { expect, test } from 'bun:test'
import {
  conversationDigest,
  createThinkingStream,
  draftRunThinking,
  draftUpfrontPlan,
  parsePlannerReply,
  planActivity,
  planBriefing,
  plannerPrompt,
  planTodoItems,
  runThinkingPrompt,
  stripInjectedContext,
  visibleThinking,
  wantsUpfrontPlan,
} from './upfrontPlan.ts'
import type { ChatMessage, Provider, StreamTurnParams } from '../providers/types.ts'

const text = (value: string) => ({ type: 'text' as const, text: value })

test('work orders are planned; questions, chat and slash commands are not', () => {
  expect(wantsUpfrontPlan('create a laptop suggesgtion website')).toBe(true)
  expect(wantsUpfrontPlan('can you create a website for this')).toBe(true)
  expect(wantsUpfrontPlan('add a smart routing feature with place autocomplete')).toBe(true)
  expect(wantsUpfrontPlan('hii')).toBe(false)
  expect(wantsUpfrontPlan('how do I add authentication here?')).toBe(false)
  expect(wantsUpfrontPlan('why is the suggestion not showing when I type')).toBe(false)
  expect(wantsUpfrontPlan('/model mercury')).toBe(false)
  expect(wantsUpfrontPlan('use the rupee symbol')).toBe(false)
})

test('only the instruction counts — operator context and pasted material below it do not make a work order', () => {
  expect(wantsUpfrontPlan('<operator-context>\nbuild everything\n</operator-context>\n\nhello there, how are you')).toBe(false)
  const paste = `what does this log mean\n${'line\n'.repeat(3)}we need to build the api and deploy it`
  expect(wantsUpfrontPlan(paste)).toBe(false)
})

test('an earlier plan briefing is stripped before a request is re-read', () => {
  const withPlan = `make the map dynamic\n\n${planBriefing(['one', 'two'])}`
  expect(stripInjectedContext(withPlan)).toBe('make the map dynamic')
})

test('a well-formed reply splits into thinking and steps', () => {
  const parsed = parsePlannerReply(
    'THINKING: The user wants a laptop picker. I will use one static page so it previews instantly.\nPLAN:\n1. Write index.html with the laptop data\n2. Add a filter by budget\n3. Open the page to check it renders',
  )
  expect(parsed).toEqual({
    thinking: 'The user wants a laptop picker. I will use one static page so it previews instantly.',
    steps: ['Write index.html with the laptop data', 'Add a filter by budget', 'Open the page to check it renders'],
  })
})

test('markdown-decorated and inline plan markers are both read', () => {
  expect(parsePlannerReply('**Thinking:** go small.\n\n**PLAN:**\n- **Scaffold** it\n- Verify it')?.steps).toEqual(['Scaffold it', 'Verify it'])
  expect(parsePlannerReply('Thinking: quick one.\nPLAN: 1. Edit app.ts\n2. Run the tests')?.steps).toEqual(['Edit app.ts', 'Run the tests'])
  // No marker at all — the numbered list is still the plan.
  expect(parsePlannerReply('I will do this in order.\n1. Read config\n2. Change it\n3. Test')).toMatchObject({
    thinking: 'I will do this in order.',
    steps: ['Read config', 'Change it', 'Test'],
  })
})

test('NONE, a single step, or no list at all is not a plan', () => {
  expect(parsePlannerReply('NONE')).toBeUndefined()
  expect(parsePlannerReply('none.')).toBeUndefined()
  expect(parsePlannerReply('THINKING: trivial.\nPLAN:\n1. Rename the variable')).toBeUndefined()
  expect(parsePlannerReply('Sure, I can help with that!')).toBeUndefined()
})

test('a long list is capped to a plan, not a project backlog', () => {
  const reply = `PLAN:\n${Array.from({ length: 15 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n')}`
  expect(parsePlannerReply(reply)?.steps).toHaveLength(8)
})

test('streamed thinking never shows the label or the plan, and never garbles on odd chunking', () => {
  const reply = 'THINKING: The user wants X. I will build Y first.\nPLAN:\n1. Build Y\n2. Check it'
  for (const size of [1, 3, 7, 40, reply.length]) {
    const shown: string[] = []
    const stream = createThinkingStream((delta) => shown.push(delta))
    for (let i = 0; i < reply.length; i += size) stream.push(reply.slice(i, i + size))
    expect(stream.finish()).toBe(reply)
    expect(shown.join('')).toBe('The user wants X. I will build Y first.')
  }
})

test('a NONE reply shows no thinking at all', () => {
  const shown: string[] = []
  const stream = createThinkingStream((delta) => shown.push(delta))
  stream.push('NO')
  stream.push('NE')
  stream.finish()
  expect(shown.join('')).toBe('')
  expect(visibleThinking('NONE', true)).toBe('')
})

test('the digest carries what was asked and done, not elia\'s own nudges or tool output', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: [text('create a static navigation map of kolkata')] },
    { role: 'assistant', content: [text('On it.'), { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'workspace/map/index.html', content: '<html>…</html>' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'wrote 4 KB', is_error: false }] },
    { role: 'user', content: [text('[elia] You are 8 tool calls into this task and have changed 4 thing(s) without writing down a plan.')] },
  ]
  const digest = conversationDigest(history)
  expect(digest).toContain('User: create a static navigation map of kolkata')
  expect(digest).toContain('elia ran: write_file workspace/map/index.html')
  expect(digest).not.toContain('<html>')
  expect(digest).not.toContain('without writing down a plan')
  expect(digest).not.toContain('wrote 4 KB')
})

/** A provider that streams a scripted reply and records what it was asked. */
function scriptedProvider(reply: string, options: { reasoning?: string; fail?: boolean } = {}): Provider & { calls: StreamTurnParams[] } {
  const calls: StreamTurnParams[] = []
  return {
    calls,
    async streamTurn(params) {
      calls.push(params)
      if (options.fail) throw new Error('provider down')
      if (options.reasoning) params.onThinking?.(options.reasoning)
      for (let i = 0; i < reply.length; i += 9) params.onText(reply.slice(i, i + 9))
      return { content: [text(reply)], usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
}

const REQUEST: ChatMessage[] = [{ role: 'user', content: [text('create a laptop suggestion website')] }]

test('drafting streams the thinking, returns the steps, and offers the model no tools', async () => {
  const provider = scriptedProvider('THINKING: A small static site fits. Data first, then filters.\nPLAN:\n1. Write the laptop data\n2. Build the filter UI\n3. Preview it')
  const thinking: string[] = []
  const plan = await draftUpfrontPlan({
    provider,
    cwd: '/tmp',
    system: 'SYSTEM',
    systemDynamic: 'MEMORY: lessons here',
    messages: REQUEST,
    request: 'create a laptop suggestion website',
    onThinking: (delta) => thinking.push(delta),
  })

  expect(plan?.steps).toEqual(['Write the laptop data', 'Build the filter UI', 'Preview it'])
  expect(thinking.join('')).toBe('A small static site fits. Data first, then filters.')
  expect(provider.calls[0]!.tools).toEqual([])
  // Same rules and project memory as the lead, so lessons shape the plan.
  expect(provider.calls[0]!.system).toBe('SYSTEM')
  expect(provider.calls[0]!.systemDynamic).toBe('MEMORY: lessons here')
  expect(plan?.usage.outputTokens).toBe(40)
})

test("the model's own reasoning streams too, kept apart from elia's written thinking", async () => {
  const provider = scriptedProvider('THINKING: Go static.\nPLAN:\n1. Build\n2. Check', { reasoning: 'hmm, static or react?' })
  const thinking: string[] = []
  await draftUpfrontPlan({ provider, cwd: '/tmp', system: 's', messages: REQUEST, request: 'build it', onThinking: (delta) => thinking.push(delta) })
  expect(thinking.join('')).toBe('hmm, static or react?\n\nGo static.')
})

test('an attached screenshot reaches the planner along with the request', async () => {
  const provider = scriptedProvider('THINKING: Match the mock.\nPLAN:\n1. Build the layout\n2. Compare to the screenshot')
  const withImage: ChatMessage[] = [
    { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'aGk=', alt: 'mock.png' }, text('build this page')] },
  ]
  await draftUpfrontPlan({ provider, cwd: '/tmp', system: 's', messages: withImage, request: 'build this page' })
  expect(provider.calls[0]!.messages[0]!.content.map((block) => block.type)).toEqual(['image', 'text'])
})

test('a failed or empty planning call yields no plan and never throws', async () => {
  expect(await draftUpfrontPlan({ provider: scriptedProvider('', { fail: true }), cwd: '/tmp', system: 's', messages: REQUEST, request: 'x' })).toBeUndefined()
  expect(await draftUpfrontPlan({ provider: scriptedProvider('NONE'), cwd: '/tmp', system: 's', messages: REQUEST, request: 'x' })).toBeUndefined()
})

test('the plan becomes a todo list with step one under way, and a checklist the plan panel can read', () => {
  expect(planTodoItems(['a', 'b'])).toEqual([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
  ])
  const activity = planActivity(['a', 'b'])
  expect(activity).toMatchObject({ kind: 'plan', status: 'completed', title: 'Plan · 2 steps' })
  expect(activity.detail).toBe('◐ a\n□ b')
  expect(planBriefing(['a', 'b'])).toContain('call todo_write')
})

test('neither the planner nor the plan it hands over licenses inventing a thing the request names', () => {
  // "install ponytail skill" was planned as "3. If it's a new skill, create the
  // necessary files"; the lead searched twice, found nothing, and followed step 3
  // to a stub that printed "installed". Both prompts now close that door.
  expect(plannerPrompt('install ponytail skill', '')).toMatch(/Never plan a step like "if it is new, create it"/)
  expect(plannerPrompt('install ponytail skill', '')).toContain('asks the user what they meant')
  const briefing = planBriefing(['Search for ponytail', 'If it is a new skill, create the files'])
  expect(briefing).toContain('A step is not permission to invent')
  expect(briefing).toMatch(/Never create a stub, placeholder/)
})

test('a provider failure is reported rather than swallowed, but NONE stays quiet', async () => {
  // The bug this pins: every failure here returned undefined silently, so a 402
  // from the provider and "the planner judged this too small to plan" produced
  // exactly the same thing on screen — no plan, no thinking, `Working…` — and
  // telling them apart took a debugging session.
  const problems: string[] = []
  await draftUpfrontPlan({
    provider: scriptedProvider('', { fail: true }),
    cwd: '/tmp', system: 's', messages: REQUEST, request: 'build a thing',
    onProblem: (message) => problems.push(message),
  })
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('provider down')

  // NONE is the planner working correctly on a small ask — nothing to report.
  const quiet: string[] = []
  await draftUpfrontPlan({
    provider: scriptedProvider('NONE'),
    cwd: '/tmp', system: 's', messages: REQUEST, request: 'x',
    onProblem: (message) => quiet.push(message),
  })
  expect(quiet).toEqual([])
})

test('pressing Esc during planning is not narrated as a failure', async () => {
  const controller = new AbortController()
  controller.abort()
  const problems: string[] = []
  const plan = await draftUpfrontPlan({
    provider: scriptedProvider('', { fail: true }),
    cwd: '/tmp', system: 's', messages: REQUEST, request: 'build a thing',
    signal: controller.signal,
    onProblem: (message) => problems.push(message),
  })
  expect(plan).toBeUndefined()
  expect(problems).toEqual([])
})

test('an escalated run thinks out loud first, and asks for reasoning rather than a plan', async () => {
  const provider = scriptedProvider('I read this as a plain Expo notes app. I will scaffold with create-expo-app and keep notes in AsyncStorage. The risk is the Expo CLI prompting for input and stalling the run.')
  const thinking: string[] = []
  const thought = await draftRunThinking({
    provider,
    cwd: '/tmp',
    system: 'PLANNER SYSTEM',
    systemDynamic: 'today is friday',
    goal: 'create a expo app for notetaking',
    context: 'empty directory',
    onThinking: (delta) => thinking.push(delta),
  })

  expect(thought?.thinking).toContain('create-expo-app')
  // It streamed as it was written, not dumped at the end.
  expect(thinking.length).toBeGreaterThan(1)
  expect(thinking.join('')).toBe(thought!.thinking)
  expect(provider.calls[0]!.tools).toEqual([])
  expect(provider.calls[0]!.system).toBe('PLANNER SYSTEM')
  const asked = provider.calls[0]!.messages[0]!.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  expect(asked).toContain('empty directory')
  expect(asked).toContain('Do not write the plan')
})

test("the run's opening thought never fails the run", async () => {
  expect(await draftRunThinking({ provider: scriptedProvider('', { fail: true }), cwd: '/tmp', system: 's', goal: 'build it' })).toBeUndefined()
  expect(await draftRunThinking({ provider: scriptedProvider('   '), cwd: '/tmp', system: 's', goal: 'build it' })).toBeUndefined()
})

test("the run's thinking prompt keeps the project out of it when there is none", () => {
  expect(runThinkingPrompt('build a notes app')).not.toContain('<project>')
  expect(runThinkingPrompt('build a notes app', 'package.json, src/')).toContain('<project>')
})

test('a reply that opens with blank lines does not leave the ✻ mark stranded above a gap', async () => {
  // mercury-2.5 does this, and the thinking block rendered as a lone ✻, then an
  // empty line, then the thought.
  const provider = scriptedProvider('\n\nI will scaffold it with create-expo-app.')
  const thinking: string[] = []
  const thought = await draftRunThinking({ provider, cwd: '/tmp', system: 's', goal: 'build it', onThinking: (delta) => thinking.push(delta) })
  expect(thinking.join('')).toBe('I will scaffold it with create-expo-app.')
  expect(thought!.thinking.startsWith('I will')).toBe(true)
})

test('the same blank opening does not strand the mark on a chat turn either', () => {
  expect(visibleThinking('\n\nGoing static, then checking it.', true)).toBe('Going static, then checking it.')
})
