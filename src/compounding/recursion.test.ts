import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-recursion-test'

const { recursionSignal, touchesImprover } = await import('./recursion.ts')
const { strategyPaths } = await import('../evolve/strategy.ts')
import type { GenerationRecord } from '../evolve/ledger.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-recursion-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
const gen = (overrides: Partial<GenerationRecord> = {}): GenerationRecord => {
  n += 1
  return { generation: n, at: n, hypothesis: '', rationale: '', targetFiles: [], changedFiles: [], verdict: 'rejected', reason: '', model: 'm', ...overrides }
}

test('the files the improver runs on are recognised', () => {
  expect(touchesImprover(['src/autonomy/roles.ts'])).toBe(true)
  expect(touchesImprover(['src\\tools\\editFile.ts'])).toBe(true)
  expect(touchesImprover(['src/ui/app/App.tsx'])).toBe(false)
})

test('no promotions is no recursion', () => {
  const signal = recursionSignal([gen(), gen()], strategyPaths(dir))
  expect(signal.promotions).toBe(0)
  expect(signal.compounding).toBe(false)
  expect(signal.trial).toBe('no challenger')
})

test('a promotion to the improver followed by deeper search, plus a second win, is compounding', () => {
  const records = [
    ...Array.from({ length: 5 }, () => gen({ funnel: 'proposed' })),
    gen({ verdict: 'promoted', funnel: 'promoted', changedFiles: ['src/autonomy/roles.ts'] }),
    ...Array.from({ length: 4 }, () => gen({ funnel: 'measured' })),
    gen({ verdict: 'promoted', funnel: 'promoted', changedFiles: ['src/ui/x.ts'] }),
  ]
  const signal = recursionSignal(records, strategyPaths(dir))
  expect(signal.stacked).toBe(1)
  expect(signal.improverEffects).toHaveLength(1)
  expect(signal.improverEffects[0]!.after).toBeGreaterThan(signal.improverEffects[0]!.before)
  expect(signal.compounding).toBe(true)
})

test('two wins without any effect on the improver are progress, not compounding', () => {
  const records = [gen({ verdict: 'promoted', funnel: 'promoted', changedFiles: ['src/ui/a.ts'] }), gen({ verdict: 'promoted', funnel: 'promoted', changedFiles: ['src/ui/b.ts'] })]
  expect(recursionSignal(records, strategyPaths(dir)).compounding).toBe(false)
})

test('an adopted search strategy counts as the improver improving', () => {
  writeFileSync(join(dir, 'strategy-challenger.md.adopted-1'), 'x')
  const records = [gen({ verdict: 'promoted', funnel: 'promoted' }), gen({ verdict: 'promoted', funnel: 'promoted' })]
  const signal = recursionSignal(records, strategyPaths(dir))
  expect(signal.strategiesAdopted).toBe(1)
  expect(signal.compounding).toBe(true)
})
