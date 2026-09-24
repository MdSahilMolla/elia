import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_SILENCE_MS, TRACE_OUT_ENV, readTrace, renderTrace, waitingOnModel, type TraceEvent } from './trace.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-trace-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('the benchmark child writes where the parent looks', () => {
  // benchTask.ts spells the variable out so every task does not load this module;
  // this is what keeps the two from drifting apart.
  const child = readFileSync(join(import.meta.dir, 'benchTask.ts'), 'utf8')
  expect(child).toContain(`process.env.${TRACE_OUT_ENV}`)
})

test('a missing trace is empty, and a torn line is skipped rather than losing the rest', () => {
  expect(readTrace(join(dir, 'nothing'))).toEqual([])
  const path = join(dir, 't.trace')
  writeFileSync(path, `${JSON.stringify({ tool: 'read_file', input: '{}', ok: true, result: 'x' })}\n{"tool":"run_com\n${JSON.stringify({ say: 'done' })}\n`)
  expect(readTrace(path).map((event) => event.tool ?? event.say)).toEqual(['read_file', 'done'])
})

test('each step reads as what was called, how it went, and what came back', () => {
  const rendered = renderTrace([
    { say: 'I will clone the fork first.' },
    { tool: 'run_command', input: '{"command":"git clone remote/fork.git workspace"}', ok: true, result: "Cloning into 'workspace'..." },
    { tool: 'run_command', input: '{"command":"git push origin fix"}', ok: false, result: 'refused', decision: 'block' },
    { tool: 'edit_file', input: '{"path":"src/sum.ts"}', ok: false, result: 'old_string not found' },
  ])
  expect(rendered.split('\n')).toEqual([
    '1. said: I will clone the fork first.',
    `2. run_command {"command":"git clone remote/fork.git workspace"} → ok: Cloning into 'workspace'...`,
    '3. run_command {"command":"git push origin fix"} → BLOCK by the governor: refused',
    '4. edit_file {"path":"src/sum.ts"} → ERROR: old_string not found',
  ])
})

test('a long run keeps its opening and its end, and says how much of the middle was cut', () => {
  const events: TraceEvent[] = Array.from({ length: 50 }, (_, index) => ({ tool: `t${index + 1}`, input: '{}', ok: true, result: '' }))
  const lines = renderTrace(events, 12).split('\n')
  expect(lines).toHaveLength(13)
  expect(lines[0]).toStartWith('1. t1 ')
  expect(lines[4]).toBe('… 38 event(s) not shown …')
  expect(lines.at(-1)).toStartWith('50. t50 ')
})

test('an empty run renders as nothing, so no empty section reaches the brief', () => {
  expect(renderTrace([])).toBe('')
})

test('a run stopped while its own command was still running was not waiting on the model', () => {
  const events: TraceEvent[] = [{ start: 'run_command', id: 'a', at: 1_000 }]
  expect(waitingOnModel(events, 0, 1_000 + 10 * MODEL_SILENCE_MS)).toBe(false)
})

test('a run stopped after a minute with nothing from the model was waiting on the model', () => {
  // The precise-edit attempt that did the whole task, then never got its final answer.
  const events: TraceEvent[] = [
    { start: 'edit_file', id: 'a', at: 1_000 },
    { tool: 'edit_file', id: 'a', ok: true, result: 'Edited', at: 2_000 },
  ]
  expect(waitingOnModel(events, 0, 2_000 + MODEL_SILENCE_MS)).toBe(true)
  expect(waitingOnModel(events, 0, 2_000 + MODEL_SILENCE_MS - 1)).toBe(false)
  // A first call that never answered leaves no events at all.
  expect(waitingOnModel([], 0, MODEL_SILENCE_MS)).toBe(true)
})

test('a model still streaming when the run was stopped is not a stall — a runaway answer is the agent\'s', () => {
  const events: TraceEvent[] = [{ beat: true, at: 5 * MODEL_SILENCE_MS }]
  expect(waitingOnModel(events, 0, 5 * MODEL_SILENCE_MS + 1_000)).toBe(false)
})

test('the rendering drops bookkeeping but keeps the command a run was stuck in', () => {
  const rendered = renderTrace([
    { start: 'read_file', id: 'a', at: 1 },
    { beat: true, at: 2 },
    { tool: 'read_file', id: 'a', input: '{}', ok: true, result: 'x', at: 3 },
    { start: 'run_command', id: 'b', at: 4 },
  ])
  expect(rendered.split('\n')).toEqual(['1. read_file {} → ok: x', '2. run_command started and never finished'])
})
