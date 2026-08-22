import { expect, test } from 'bun:test'
import { redactRecord, redactText } from './redact.ts'

test('redacts credential-shaped keys recursively', () => {
  expect(redactRecord({ apiKey: 'sk-test-secret', nested: { authorization: 'Bearer abcdefghijklmnop' } })).toEqual({
    apiKey: '[REDACTED]',
    nested: { authorization: '[REDACTED]' },
  })
})

test('redacts common secret-shaped values in free text and bounds previews', () => {
  expect(redactText('token=ghp_1234567890abcdefghij')).toContain('[REDACTED]')
  expect(redactText('a '.repeat(200), 30).length).toBe(30)
})
