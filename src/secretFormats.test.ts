import { expect, test } from 'bun:test'
import { KNOWN_KEY_FORMATS } from './secretFormats.ts'

function matches(text: string): string[] {
  return KNOWN_KEY_FORMATS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name)
}

// Fakes built from parts so this file never holds a scannable literal itself.
const slack = ['xoxb', '1234567890', 'abcdefghijkl'].join('-')
const anthropic = `sk-ant-${'api03-'}${'a'.repeat(40)}`
const openaiProject = `sk-proj-${'Ab_9-'.repeat(8)}`

test('a real-shaped Slack token (hyphenated) is caught — the old repo scan expected an underscore', () => {
  expect(matches(`token: ${slack}`)).toEqual(['a Slack token'])
})

test('an Anthropic key is reported once, not also as an OpenAI key', () => {
  expect(matches(anthropic)).toEqual(['an Anthropic API key'])
})

test('OpenAI project keys with _ and - in the body are caught', () => {
  expect(matches(openaiProject)).toEqual(['an OpenAI API key'])
})

test('ordinary identifiers do not match', () => {
  expect(matches('const skipAntiAliasing = task-runner_config; // sk-short')).toEqual([])
})
