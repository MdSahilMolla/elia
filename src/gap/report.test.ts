import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLatestGapVector } from './report.ts'
import type { GapVector } from './types.ts'

function vector(id: string): GapVector {
  return {
    at: '2026-01-01T00:00:00.000Z',
    ref: `test-${id}`,
    defectsTotal: 1,
    defectsScored: 1,
    mechanicalCatchRate: 0.5,
    falsePositiveRate: 0,
    byRegime: { mechanical: { total: 1, caught: 1 }, empirical: { total: 0, caught: 0 }, judgment: { total: 0, caught: 0 } },
    byRung: {},
    calibrationContradictionRate: 0,
    escapees: [],
  }
}

function historyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gap-report-'))
  mkdirSync(join(dir, '.elia', 'gap'), { recursive: true })
  return dir
}

const history = (dir: string) => join(dir, '.elia', 'gap', 'history.ndjson')

test('readLatestGapVector returns the most recent valid vector from the tail', () => {
  const dir = historyDir()
  writeFileSync(history(dir), `${JSON.stringify(vector('older'))}\n${JSON.stringify(vector('newer'))}\n`)
  expect(readLatestGapVector(dir)?.ref).toBe('test-newer')
})

test('readLatestGapVector skips a torn trailing fragment instead of returning nothing', () => {
  const dir = historyDir()
  writeFileSync(history(dir), `${JSON.stringify(vector('older'))}\n${JSON.stringify(vector('newer'))}\n${JSON.stringify(vector('torn-newest') as unknown)!.slice(0, 40)}\n`)
  expect(readLatestGapVector(dir)?.ref).toBe('test-newer')
})

test('readLatestGapVector skips corrupt lines when scanning back', () => {
  const dir = historyDir()
  writeFileSync(history(dir), `not json\n${JSON.stringify(vector('newer'))}\nbroken trailing\n`)
  expect(readLatestGapVector(dir)?.ref).toBe('test-newer')
})

test('readLatestGapVector returns undefined when nothing valid is logged', () => {
  const dir = historyDir()
  writeFileSync(history(dir), `not json\n${'broken trailing\n'.repeat(2)}`)
  expect(readLatestGapVector(dir)).toBeUndefined()

  const empty = mkdtempSync(join(tmpdir(), 'gap-report-empty-'))
  mkdirSync(join(empty, '.elia', 'gap'), { recursive: true })
  writeFileSync(history(empty), '')
  expect(readLatestGapVector(empty)).toBeUndefined()
})