import { expect, test } from 'bun:test'
import { dedupeRepeatedSentences } from './risk.ts'

test('collapses the same sentence repeated on separate lines', () => {
  const sentence = "The command 'go through battmann' is ambiguous and could trigger unknown actions; human confirmation is required."
  const text = [sentence, sentence, sentence].join('\n')
  expect(dedupeRepeatedSentences(text)).toBe(sentence)
})

test('collapses the same sentence repeated without a separator', () => {
  const sentence = 'This deletes files outside version control.'
  const text = `${sentence} ${sentence} ${sentence}`
  expect(dedupeRepeatedSentences(text)).toBe(sentence)
})

test('leaves genuinely different sentences untouched', () => {
  const text = 'This overwrites a tracked file. Recovery is possible via git.'
  expect(dedupeRepeatedSentences(text)).toBe(text)
})

test('is case-insensitive when detecting a repeat', () => {
  const text = 'Runs sudo. Runs SUDO.'
  expect(dedupeRepeatedSentences(text)).toBe('Runs sudo.')
})

test('passes a single sentence through unchanged', () => {
  expect(dedupeRepeatedSentences('Reads a file; fully reversible.')).toBe('Reads a file; fully reversible.')
})

test('handles an empty string', () => {
  expect(dedupeRepeatedSentences('')).toBe('')
})
