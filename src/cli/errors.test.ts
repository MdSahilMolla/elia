import { expect, test } from 'bun:test'
import { describeCliError } from './errors.ts'

test('a failure names the command, keeps the message, and drops a repeated "Error:"', () => {
  expect(describeCliError(new Error('Error: boom'), { command: 'bench' })).toBe('elia bench failed: boom')
  expect(describeCliError('plain string')).toBe('elia failed: plain string')
  expect(describeCliError(new Error('x'), { subject: 'This turn' })).toBe('This turn failed: x')
})

test('a common failure class gets the one next step that always applies', () => {
  expect(describeCliError(new Error("EACCES: permission denied, open '/etc/x'"), { command: 'config' })).toContain('Permission denied — check')
  expect(describeCliError(new Error('listen EADDRINUSE: address already in use :::4319'), { command: 'bridge' })).toContain('port is already in use')
  expect(describeCliError(new Error("fatal: a branch named 'elia/session-a' already exists"), { command: 'sessions' })).toContain('elia sessions prune')
  expect(describeCliError(new Error('401 Incorrect API key provided'))).toContain('elia config')
  expect(describeCliError(new Error('something unusual'))).not.toContain('\n')
})

test('secrets are redacted and a long message is bounded', () => {
  const described = describeCliError(new Error(`bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}`))
  expect(described).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
  expect(described).toContain('more lines')
  expect(described.split('\n').length).toBeLessThanOrEqual(8)
})
