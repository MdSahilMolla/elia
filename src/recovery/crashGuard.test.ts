import { expect, test } from 'bun:test'
import { CRASH_EXIT_CODE, createCrashGuard } from './crashGuard.ts'
import type { FaultContext, FaultRecord } from './faults.ts'

function harness(options: { sessionId?: string; now?: () => number } = {}) {
  const recorded: FaultContext[] = []
  const warnings: string[] = []
  const exits: Array<{ code: number; message: string }> = []
  const guard = createCrashGuard({
    command: 'repl',
    sessionId: () => options.sessionId,
    record: (error, context) => {
      recorded.push(context)
      return { signature: `sig-${String(error instanceof Error ? error.message : error)}`, name: 'TypeError', message: String(error instanceof Error ? error.message : error), frames: ['src/a.ts:1 f'] } as FaultRecord
    },
    warn: (text) => warnings.push(text),
    exit: (code, message) => exits.push({ code, message }),
    ...(options.now ? { now: options.now } : {}),
  })
  return { guard, recorded, warnings, exits }
}

test('an uncaught exception is recorded as fatal and ends the process, saying how to resume', () => {
  const { guard, recorded, exits } = harness({ sessionId: 's-42' })
  guard.onUncaughtException(new TypeError('boom'))
  expect(recorded).toEqual([{ source: 'uncaught-exception', command: 'repl', fatal: true, sessionId: 's-42' }])
  expect(exits).toHaveLength(1)
  expect(exits[0]!.code).toBe(CRASH_EXIT_CODE)
  expect(exits[0]!.message).toContain('elia --resume s-42')
  expect(exits[0]!.message).toContain('Recorded as sig-boom')
  // A second throw on the way out does not start a second shutdown.
  guard.onUncaughtException(new TypeError('again'))
  expect(exits).toHaveLength(1)
})

test('an unhandled rejection is recorded and the session carries on, warning once per bug', () => {
  const { guard, recorded, warnings, exits } = harness()
  guard.onUnhandledRejection(new Error('lost'))
  guard.onUnhandledRejection(new Error('lost'))
  guard.onUnhandledRejection(new Error('other'))
  expect(recorded.map((context) => context.fatal)).toEqual([false, false, false])
  expect(warnings).toHaveLength(2)
  expect(warnings[0]).toContain('carried on')
  expect(exits).toEqual([])
})

test('a burst of rejections is a loop, and is treated as a crash', () => {
  let clock = 0
  const { guard, exits } = harness({ now: () => clock })
  for (let index = 0; index < 20; index += 1) guard.onUnhandledRejection(new Error('loop'))
  expect(exits).toEqual([])
  guard.onUnhandledRejection(new Error('loop'))
  expect(exits).toHaveLength(1)
  expect(exits[0]!.message).toContain('21 unhandled promise rejections in a minute')

  // Spread out over time, the same count is not a burst.
  clock = 0
  const spread = harness({ now: () => clock })
  for (let index = 0; index < 30; index += 1) {
    clock += 10_000
    spread.guard.onUnhandledRejection(new Error('slow'))
  }
  expect(spread.exits).toEqual([])
})

test('only a conversation is pointed at --resume; other commands at elia doctor', () => {
  const recorded: FaultContext[] = []
  const exits: string[] = []
  const guard = createCrashGuard({
    command: 'auto',
    sessionId: () => 'task-7',
    record: (_error, context) => (recorded.push(context), undefined),
    exit: (_code, message) => exits.push(message),
  })
  guard.onUncaughtException(new Error('x'))
  expect(exits[0]).not.toContain('--resume')
  expect(exits[0]).toContain('elia doctor shows how to pick it up')
  expect(exits[0]).toContain('It could not be recorded.')
})
