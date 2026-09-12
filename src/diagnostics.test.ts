import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logSwallowedError } from './diagnostics.ts'

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'elia-diagnostics-')), 'diagnostics.ndjson')
}

test('records scope, message, and context as one redacted NDJSON line', () => {
  const path = logPath()
  logSwallowedError('session.load', new Error('boom'), { taskId: 'abc', apiKey: 'sk-super-secret-1234567890' }, path)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(1)
  const record = JSON.parse(lines[0]!)
  expect(record.scope).toBe('session.load')
  expect(record.message).toBe('boom')
  expect(record.context.taskId).toBe('abc')
  expect(record.context.apiKey).toBe('[REDACTED]')
  expect(typeof record.at).toBe('string')
})

test('accepts a non-Error value without throwing', () => {
  const path = logPath()
  expect(() => logSwallowedError('daemon.parse', 'not an Error instance', undefined, path)).not.toThrow()
  const record = JSON.parse(readFileSync(path, 'utf8').trim())
  expect(record.message).toBe('not an Error instance')
  expect(record.context).toBeUndefined()
})

test('never throws even when the log path is unwritable', () => {
  expect(() => logSwallowedError('x', new Error('y'), undefined, join('Z:', 'no-such-drive', 'diagnostics.ndjson'))).not.toThrow()
})
