import { expect, test } from 'bun:test'
import type { GenerationRecord, Metrics } from './ledger.ts'
import { learningRate, renderLedgerForPrompt } from './ledger.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const metrics = (passRate: number, over: Partial<Metrics> = {}): Metrics => ({
  passRate,
  passed: [],
  failed: [],
  totalTokens: 10_000,
  totalElapsedMs: 60_000,
  wallClockMs: 60_000,
  ...over,
})

const gen = (generation: number, verdict: GenerationRecord['verdict'], before: number, after: number): GenerationRecord => ({
  generation,
  at: generation * 1000,
  hypothesis: `h${generation}`,
  rationale: '',
  targetFiles: [],
  changedFiles: verdict === 'promoted' ? ['src/x.ts'] : [],
  baseline: metrics(before),
  candidate: metrics(after),
  verdict,
  reason: '',
  model: 'test',
})

test('learningRate reports stalled after several tied generations with no promotion', () => {
  const records = [1, 2, 3, 4, 5].map((n) => gen(n, 'rejected', 0.8, 0.8))
  const s = learningRate(records)
  expect(s.trend).toBe('stalled')
  expect(s.deltaPassRatePerGen).toBe(0)
  expect(s.promotionsPerWindow).toBe(0)
})

test('learningRate reports accelerating when recent gain outpaces the prior window', () => {
  const records = [
    ...[1, 2, 3, 4, 5].map((n) => gen(n, 'rejected', 0.8, 0.8)), // prior window: flat
    gen(6, 'rejected', 0.8, 0.8),
    gen(7, 'promoted', 0.80, 0.85),
    gen(8, 'rejected', 0.85, 0.85),
    gen(9, 'promoted', 0.85, 0.92),
    gen(10, 'rejected', 0.92, 0.92),
  ]
  const s = learningRate(records)
  expect(s.trend).toBe('accelerating')
  expect(s.deltaPassRatePerGen).toBeGreaterThan(0)
})

test('learningRate reports decelerating when recent gain falls below the prior window', () => {
  const records = [
    gen(1, 'promoted', 0.50, 0.65),
    gen(2, 'promoted', 0.65, 0.78),
    gen(3, 'promoted', 0.78, 0.86),
    gen(4, 'rejected', 0.86, 0.86),
    gen(5, 'promoted', 0.86, 0.90), // prior window: strong gains
    gen(6, 'rejected', 0.90, 0.90),
    gen(7, 'rejected', 0.90, 0.90),
    gen(8, 'promoted', 0.90, 0.901),
    gen(9, 'rejected', 0.901, 0.901),
    gen(10, 'rejected', 0.901, 0.901), // recent window: near-flat
  ]
  const s = learningRate(records)
  expect(s.trend).toBe('decelerating')
})

test('renderLedgerForPrompt includes the learning-trajectory section when records exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ledger-'))
  const path = join(dir, 'ledger.jsonl')
  try {
    const records = [1, 2, 3, 4, 5].map((n) => gen(n, 'rejected', 0.9, 0.9))
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const rendered = renderLedgerForPrompt(path)
    expect(rendered).toContain('### Learning trajectory')
    expect(rendered).toContain('STALLED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('learningRate handles empty and single-record ledgers without dividing by zero', () => {
  expect(learningRate([]).trend).toBe('unknown')
  expect(learningRate([]).fitnessPerKTokens).toBe(0)
  const one = learningRate([gen(1, 'promoted', 0.5, 0.6)])
  expect(one.trend).toBe('unknown')
  expect(Number.isFinite(one.fitnessPerWallClockHour)).toBe(true)
})

test('a note added to a verdict is shown beside it, and errored generations are not a stall', async () => {
  const { learningRate, renderLedgerForPrompt } = await import('./ledger.ts')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'elia-ledger-note-'))
  try {
    const record = { generation: 9, at: 1, hypothesis: 'shorter read_file', rationale: '', targetFiles: [], changedFiles: [], verdict: 'rejected', reason: 'regressed on x', model: 'm', note: 'that gate rejected on noise' }
    writeFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify(record)}\n`)
    const rendered = renderLedgerForPrompt(join(dir, 'ledger.jsonl'))
    expect(rendered).toContain('regressed on x\n  NOTE: that gate rejected on noise')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const errored = (generation: number) => ({ generation, at: generation, hypothesis: '', rationale: '', targetFiles: [], changedFiles: [], verdict: 'error' as const, reason: 'Connection error.', model: 'm' })
  expect(learningRate([errored(1), errored(2), errored(3)]).trend).toBe('unknown')
})
