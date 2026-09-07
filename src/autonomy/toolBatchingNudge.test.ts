import { expect, test } from 'bun:test'
import { createPlanlessWorkTracker } from './toolBatchingNudge.ts'
import { createRedundantReadTracker, isLoneBatchableRead, serialReadNudge, SERIAL_READ_NUDGE_THRESHOLD } from './toolBatchingNudge.ts'

test('isLoneBatchableRead is true only for a single read_file / grep / list_files call', () => {
  expect(isLoneBatchableRead(['read_file'])).toBe(true)
  expect(isLoneBatchableRead(['grep'])).toBe(true)
  expect(isLoneBatchableRead(['list_files'])).toBe(true)

  expect(isLoneBatchableRead(['read_file', 'read_file'])).toBe(false) // already batched
  expect(isLoneBatchableRead(['edit_file'])).toBe(false) // not a read
  expect(isLoneBatchableRead(['run_command'])).toBe(false)
  expect(isLoneBatchableRead([])).toBe(false)
})

test('serialReadNudge stays quiet until the streak crosses the threshold, then names the count', () => {
  for (let streak = 0; streak < SERIAL_READ_NUDGE_THRESHOLD; streak++) {
    expect(serialReadNudge(streak)).toBeUndefined()
  }
  const nudge = serialReadNudge(SERIAL_READ_NUDGE_THRESHOLD)
  expect(nudge).toBeDefined()
  expect(nudge).toContain(String(SERIAL_READ_NUDGE_THRESHOLD))
  expect(nudge).toContain('SINGLE response')
})

test('redundant-read tracker stays quiet on first reads and fires on a re-read of an unchanged file', () => {
  const tracker = createRedundantReadTracker()
  expect(tracker.observe([{ name: 'read_file', path: 'src/a.ts' }, { name: 'read_file', path: 'src/b.ts' }])).toBeUndefined()
  // re-reading a.ts, no write in between
  const nudge = tracker.observe([{ name: 'read_file', path: './src/a.ts' }])
  expect(nudge).toBeDefined()
  expect(nudge).toContain('src/a.ts')
  expect(nudge).toContain("don't re-read")
})

test('redundant-read tracker allows a re-read after the file was edited', () => {
  const tracker = createRedundantReadTracker()
  tracker.observe([{ name: 'read_file', path: 'src/a.ts' }])
  tracker.observe([{ name: 'edit_file', path: 'src/a.ts' }])
  expect(tracker.observe([{ name: 'read_file', path: 'src/a.ts' }])).toBeUndefined()
})

test('an agent several changes into multi-step work with no plan is asked once for one', () => {
  // One worker made 19 tool calls in a single assignment with nothing written
  // down; todo_write was called 0 times in 578 actions across four runs.
  const tracker = createPlanlessWorkTracker()

  expect(tracker.observe(['read_file', 'read_file', 'grep'])).toBeUndefined()
  expect(tracker.observe(['write_file', 'edit_file'])).toBeUndefined()
  const nudge = tracker.observe(['run_command', 'read_file', 'edit_file'])

  expect(nudge).toContain('todo_write')
  expect(nudge).toContain('one item in_progress')
  // Said once, never repeated.
  expect(tracker.observe(['edit_file', 'run_command', 'write_file'])).toBeUndefined()
})

test('an agent that writes a plan is never nudged about it', () => {
  const tracker = createPlanlessWorkTracker()
  expect(tracker.observe(['todo_write'])).toBeUndefined()

  for (let i = 0; i < 5; i += 1) {
    expect(tracker.observe(['write_file', 'edit_file', 'run_command'])).toBeUndefined()
  }
})

test('a short assignment is left alone — a one-file step should not produce a checklist', () => {
  const tracker = createPlanlessWorkTracker()
  expect(tracker.observe(['read_file', 'write_file', 'run_command'])).toBeUndefined()
})

test('a long read-only investigation with no changes is not nudged', () => {
  const tracker = createPlanlessWorkTracker()
  expect(tracker.observe(['read_file', 'grep', 'list_files', 'read_file', 'grep', 'read_file', 'grep', 'list_files', 'read_file'])).toBeUndefined()
})
