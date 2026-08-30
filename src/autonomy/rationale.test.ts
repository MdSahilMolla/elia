import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { explainRationale, loadRationale, queryRationale, recordRationale, renderRationale } from './rationale.ts'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-rat-'))
  path = join(dir, 'rationale.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('records and loads a rationale entry', () => {
  recordRationale({ path: 'src/agentLoop.ts', decision: 'serialize file writes behind a global lock', reason: 'parallel edits corrupt files', source: 'agent' }, path)
  const all = loadRationale(path)
  expect(all).toHaveLength(1)
  expect(all[0]?.decision).toContain('serialize')
})

test('dedupes an identical decision for the same path', () => {
  const r = { path: 'a.ts', decision: 'use a lock', reason: 'races', source: 'agent' as const }
  recordRationale(r, path)
  recordRationale(r, path)
  expect(loadRationale(path)).toHaveLength(1)
})

test('drops entries missing a required field', () => {
  recordRationale({ path: 'a.ts', decision: '', reason: 'x', source: 'agent' }, path)
  expect(loadRationale(path)).toHaveLength(0)
})

test('queryRationale boosts an exact path match', () => {
  recordRationale({ path: 'src/auth/login.ts', decision: 'hash with argon2id', reason: 'bcrypt max length', source: 'agent' }, path)
  recordRationale({ path: 'src/ui/theme.ts', decision: 'yellow accent', reason: 'brand', source: 'agent' }, path)
  const hits = queryRationale('changing the color', ['src/auth/login.ts'], 5, path)
  expect(hits[0]?.path).toBe('src/auth/login.ts')
})

test('renderRationale produces an injectable section or empty string', () => {
  expect(renderRationale('anything', [], path)).toBe('')
  recordRationale({ path: 'src/retry.ts', decision: 'exponential backoff capped at 30s', reason: 'upstream 429s', alternatives: 'linear — too slow to recover', source: 'agent' }, path)
  const rendered = renderRationale('retry backoff', ['src/retry.ts'], path)
  expect(rendered).toContain('Why this code is the way it is')
  expect(rendered).toContain('exponential backoff')
  expect(rendered).toContain('rejected: linear')
})

test('explainRationale is human-readable', () => {
  recordRationale({ path: 'src/x.ts', anchor: 'parseConfig', decision: 'tolerate a missing file', reason: 'first run has no config', source: 'user' }, path)
  const out = explainRationale('src/x.ts', path)
  expect(out).toContain('parseConfig')
  expect(out).toContain('reason:')
})
