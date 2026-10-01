import { expect, test } from 'bun:test'
import type { ChatMessage } from './providers/types.ts'
import { createHistoryTrimmer, historyTrimEnabled, historyTrimmerFor, modelViewOfResult, type HistoryTrimOptions } from './contextDiet.ts'

let id = 0
/** One tool round: the assistant's call, then its result. */
function round(name: string, input: Record<string, unknown>, result: string, isError = false): ChatMessage[] {
  const callId = `c${++id}`
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: callId, name, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: result, is_error: isError }] },
  ]
}
const filler = (n: number) => Array.from({ length: n }, () => round('todo_write', {}, 'ok')).flat()
/** Trims and returns what the model would be sent. */
function trimmed(messages: ChatMessage[], options: HistoryTrimOptions = { minSavingChars: 1 }): ChatMessage[] {
  const trimmer = createHistoryTrimmer(options)
  trimmer.update(messages)
  return trimmer.view(messages)
}
const resultOf = (messages: ChatMessage[], index: number) => (messages[index]!.content[0] as { content: string }).content
const inputOf = (messages: ChatMessage[], index: number) => (messages[index]!.content[0] as { input: Record<string, unknown> }).input

test('a created file is not echoed back to the model, but an overwrite diff and diagnostics stay', () => {
  const created = 'Created a.ts (+2 −0)\n```diff\n@@ -0,0 +1,2 @@\n+x\n+y\n```\n\nLSP diagnostics:\n  a.ts:1:1 error: boom'
  expect(modelViewOfResult('write_file', created, false)).toBe('Created a.ts (+2 −0)\n\nLSP diagnostics:\n  a.ts:1:1 error: boom')
  const overwrote = 'Overwrote a.ts (+1 −1)\n```diff\n-x\n+y\n```'
  expect(modelViewOfResult('write_file', overwrote, false)).toBe(overwrote)
  expect(modelViewOfResult('read_file', created, false)).toBe(created)
})

test('old long results are cut to their two ends; the recent rounds and small results are left whole', () => {
  const big = `${'L'.repeat(10_000)}${'T'.repeat(10_000)}`
  const messages = [...round('run_command', { command: 'bun test' }, big), ...round('grep', { pattern: 'x' }, 'small'), ...filler(6), ...round('run_command', { command: 'ls' }, big)]
  const trimmer = createHistoryTrimmer({ minSavingChars: 1 })
  expect(trimmer.update(messages)).toBeGreaterThan(15_000)
  const sent = trimmer.view(messages)
  expect(resultOf(sent, 1)).toStartWith('L'.repeat(600))
  expect(resultOf(sent, 1)).toEndWith('T'.repeat(600))
  expect(resultOf(sent, 1)).toContain('18800 characters from the middle')
  expect(resultOf(sent, 3)).toBe('small')
  expect(resultOf(sent, sent.length - 1)).toBe(big)
  // The conversation itself keeps everything.
  expect(resultOf(messages, 1)).toBe(big)
  // A second pass has nothing new to cut, and the cut stays decided.
  expect(trimmer.update(messages)).toBe(0)
  expect(resultOf(trimmer.view(messages), 1)).toContain('from the middle')
})

test('a read replaced by a later identical read or a write is dropped; a different window is not', () => {
  const messages = [
    ...round('read_file', { path: 'a.ts' }, 'old a'.repeat(100)),
    ...round('read_file', { path: 'b.ts', offset: 10 }, 'b window'.repeat(100)),
    ...round('read_file', { path: 'c.ts' }, 'old c'.repeat(100)),
    ...round('read_file', { path: 'a.ts' }, 'new a'),
    ...round('read_file', { path: 'b.ts' }, 'b whole'),
    ...round('write_file', { path: 'c.ts', content: 'c' }, 'Created c.ts'),
    ...filler(6),
  ]
  const sent = trimmed(messages)
  expect(resultOf(sent, 1)).toContain('replaced by a later read')
  expect(resultOf(sent, 3)).toBe('b window'.repeat(100))
  expect(resultOf(sent, 5)).toContain('replaced by a later write')
  expect(resultOf(sent, 7)).toBe('new a')
})

test('written file content leaves the history once old, unless the write failed', () => {
  const content = 'x'.repeat(10_000)
  const messages = [
    ...round('write_file', { path: 'ok.ts', content }, 'Created ok.ts'),
    ...round('write_file', { path: 'bad.ts', content }, 'EACCES', true),
    ...filler(6),
  ]
  const sent = trimmed(messages)
  expect(inputOf(sent, 0).content).toContain('the file is on disk')
  expect(inputOf(sent, 0).path).toBe('ok.ts')
  expect(inputOf(sent, 2).content).toBe(content)
  expect(inputOf(messages, 0).content).toBe(content)
})

test('nothing irreproducible is cut, and nothing happens below the batching threshold', () => {
  const report = 'R'.repeat(20_000)
  const messages = [...round('task', { prompt: 'look' }, report), ...round('read_file', { path: 'a' }, 'A'.repeat(5_000)), ...filler(6)]
  const batched = createHistoryTrimmer()
  expect(batched.update(messages)).toBe(0)
  expect(resultOf(batched.view(messages), 3)).toHaveLength(5_000)
  expect(resultOf(trimmed(messages), 1)).toBe(report)
})

test('history trimming is on except for Anthropic, and the env wins', () => {
  expect(historyTrimEnabled('openai-compatible', {})).toBe(true)
  expect(historyTrimEnabled('anthropic', {})).toBe(false)
  expect(historyTrimEnabled('anthropic', { ELIA_TRIM_HISTORY: 'on' })).toBe(true)
  expect(historyTrimEnabled('ollama', { ELIA_TRIM_HISTORY: 'off' })).toBe(false)
})

test('one conversation keeps one trimmer across turns', () => {
  const messages: ChatMessage[] = []
  expect(historyTrimmerFor(messages)).toBe(historyTrimmerFor(messages))
  expect(historyTrimmerFor([])).not.toBe(historyTrimmerFor(messages))
})
