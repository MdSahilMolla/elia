import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearRunControl, readRunControl, requestRunControl, runControlPath } from './control.ts'

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
