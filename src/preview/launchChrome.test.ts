import { expect, test } from 'bun:test'
import { findChromePath } from './launchChrome.ts'

test('findChromePath returns undefined when none of the candidate paths exist', () => {
  expect(findChromePath(() => false)).toBeUndefined()
})

test('findChromePath returns the first candidate path that exists', () => {
  let calls = 0
  const exists = () => {
    calls += 1
    return calls === 2 // only the second candidate "exists"
  }
  const found = findChromePath(exists)
  expect(found).toBeDefined()
  expect(calls).toBe(2)
})
