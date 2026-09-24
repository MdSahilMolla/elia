import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearRunControl, readRunControl, requestRunControl, runControlPath, takeRunControlCorruption } from './control.ts'

function fixture(): { root: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), 'elia-control-'))
  const runId = '2026-08-24-test-run'
  mkdirSync(join(root, runId), { recursive: true })
  return { root, runId }
}

test('writes and reads a durable stop request, then clears it', () => {
  const { root, runId } = fixture()
  expect(requestRunControl(runId, 'stop', root)).toBe(true)
  const request = readRunControl(runId, root)
  expect(request?.action).toBe('stop')
  expect(request?.version).toBe(1)
  expect(existsSync(runControlPath(runId, root))).toBe(true)
  clearRunControl(runId, root)
  expect(readRunControl(runId, root)).toBeUndefined()
})

test('rejects missing runs and unsafe run ids', () => {
  const { root } = fixture()
  expect(requestRunControl('missing-run', 'pause', root)).toBe(false)
  expect(() => runControlPath('../outside', root)).toThrow('Invalid run id')
  expect(() => readRunControl('../outside', root)).toThrow('Invalid run id')
})

test('corrupt control file is reported once via takeRunControlCorruption', () => {
  const { root, runId } = fixture()
  writeFileSync(runControlPath(runId, root), '{not json')
  expect(readRunControl(runId, root)).toBeUndefined()
  expect(takeRunControlCorruption(runId)).toEqual({ runId, path: runControlPath(runId, root) })
  expect(takeRunControlCorruption(runId)).toBeUndefined()
})

test('a corrupt control file is reported to its own run only', () => {
  const { root, runId } = fixture()
  writeFileSync(runControlPath(runId, root), '{not json')
  expect(readRunControl(runId, root)).toBeUndefined()
  expect(takeRunControlCorruption('some-other-run')).toBeUndefined()
  expect(takeRunControlCorruption(runId)?.path).toBe(runControlPath(runId, root))
})

test('valid pause request leaves no corruption note', () => {
  const { root, runId } = fixture()
  expect(requestRunControl(runId, 'pause', root)).toBe(true)
  const request = readRunControl(runId, root)
  expect(request?.action).toBe('pause')
  expect(takeRunControlCorruption(runId)).toBeUndefined()
})

test('absent control file leaves no corruption note', () => {
  const { root, runId } = fixture()
  expect(readRunControl(runId, root)).toBeUndefined()
  expect(takeRunControlCorruption(runId)).toBeUndefined()
})

test('unknown-format control file is not corruption', () => {
  const { root, runId } = fixture()
  writeFileSync(runControlPath(runId, root), '{"version": 2, "action": "pause"}')
  expect(readRunControl(runId, root)).toBeUndefined()
  expect(takeRunControlCorruption(runId)).toBeUndefined()
})
