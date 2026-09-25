import { expect, test } from 'bun:test'
import { isIdle, sessionKeyAction, shouldAutoFocus } from './sessionActions.ts'

test('ctrl-shift-n maps to spawn', () => {
  expect(sessionKeyAction('ctrl-shift-n', 0, 2)).toEqual({ type: 'spawn' })
  expect(sessionKeyAction('ctrl-shift-n', -1, 0)).toEqual({ type: 'spawn' })
})

test('ctrl-tab cycles forward, ctrl-shift-tab cycles backward', () => {
  expect(sessionKeyAction('ctrl-tab', 1, 3)).toEqual({ type: 'cycle-next' })
  expect(sessionKeyAction('ctrl-shift-tab', 1, 3)).toEqual({ type: 'cycle-prev' })
})

test('cycling with no sessions or an out-of-range active index is a no-op', () => {
  expect(sessionKeyAction('ctrl-tab', 0, 0)).toEqual({ type: 'none' })
  expect(sessionKeyAction('ctrl-shift-tab', 0, 0)).toEqual({ type: 'none' })
  expect(sessionKeyAction('ctrl-tab', -1, 3)).toEqual({ type: 'none' })
  expect(sessionKeyAction('ctrl-shift-tab', 5, 3)).toEqual({ type: 'none' })
})

test('unknown key combos are a no-op', () => {
  expect(sessionKeyAction('ctrl-s', 0, 2)).toEqual({ type: 'none' })
  expect(sessionKeyAction('tab', 0, 2)).toEqual({ type: 'none' })
})

test('shouldAutoFocus returns the first WAITING_INPUT session index', () => {
  const statuses = ['running', 'waiting-input', 'idle', 'waiting-input']
  expect(shouldAutoFocus(statuses as 'running'[])).toBe(1)
})

test('shouldAutoFocus ignores a busy or settled fleet', () => {
  expect(shouldAutoFocus(['running', 'blocked', 'idle'])).toBeUndefined()
  expect(shouldAutoFocus([])).toBeUndefined()
  expect(shouldAutoFocus(['done', 'errored', 'running'])).toBeUndefined()
})

test('isIdle is true only when not in a turn or prompt phase', () => {
  expect(isIdle({ running: false })).toBe(true)
  expect(isIdle({ running: true })).toBe(false)
})