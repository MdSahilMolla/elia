import { expect, test } from 'bun:test'
import { activeMention } from './fileComplete.ts'

test('activeMention finds an open @-token at the cursor', () => {
  expect(activeMention('look at @src/foo', 16)).toEqual({ start: 8, query: 'src/foo' })
  expect(activeMention('@scheduler', 10)).toEqual({ start: 0, query: 'scheduler' })
})

test('activeMention rejects a closed mention or one mid-word', () => {
  // whitespace after the token — no longer being typed
  expect(activeMention('@src/foo bar', 12)).toBeNull()
  // @ glued to a preceding word (an email, a decorator) is not a mention
  expect(activeMention('foo@bar', 7)).toBeNull()
  // no @ before the cursor
  expect(activeMention('plain text', 5)).toBeNull()
})

test('activeMention tracks the token the cursor is actually in', () => {
  const buffer = 'diff @a/one and @b/two'
  expect(activeMention(buffer, 8)).toEqual({ start: 5, query: 'a/' })
  expect(activeMention(buffer, buffer.length)).toEqual({ start: 16, query: 'b/two' })
})
