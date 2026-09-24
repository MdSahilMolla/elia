import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-strategy-test'

const {
  DEFAULT_STRATEGY_ID,
  MIN_TRIAL_GENERATIONS,
  challengerStrategy,
  funnelScore,
  incumbentStrategy,
  pickStrategy,
  readStrategyTrial,
  settleStrategyTrial,
  shouldProposeChallenger,
  strategyPaths,
  writeChallenger,
} = await import('./strategy.ts')
const { hypothesisPrompt } = await import('./engine.ts')
import type { GenerationRecord } from './ledger.ts'

let dir: string
let paths: ReturnType<typeof strategyPaths>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-strategy-'))
  paths = strategyPaths(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
function gen(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  n += 1
  return { generation: n, at: n, hypothesis: 'h', rationale: 'r', targetFiles: [], changedFiles: [], verdict: 'rejected', reason: '', model: 'm', ...overrides }
}

const LONG = 'Prefer small changes to tool descriptions that the failing history tasks misused; read each kept directory first. '.repeat(3)

test('funnel depth runs from nothing to a promotion', () => {
  expect(funnelScore({ verdict: 'error' })).toBe(0)
  expect(funnelScore({ verdict: 'rejected', funnel: 'proposed' })).toBeCloseTo(1 / 9)
  expect(funnelScore({ verdict: 'rejected', funnel: 'guarded' })).toBeCloseTo(8 / 9)
  expect(funnelScore({ verdict: 'promoted', funnel: 'promoted' })).toBe(1)
})

test('with no strategy on disk the built-in one is in force and the prompt carries it', () => {
  expect(incumbentStrategy(paths).id).toBe(DEFAULT_STRATEGY_ID)
  expect(pickStrategy(() => 0, paths).id).toBe(DEFAULT_STRATEGY_ID)
  const prompt = hypothesisPrompt(incumbentStrategy(paths))
  expect(prompt).toContain(`search strategy ${DEFAULT_STRATEGY_ID}`)
  expect(prompt).toContain('Start from the evidence')
  expect(prompt).toContain('Be honest about mechanism')
})

test('a challenger splits generations by coin flip', () => {
  const challenger = writeChallenger(LONG, 7, paths)
  expect(challenger.id).toStartWith('gen7-')
  expect(pickStrategy(() => 0.2, paths).id).toBe(challenger.id)
  expect(pickStrategy(() => 0.8, paths).id).toBe(DEFAULT_STRATEGY_ID)
})

test('the search writes itself a challenger only after a run of generations that banked nothing', () => {
  expect(shouldProposeChallenger([gen(), gen()], paths)).toBe(false)
  expect(shouldProposeChallenger([gen(), gen(), gen()], paths)).toBe(true)
  expect(shouldProposeChallenger([gen(), gen({ verdict: 'promoted' }), gen()], paths)).toBe(false)
  writeChallenger(LONG, 1, paths)
  expect(shouldProposeChallenger([gen(), gen(), gen()], paths)).toBe(false)
})

test('a challenger whose generations go clearly further is adopted and becomes the incumbent', () => {
  const challenger = writeChallenger(LONG, 3, paths)
  const records = [
    ...Array.from({ length: MIN_TRIAL_GENERATIONS }, () => gen({ strategyId: DEFAULT_STRATEGY_ID, funnel: 'proposed' })),
    ...Array.from({ length: MIN_TRIAL_GENERATIONS }, () => gen({ strategyId: challenger.id, funnel: 'measured' })),
  ]
  expect(readStrategyTrial(records, paths).verdict).toBe('adopt')
  settleStrategyTrial(records, paths)
  expect(incumbentStrategy(paths).id).toBe(challenger.id)
  expect(challengerStrategy(paths)).toBeUndefined()
  expect(readdirSync(dir).some((file) => file.includes('.adopted-'))).toBe(true)
})

test('a challenger that is not ahead keeps running, then is retired', () => {
  const challenger = writeChallenger(LONG, 3, paths)
  const even = (count: number) => [
    ...Array.from({ length: count }, () => gen({ strategyId: DEFAULT_STRATEGY_ID, funnel: 'measured' })),
    ...Array.from({ length: count }, () => gen({ strategyId: challenger.id, funnel: 'measured' })),
  ]
  expect(readStrategyTrial(even(MIN_TRIAL_GENERATIONS - 1), paths).verdict).toBe('running')
  expect(readStrategyTrial(even(MIN_TRIAL_GENERATIONS), paths).verdict).toBe('running')
  const long = even(MIN_TRIAL_GENERATIONS * 2)
  expect(settleStrategyTrial(long, paths).verdict).toBe('reject')
  expect(incumbentStrategy(paths).id).toBe(DEFAULT_STRATEGY_ID)
  expect(existsSync(paths.challenger)).toBe(false)
})

test('a promotion outweighs depth, and records from before the coin are not in the trial', () => {
  const challenger = writeChallenger(LONG, 3, paths)
  const records = [
    // Pre-trial history: deep but unlabelled — must not count for the incumbent.
    ...Array.from({ length: 10 }, () => gen({ funnel: 'guarded' })),
    ...Array.from({ length: MIN_TRIAL_GENERATIONS }, () => gen({ strategyId: DEFAULT_STRATEGY_ID, funnel: 'guarded' })),
    ...Array.from({ length: MIN_TRIAL_GENERATIONS - 1 }, () => gen({ strategyId: challenger.id, funnel: 'built' })),
    gen({ strategyId: challenger.id, funnel: 'promoted', verdict: 'promoted' }),
  ]
  const trial = readStrategyTrial(records, paths)
  expect(trial.incumbent.generations).toBe(MIN_TRIAL_GENERATIONS)
  expect(trial.verdict).toBe('adopt')
})

test('a generation that errored is not a strategy failing', () => {
  // Two outages and one rejection wrote the first run here a new strategy,
  // and the strategy it wrote was built on the outages.
  expect(shouldProposeChallenger([gen(), gen({ verdict: 'error' }), gen({ verdict: 'error' })], paths)).toBe(false)
  expect(shouldProposeChallenger([gen(), gen({ verdict: 'error' }), gen(), gen()], paths)).toBe(true)
})
