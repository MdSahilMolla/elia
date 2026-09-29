import { expect, test } from 'bun:test'
import type { ContentBlock } from '../providers/types.ts'
import { createLeakedToolCallGuard, findLeakedToolCalls, leakedToolCallNote, stripLeakedToolCalls } from './leakedToolCall.ts'

// What mercury-2.5 wrote in place of a tool call (reported session, 2026-09-29).
const LEAKED =
  'I will pull the data.\n\n<function=battmann> <parameter=action> feed_query </parameter> <parameter=feed> fx </parameter> </function> <|tool_call_end|><function=battmann> <parameter=action> feed_query </parameter> <parameter=feed> commodity </parameter> </function> <|tool_call_end|>'

test('finds the tool named in a call written as text', () => {
  expect(findLeakedToolCalls(LEAKED)).toEqual(['battmann'])
  expect(findLeakedToolCalls('<function=a>x</function> and <function=b>y</function>')).toEqual(['a', 'b'])
  expect(findLeakedToolCalls('<tool_call>{"name": "read_file", "arguments": {}}</tool_call>')).toEqual(['read_file'])
})

test('a bare call-boundary token still counts, with no name to report', () => {
  expect(findLeakedToolCalls('done <|tool_call_end|>')).toEqual([])
})

test('ordinary prose, code and angle brackets are not a leaked call', () => {
  for (const text of ['Here is the result: 42', 'Use <div class="x"> for that', 'function foo() { return 1 }', 'the <function> keyword', '<tool_call> is a Hermes tag', '']) {
    expect(findLeakedToolCalls(text)).toBeUndefined()
  }
})

test('stripping keeps the prose, marks each call, and drops the boundary tokens', () => {
  const stripped = stripLeakedToolCalls(LEAKED)
  expect(stripped).toContain('I will pull the data.')
  expect(stripped).not.toMatch(/<function=|<parameter=|tool_call_end/)
  expect(stripped.match(/did not run/g)).toHaveLength(2)
})

test('an unclosed call is cut to the end, and a bare token never leaves an empty block', () => {
  expect(stripLeakedToolCalls('start <function=battmann> <parameter=action> feed_qu')).toBe('start [a tool call written as text here did not run]')
  expect(stripLeakedToolCalls('<|tool_call_end|>')).not.toBe('')
})

test('the note names the tool and tells the model nothing ran', () => {
  const note = leakedToolCallNote(['battmann'])
  expect(note).toContain('battmann')
  expect(note).toContain('did not run')
  expect(note).toMatch(/Do not describe it as running or waiting/)
})

test('the guard strips in place, asks for a correction, and gives up after its retries', () => {
  const guard = createLeakedToolCallGuard(2)
  const turn = (): ContentBlock[] => [{ type: 'text', text: LEAKED }]

  const first = turn()
  const one = guard.observe(first)
  expect(one.leaked).toBe(true)
  expect(one.note).toContain('battmann')
  expect(first[0]).toMatchObject({ type: 'text' })
  expect((first[0] as { text: string }).text).not.toContain('<function=')

  expect(guard.observe(turn()).note).toBeDefined()
  const spent = guard.observe(turn())
  expect(spent.leaked).toBe(true)
  expect(spent.note).toBeUndefined()
})

test('a clean reply is left untouched and costs no retry', () => {
  const guard = createLeakedToolCallGuard(1)
  const clean: ContentBlock[] = [{ type: 'text', text: 'All done.' }]
  expect(guard.observe(clean)).toEqual({ leaked: false })
  expect(clean).toEqual([{ type: 'text', text: 'All done.' }])
  expect(guard.observe([{ type: 'text', text: LEAKED }]).note).toBeDefined() // the one retry is still there
})
