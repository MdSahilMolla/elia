import { expect, test } from 'bun:test'
import { appendReceipt, closeReceipt, readReceipts } from './kernel.ts'
import { renderWorld, worldStatus } from './status.ts'
import { emptyPriors } from './runtime.ts'
import { emptyMeta } from '../reason/plan.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = 2_000_000_000_000
const skipped = (reason: string, tokens = 6_000_000) => ({
  at: NOW - 1000,
  twin: { surface: 'prefix', decision: 'skip' as const, reason, predicted: { mean: 0, sd: 0.03 }, winProbability: 0.1 },
  baseline: { passRate: 1, passed: [], failed: [], totalTokens: tokens, totalElapsedMs: 1 },
})

test('a fresh install says nothing has been screened and reports no coefficient it has not earned', () => {
  const text = renderWorld(worldStatus([], [], NOW, emptyPriors(), emptyMeta()))
  expect(text).toContain('no candidate has been screened yet')
  expect(text).toContain('no run has been modelled in this project yet')
  expect(text).toContain('reasoning plans: none scored yet')
  expect(text).toContain('this project, as the planner reads it: checks not yet timed')
  expect(text).toContain('calibration: not yet — needs 3 scored predictions, has 0')
  expect(text).not.toContain('coefficient')
})

test('what it stopped is counted by reason, with the tokens that were not spent', () => {
  const ledger = [
    skipped('could not be measured: this diff cannot move a benchmark score'),
    skipped('predicted saving 1.2% from 217 fewer tokens on every call'),
    skipped('predicted saving 0.4% from 60 fewer tokens on every call'),
    skipped('adds 2500 tokens to every call (14% of everything the suite spends)'),
    { at: NOW - 1000, twin: { surface: 'other', decision: 'proceed' as const, reason: 'worth measuring', predicted: { mean: 0, sd: 0.15 }, winProbability: 0.4 } },
  ]
  const status = worldStatus([], ledger, NOW, emptyPriors(), emptyMeta())
  expect(status.stopped).toEqual({ total: 4, unmeasurable: 1, small: 2, adds: 1, other: 0 })
  expect(status.candidates).toBe(5)
  expect(status.avoidedTokens).toBe(24_000_000)
  const text = renderWorld(status)
  expect(text).toContain('stopped before any benchmark task ran: 4 of 5 candidate(s) (1 that no task can see, 2 saving too small, 1 adding text) — about 24.0M tokens not spent')
})

test('a broken receipt chain is called out, not smoothed over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'world-status-'))
  const path = join(dir, 'receipts.jsonl')
  try {
    for (const generation of [1, 2, 3]) {
      const open = appendReceipt({ generation, at: generation, surface: 'prefix', raw: -0.1, predicted: { mean: -0.1, sd: 0.05 }, decision: 'proceed', reason: 't' }, path)!
      closeReceipt(open, -0.09, path)
    }
    const receipts = readReceipts(path)
    const healthy = worldStatus(receipts, [], NOW, emptyPriors(), emptyMeta())
    expect(healthy.chain).toBe('intact')
    expect(healthy.scored).toBe(3)
    expect(renderWorld(healthy)).toContain('3 prediction(s) committed, 3 scored against a measurement · chain intact')
    expect(renderWorld(healthy)).toContain('calibration: coefficient ×')
    const forged = receipts.map((receipt, index) => (index === 2 ? { ...receipt, predicted: { mean: -0.9, sd: 0.05 } } : receipt))
    expect(renderWorld(worldStatus(forged, [], NOW, emptyPriors(), emptyMeta()))).toContain('CHAIN BROKEN at receipt 2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
