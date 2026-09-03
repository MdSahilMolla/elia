import { expect, test } from 'bun:test'
import { dedupeRepeatedSentences, looksObviouslySafe } from './risk.ts'

test('looksObviouslySafe skips the classifier for plain questions', () => {
  expect(looksObviouslySafe('what are you good at')).toBe(true)
  expect(looksObviouslySafe('how does the autonomy governor work?')).toBe(true)
  expect(looksObviouslySafe('explain the caching layer')).toBe(true)
  expect(looksObviouslySafe('summarize this project')).toBe(true)
})

test('looksObviouslySafe still routes anything that could act to the classifier', () => {
  expect(looksObviouslySafe('add a --json flag to the export command')).toBe(false) // not a question opener
  expect(looksObviouslySafe('how do I rm -rf the build dir')).toBe(false) // shell token
  expect(looksObviouslySafe('what if we force-push to main')).toBe(false) // risk keyword
  expect(looksObviouslySafe('can you delete the old migrations')).toBe(false) // risk keyword
  expect(looksObviouslySafe(`what ${'x'.repeat(300)}`)).toBe(false) // too long to be a quick question
})

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
