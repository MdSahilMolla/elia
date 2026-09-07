import { expect, test } from 'bun:test'
import { optionalString } from './args.ts'

test('an empty or whitespace-only optional argument reads as absent, not as an error', () => {
  // Models fill an optional field they have nothing for with "". Rejecting it
  // cost one run five actions across grep, list_files and board_read.
  expect(optionalString('', 'path')).toBeUndefined()
  expect(optionalString('   ', 'path')).toBeUndefined()
  expect(optionalString(undefined, 'path')).toBeUndefined()
  expect(optionalString(null, 'path')).toBeUndefined()
})

test('a real value is passed through untrimmed', () => {
  expect(optionalString('src/tools', 'path')).toBe('src/tools')
})

test('the wrong type is still a real mistake', () => {
  expect(() => optionalString(42, 'path')).toThrow('path must be a string when provided')
})
