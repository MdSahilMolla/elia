import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CorruptStateError, noteCorruptState, parseLocalJson } from './localJson.ts'

const dir = mkdtempSync(join(tmpdir(), 'elia-local-json-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('a corrupt local file is an error that names the file and the reason, not a bare SyntaxError', () => {
  expect(parseLocalJson('{"a":1}', '/x/state.json')).toEqual({ a: 1 })
  let thrown: unknown
  try {
    parseLocalJson('{"a":', '/x/state.json')
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CorruptStateError)
  expect((thrown as CorruptStateError).path).toBe('/x/state.json')
  expect((thrown as Error).message).toContain('/x/state.json could not be read')
})

test('a loader that degrades says so, and can keep the bad file for later', () => {
  const file = join(dir, 'allow.json')
  const log = join(dir, 'diagnostics.log')
  writeFileSync(file, '{"rules": [')
  noteCorruptState('test.scope', file, new SyntaxError('Unexpected end of JSON input'), { keepCopy: true, diagnosticsPath: log })
  const line = JSON.parse(readFileSync(log, 'utf8').trim()) as { scope: string; message: string; context: { path: string } }
  expect(line.scope).toBe('test.scope')
  expect(line.message).toContain('Unexpected end')
  expect(line.context.path).toBe(file)
  expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe('{"rules": [')
  // No copy unless asked, and a missing file is not an error of its own.
  noteCorruptState('test.scope', join(dir, 'gone.json'), new Error('x'), { keepCopy: true, diagnosticsPath: log })
  expect(existsSync(join(dir, 'gone.json.corrupt'))).toBe(false)
})
