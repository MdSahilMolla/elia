import { expect, test } from 'bun:test'
import type { ToolEvent } from './agentLoop.ts'
import { requiredToolReminders } from './requiredTool.ts'

function event(name: string, isError = false): ToolEvent {
  return { name, input: {}, result: isError ? 'rejected' : 'ok', isError, durationMs: 1, cached: false }
}

test('a worker still reading near the end of its budget is told to make the call while it still can', () => {
  const reminders = requiredToolReminders('submit_verdict', 30)
  // Top of each step, each after a batch of reads.
  const directives: string[][] = []
  for (let step = 1; step <= 30; step++) {
    directives.push(reminders.drain())
    reminders.onTool(event('read_file'))
  }
  const warnedAt = directives.findIndex((batch) => batch.length > 0) + 1
  // Steps 28, 29 and 30 remain: the one that reads it and two spare.
  expect(warnedAt).toBe(28)
  expect(directives[27]![0]).toContain('call submit_verdict now')
  // Once, not every step after.
  expect(directives.filter((batch) => batch.length > 0)).toHaveLength(1)
})

test('a worker that ends in prose without the call is nudged once, then left to fail the gate', () => {
  const reminders = requiredToolReminders('submit_verdict', 30)
  expect(reminders.drain()).toEqual([]) // step 1
  reminders.onTool(event('read_file'))
  expect(reminders.drain()).toEqual([]) // step 2, after a read
  // The reply to step 2 called no tools: the loop drains once more before ending.
  expect(reminders.drain()[0]).toContain('finishing without calling submit_verdict')
  // It answers in prose again. No second nudge — the gate fails closed as before.
  expect(reminders.drain()).toEqual([])
})

test('nothing more is said once the call has been made', () => {
  const reminders = requiredToolReminders('submit_acceptance', 10)
  reminders.drain()
  reminders.onTool(event('submit_acceptance'))
  for (let step = 0; step < 12; step++) expect(reminders.drain()).toEqual([])
})

test('a rejected call does not count as made', () => {
  const reminders = requiredToolReminders('submit_verdict', 30)
  reminders.drain()
  // "revise" with no issues is refused by the tool; the worker must call again.
  reminders.onTool(event('submit_verdict', true))
  reminders.drain()
  expect(reminders.drain()[0]).toContain('finishing without calling submit_verdict')
})
