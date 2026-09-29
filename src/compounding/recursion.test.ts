import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-recursion-test'

const { recursionSignal, renderRecursion, touchesImprover } = await import('./recursion.ts')
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

const improver = (overrides: Partial<GenerationRecord> = {}) => gen({ verdict: 'promoted', funnel: 'promoted', changedFiles: ['src/autonomy/roles.ts'], ...overrides })
const win = (overrides: Partial<GenerationRecord> = {}) => gen({ verdict: 'promoted', funnel: 'promoted', changedFiles: ['src/ui/x.ts'], ...overrides })
const landed = () => true

test('an improver promotion with nothing before it to compare against is not evidence of anything', () => {
  // Before the fix the empty window averaged to 0, so any search at all afterwards "improved".
  const records = [improver(), ...Array.from({ length: 5 }, () => gen({ funnel: 'proposed' })), win()]
  const signal = recursionSignal(records, strategyPaths(dir), landed)
  expect(signal.improverEffects[0]!.beforeGenerations).toBe(0)
  expect(signal.compounding).toBe(false)
})

test('generations the provider cut short are not shallow search', () => {
  const outage = () => gen({ verdict: 'error', reason: 'the attempt could not finish: Connection error.' })
  const records = [...Array.from({ length: 5 }, outage), improver(), ...Array.from({ length: 5 }, () => gen({ funnel: 'measured', reason: 'no measurable improvement' })), win()]
  const signal = recursionSignal(records, strategyPaths(dir), landed)
  // Five outages before the promotion are not five samples of a search that stopped at "proposed".
  expect(signal.improverEffects[0]!.beforeGenerations).toBe(0)
  expect(signal.compounding).toBe(false)
})

test('a gain that is not clearly ahead is not a gain', () => {
  const records = [
    ...Array.from({ length: 5 }, () => gen({ funnel: 'measured' })),
    improver(),
    ...Array.from({ length: 4 }, () => gen({ funnel: 'measured' })),
    win(),
  ]
  const effect = recursionSignal(records, strategyPaths(dir), landed).improverEffects[0]!
  // measured (5/9) before; the second promotion lifts the after mean by only 0.09.
  expect(effect.after - effect.before).toBeLessThan(0.1)
  expect(recursionSignal(records, strategyPaths(dir), landed).compounding).toBe(false)
})

test('promotions sitting on a branch nobody merged are not in the tree later generations start from', () => {
  const onBranch = (n: number) => ({ branch: `evolve/gen-${n}-x`, commit: `c${n}` })
  const records = [
    ...Array.from({ length: 5 }, () => gen({ funnel: 'proposed' })),
    improver(onBranch(6)),
    ...Array.from({ length: 4 }, () => gen({ funnel: 'measured' })),
    win(onBranch(11)),
  ]
  const unmerged = recursionSignal(records, strategyPaths(dir), (record) => record.branch === undefined)
  expect(unmerged.promotions).toBe(2)
  expect(unmerged.awaitingMerge).toBe(2)
  expect(unmerged.stacked).toBe(0)
  expect(unmerged.improverEffects).toHaveLength(0)
  expect(unmerged.compounding).toBe(false)
  expect(renderRecursion(unmerged)).toContain('2 proven on a branch nobody has merged, not counted')

  // Once the branches are merged, the very same ledger is compounding.
  const merged = recursionSignal(records, strategyPaths(dir), landed)
  expect(merged.awaitingMerge).toBe(0)
  expect(merged.compounding).toBe(true)
})

test('generations that ran on the improver from before the promotion are not credited to it', () => {
  const earlier = Array.from({ length: 5 }, () => gen({ funnel: 'proposed' }))
  const promotion = improver()
  const records = [
    ...earlier,
    promotion,
    // Same process as the promotion: proposer and builder had already loaded the old improver.
    ...Array.from({ length: 5 }, () => gen({ funnel: 'measured', staleImprover: promotion.generation })),
    win(),
  ]
  // Without the exclusion this is 5 proposed -> 5 measured + a win, and reads as compounding.
  const effect = recursionSignal(records, strategyPaths(dir), landed).improverEffects[0]!
  expect(effect.afterGenerations).toBe(1)
  expect(recursionSignal(records, strategyPaths(dir), landed).compounding).toBe(false)
})
