import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-plan-test'

const plan = await import('./plan.ts')
const { chooseHarness } = await import('./library.ts')
import type { HarnessRecord, Library } from './library.ts'
import { emptyPriors, type Priors } from '../world/runtime.ts'

const HARNESSES = [
  { id: 'single', maxAttempts: 1 },
  { id: 'wide', maxAttempts: 4 },
  { id: 'deep', maxAttempts: 6 },
]

/** A record: what a harness did in one signature. Cost is per attempt, so cost = attempts × perAttempt. */
function rec(signature: string, harnessId: string, runs: number, verifiedRuns: number, opts: { attempts?: number; perAttempt?: number; successAt?: number[] } = {}): HarnessRecord {
  const totalAttempts = opts.attempts ?? runs
  return { signature, harnessId, runs, verifiedRuns, totalAttempts, totalCost: totalAttempts * (opts.perAttempt ?? 10), totalElapsedMs: runs * 10, lastAt: 1, ...(opts.successAt ? { successAt: opts.successAt } : {}) }
}
const lib = (records: HarnessRecord[], flags?: Library['flags']): Library => ({ version: 1, records, ...(flags ? { flags } : {}) })
const SIG = 'repair/checked/single'
const SIBLING = 'repair/checked/multi'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reason-plan-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// --- the world context ---

const priors = (patch: Partial<Priors> & { keys?: Priors['keys'] } = {}): Priors => ({ ...emptyPriors(), ...patch })

test('the world model\'s measurements become flags, and a project it knows nothing about is cold', () => {
  const cold = plan.worldContext(undefined)
  expect(cold.flags).toEqual({ slow: false, flaky: false, cold: true, unsteady: false })
  expect(plan.worldContext(priors()).flags.cold).toBe(true)

  const known = plan.worldContext(priors({
    keys: { 'run_command:test': { ok: 6, fail: 4, ms: 10 * 90_000, repeats: 8, flips: 3 } },
    calibration: { n: 200, brier: 30, failures: 60, bits: 300 },
    notes: { repeat: 4, streak: 4 },
  }))
  expect(known.checkMs).toBe(90_000)
  expect(known.flipRate).toBeCloseTo(3 / 8, 9)
  expect(known.flags).toEqual({ slow: true, flaky: true, cold: false, unsteady: true })

  // Too little to call anything slow or flaky, whatever it looked like.
  const thin = plan.worldContext(priors({ keys: { 'run_command:test': { ok: 1, fail: 1, ms: 400_000, repeats: 2, flips: 2 } }, calibration: { n: 200, brier: 30, failures: 60, bits: 300 } }))
  expect(thin.checkMs).toBeUndefined()
  expect(thin.flipRate).toBeUndefined()
  expect(thin.flags.slow || thin.flags.flaky).toBe(false)
})

// --- pooling ---

test('a cell with no runs of its own inherits what its siblings learned, where the independent estimate knows nothing', () => {
  const library = lib([rec(SIBLING, 'wide', 30, 27, { attempts: 40 })])
  const wide = plan.estimate({ signature: SIG, harness: HARNESSES[1]!, library })
  expect(wide.direct).toBe(0)
  expect(wide.related).toBe(30)
  expect(wide.independent).toBe(0.5)
  // pGlobal = 0.5 (nothing elsewhere); pClass = (27 + 4*0.5)/(30 + 4); an empty cell is its class.
  expect(wide.pVerify).toBeCloseTo((27 + 2) / 34, 9)
  // Nothing observed in the cell itself, so the interval is still honest about that.
  expect(wide.hi - wide.lo).toBeGreaterThan(0.2)
})

test('a cell\'s own evidence outweighs the class as it accumulates', () => {
  const siblings = rec(SIBLING, 'wide', 30, 27)
  const few = plan.estimate({ signature: SIG, harness: HARNESSES[1]!, library: lib([siblings, rec(SIG, 'wide', 2, 0)]) })
  const many = plan.estimate({ signature: SIG, harness: HARNESSES[1]!, library: lib([siblings, rec(SIG, 'wide', 40, 4)]) })
  // Two unlucky runs pull an inherited 85% down, but not far.
  expect(few.pVerify).toBeGreaterThan(0.5)
  expect(few.pVerify).toBeLessThan(0.85)
  expect(many.pVerify).toBeLessThan(0.3)
  expect(many.direct).toBe(40)
})

test('evidence about one class does not leak into another except through the global rate', () => {
  const library = lib([rec('implement/checked/single', 'wide', 40, 38)])
  const wide = plan.estimate({ signature: SIG, harness: HARNESSES[1]!, library })
  expect(wide.related).toBe(0)
  // (38+1)/(40+2) is the global rate; the repair cell is shrunk toward it by only the pseudo-observations it has.
  expect(wide.pVerify).toBeGreaterThan(0.5)
  expect(wide.pVerify).toBeLessThan(0.95)
})

// --- the objective ---

test('verification decides first, and cost only among harnesses the record cannot tell apart', () => {
  // wide and deep are within a few points of each other; single is far behind.
  const library = lib([
    rec(SIG, 'single', 60, 30, { attempts: 60 }),
    rec(SIG, 'wide', 60, 45, { attempts: 150 }),
    rec(SIG, 'deep', 60, 46, { attempts: 300 }),
  ])
  const at = (tolerance: number) => plan.planHarness({ signature: SIG, candidates: HARNESSES, library, tolerance })
  // Default tolerance: wide is within five points of deep's lower bound and spends half as much.
  const cheap = at(0.05)
  expect(cheap.harnessId).toBe('wide')
  expect(cheap.reason).toContain('the cheapest of 2 within 5 points of the best')
  // Verification only: the best lower bound, whatever it costs.
  expect(at(0).harnessId).toBe('deep')
  // Thrifty enough and the narrow search is worth its saving too.
  expect(at(0.3).harnessId).toBe('single')
})

test('a search that is cheaper because it verifies less has not saved anything', () => {
  // single spends a fifth of what wide does and verifies half as often. The first version of this planner
  // minimised tokens per verified fix and chose it; verification is the objective, so it must not.
  const library = lib([rec(SIG, 'single', 40, 20, { attempts: 40 }), rec(SIG, 'wide', 40, 36, { attempts: 100 }), rec(SIG, 'deep', 40, 37, { attempts: 200 })])
  const chosen = plan.planHarness({ signature: SIG, candidates: HARNESSES, library })
  expect(chosen.harnessId).not.toBe('single')
})

test('the tolerance is read from the environment, bounded, and defaults to five points', () => {
  expect(plan.metaTolerance({})).toBe(0.05)
  expect(plan.metaTolerance({ ELIA_META_TOLERANCE: '0' })).toBe(0)
  expect(plan.metaTolerance({ ELIA_META_TOLERANCE: '0.1' })).toBe(0.1)
  expect(plan.metaTolerance({ ELIA_META_TOLERANCE: '5' })).toBe(0.5)
  expect(plan.metaTolerance({ ELIA_META_TOLERANCE: 'lots' })).toBe(0.05)
  expect(plan.metaTolerance({ ELIA_META_TOLERANCE: '' })).toBe(0.05)
})

test('and when the wider search verifies far more often, it wins on verification', () => {
  const library = lib([
    rec(SIG, 'single', 30, 4, { attempts: 30 }),
    rec(SIG, 'wide', 30, 27, { attempts: 75 }),
    rec(SIG, 'deep', 30, 28, { attempts: 180 }),
  ])
  expect(plan.planHarness({ signature: SIG, candidates: HARNESSES, library }).harnessId).toBe('wide')
})

test('a small sample is not a verdict: 3-for-3 does not beat 19-for-20', () => {
  const library = lib([rec(SIG, 'single', 20, 19, { attempts: 20 }), rec(SIG, 'wide', 3, 3, { attempts: 3 }), rec(SIG, 'deep', 20, 19, { attempts: 60 })])
  const single = plan.estimate({ signature: SIG, harness: HARNESSES[0]!, library })
  const wide = plan.estimate({ signature: SIG, harness: HARNESSES[1]!, library })
  expect(single.lo).toBeGreaterThan(wide.lo)
})

// --- the default is kept until something earns the right to change it ---

test('with nothing seasoned it starts from the smallest search no other contains, not the narrowest', () => {
  const declared = [{ id: 'single', maxAttempts: 1, subsetOf: 'wide' }, { id: 'wide', maxAttempts: 4 }, { id: 'deep', maxAttempts: 6 }]
  const planned = plan.planHarness({ signature: SIG, candidates: declared, library: lib([]) })
  // The library would begin by measuring five runs of a search that fails most of the time.
  expect(chooseHarness(SIG, declared.map((h) => h.id), lib([])).harnessId).toBe('single')
  expect(planned.harnessId).toBe('wide')
  expect(planned.reason).toContain('starting with wide')
  expect(planned.reason).toContain('cannot verify less often')
  expect(planned.differed).toBe(true)
  expect(planned.prediction?.harnessId).toBe('wide')
})

test('with no structure declared, or the cold start switched off, the library\'s own measuring pass stands', () => {
  const library = lib([rec(SIG, 'single', 2, 1)])
  const baseline = chooseHarness(SIG, HARNESSES.map((h) => h.id), library)
  const undeclared = plan.planHarness({ signature: SIG, candidates: HARNESSES, library })
  // Nothing declared a subset, so every harness is undominated and the first is as good a place as any.
  expect(undeclared.harnessId).toBeDefined()
  const declared = [{ id: 'single', maxAttempts: 1, subsetOf: 'wide' }, { id: 'wide', maxAttempts: 4 }, { id: 'deep', maxAttempts: 6 }]
  const off = plan.planHarness({ signature: SIG, candidates: declared, library, coldStart: 'library' })
  expect(off.harnessId).toBe(baseline.harnessId)
  expect(off.reason).toBe(baseline.reason)
  expect(off.exploring).toBe(true)
  expect(off.maxAttempts).toBeUndefined()
  expect(off.prediction?.harnessId).toBe(baseline.harnessId)
})

test('a harness that is a subset of another cannot be believed better than it', () => {
  const declared = [{ id: 'single', maxAttempts: 1, subsetOf: 'wide' }, { id: 'wide', maxAttempts: 4 }]
  // wide has been measured poor; single has no runs, so alone its interval reaches high.
  const library = lib([rec(SIG, 'wide', 12, 4, { attempts: 30 })])
  const alone = plan.estimate({ signature: SIG, harness: declared[0]!, library })
  const planned = plan.planHarness({ signature: SIG, candidates: declared, library })
  const single = planned.estimates.find((e) => e.harnessId === 'single')!
  const wide = planned.estimates.find((e) => e.harnessId === 'wide')!
  expect(alone.hi).toBeGreaterThan(wide.hi)
  expect(single.hi).toBeLessThanOrEqual(wide.hi)
  expect(single.pVerify).toBeLessThanOrEqual(wide.pVerify)
  // And evidence that the narrow one is good lifts the wide one's floor.
  const good = plan.planHarness({ signature: SIG, candidates: declared, library: lib([rec(SIG, 'single', 30, 27, { attempts: 30 }), rec(SIG, 'wide', 2, 0, { attempts: 6 })]) })
  const wideAfter = good.estimates.find((e) => e.harnessId === 'wide')!
  const singleAfter = good.estimates.find((e) => e.harnessId === 'single')!
  expect(wideAfter.lo).toBeGreaterThanOrEqual(singleAfter.lo)
  expect(wideAfter.pVerify).toBeGreaterThanOrEqual(singleAfter.pVerify)
})

test('the planner off is the library, exactly', () => {
  const library = lib([rec(SIG, 'single', 30, 18), rec(SIG, 'wide', 30, 24, { attempts: 120 })])
  const off = plan.planHarness({ signature: SIG, candidates: HARNESSES, library, enabled: false })
  expect(off.harnessId).toBe(chooseHarness(SIG, HARNESSES.map((h) => h.id), library).harnessId)
  expect(off.prediction).toBeUndefined()
  expect(plan.plannerEnabled({ ELIA_META_WORLD: 'off' })).toBe(false)
  expect(plan.plannerEnabled({})).toBe(true)
})

test('evidence from sibling signatures lets a brand-new cell be planned where the library would still be measuring', () => {
  const library = lib([rec(SIBLING, 'single', 10, 2, { attempts: 10 }), rec(SIBLING, 'wide', 10, 9, { attempts: 25 }), rec(SIBLING, 'deep', 10, 9, { attempts: 60 })])
  const baseline = chooseHarness(SIG, HARNESSES.map((h) => h.id), library)
  expect(baseline.reason).toContain('still measuring')
  const planned = plan.planHarness({ signature: SIG, candidates: HARNESSES, library })
  expect(planned.reason).not.toContain('still measuring')
  expect(planned.harnessId).toBe('wide')
  expect(planned.reason).toContain('from 10 related run(s)')
})

test('a challenger whose best case could beat the leader worst case gets one turn in four, and only then', () => {
  const pair = [{ id: 'single', maxAttempts: 1 }, { id: 'wide', maxAttempts: 4 }]
  // wide leads on 30 runs; single has too few for its interval to have ruled it out.
  const at = (singleRuns: number) => lib([rec(SIG, 'wide', 30, 20, { attempts: 60 }), rec(SIG, 'single', singleRuns, Math.round(singleRuns * 0.3), { attempts: singleRuns })])
  const picks = [5, 6, 7, 8, 9, 10, 11, 12].map((runs) => plan.planHarness({ signature: SIG, candidates: pair, library: at(runs) }))
  const exploring = picks.filter((entry) => entry.exploring)
  expect(picks.every((entry) => entry.harnessId === 'wide' || entry.exploring)).toBe(true)
  // A quarter of the turns, not none and not most.
  expect(exploring.length).toBeGreaterThanOrEqual(1)
  expect(exploring.length).toBeLessThanOrEqual(3)
  for (const entry of exploring) {
    expect(entry.harnessId).toBe('single')
    expect(entry.reason).toContain('best case')
  }

  // Once the record rules the challenger out, it stops costing turns.
  const ruledOut = [100, 101, 102, 103].map((runs) => plan.planHarness({ signature: SIG, candidates: pair, library: lib([rec(SIG, 'wide', 30, 20, { attempts: 60 }), rec(SIG, 'single', runs, Math.round(runs * 0.1), { attempts: runs })]) }))
  expect(ruledOut.every((entry) => !entry.exploring && entry.harnessId === 'wide')).toBe(true)
})

// --- the budget ---

test('the attempt cap shortens a budget only when the record says nothing after it paid', () => {
  // 400 runs of a 4-attempt harness: 270 verified on attempt 1, 30 on attempt 2, none later; 100 never verified.
  const large = lib([rec(SIG, 'wide', 400, 300, { attempts: 800, successAt: [270, 30] })])
  expect(plan.attemptCap({ signature: SIG, harness: HARNESSES[1]!, library: large })).toBe(2)
  // Too few runs still going to call the tail dead: 0 of 22 is only 15% at the upper bound, and the bar is 6%.
  const thin = lib([rec(SIG, 'wide', 30, 22, { attempts: 60, successAt: [20, 2] })])
  expect(plan.attemptCap({ signature: SIG, harness: HARNESSES[1]!, library: thin })).toBeUndefined()
  // A few late successes among the runs still going is a live tail at this bar.
  const marginal = lib([rec(SIG, 'wide', 400, 303, { attempts: 800, successAt: [270, 27, 4, 2] })])
  expect(plan.attemptCap({ signature: SIG, harness: HARNESSES[1]!, library: marginal })).toBeUndefined()
  // A tail that is alive — a fifth of the runs still going verify later — keeps its budget.
  const alive = lib([rec(SIG, 'wide', 120, 64, { attempts: 300, successAt: [40, 10, 8, 6] })])
  expect(plan.attemptCap({ signature: SIG, harness: HARNESSES[1]!, library: alive })).toBeUndefined()
})

test('it never lengthens a budget, and never trusts a record that cannot say where its successes fell', () => {
  const large = lib([rec(SIG, 'wide', 400, 300, { attempts: 800, successAt: [270, 30] })])
  const cap = plan.attemptCap({ signature: SIG, harness: HARNESSES[1]!, library: large })!
  expect(cap).toBeLessThan(HARNESSES[1]!.maxAttempts)
  // Older records: verified runs with no histogram at all.
  const old = lib([rec(SIG, 'wide', 400, 300, { attempts: 800 })])
  expect(plan.attemptCap({ signature: SIG, harness: HARNESSES[1]!, library: old })).toBeUndefined()
  // A single-attempt harness has nothing to cut.
  expect(plan.attemptCap({ signature: SIG, harness: HARNESSES[0]!, library: lib([rec(SIG, 'single', 100, 50, { successAt: [50] })]) })).toBeUndefined()
})

test('the plan carries the cap it found', () => {
  const library = lib([
    rec(SIG, 'single', 100, 30, { attempts: 100, successAt: [30] }),
    rec(SIG, 'wide', 400, 330, { attempts: 800, successAt: [290, 40] }),
    rec(SIG, 'deep', 100, 70, { attempts: 500, successAt: [45, 25] }),
  ])
  const planned = plan.planHarness({ signature: SIG, candidates: HARNESSES, library, tolerance: 0 })
  expect(planned.harnessId).toBe('wide')
  expect(planned.maxAttempts).toBe(2)
  expect(planned.reason).toContain('capped at 2 attempt(s)')
})

// --- the world's flags ---

const flagged = (on: { runs: number; verified: number }, off: { runs: number; verified: number }): Library['flags'] => ({ single: { flaky: { on, off } } })

test('a flag moves a prediction only once the library has seen it change outcomes, decisively', () => {
  const ctx = (flaky: boolean) => ({ ...plan.worldContext(undefined), flags: { slow: false, flaky, cold: false, unsteady: false } })
  const records = [rec(SIG, 'single', 40, 24, { attempts: 40 })]
  // Not enough runs on one side: nothing moves.
  expect(plan.flagShifts('single', lib(records, flagged({ runs: 3, verified: 0 }, { runs: 40, verified: 30 })), ctx(true))).toEqual([])
  // Both sides seen, but the difference is within noise.
  expect(plan.flagShifts('single', lib(records, flagged({ runs: 10, verified: 6 }, { runs: 10, verified: 5 })), ctx(true))).toEqual([])
  // Decisive: with the flag on, single verifies far less.
  const decisive = flagged({ runs: 20, verified: 4 }, { runs: 60, verified: 48 })
  const on = plan.flagShifts('single', lib(records, decisive), ctx(true))
  const off = plan.flagShifts('single', lib(records, decisive), ctx(false))
  expect(on).toHaveLength(1)
  expect(on[0]!.logit).toBeLessThan(0)
  // Relative to how often the flag is true: with it off, the estimate moves the other way.
  expect(off[0]!.logit).toBeGreaterThan(0)
  const worse = plan.estimate({ signature: SIG, harness: HARNESSES[0]!, library: lib(records, decisive), context: ctx(true) })
  const better = plan.estimate({ signature: SIG, harness: HARNESSES[0]!, library: lib(records, decisive), context: ctx(false) })
  expect(worse.pVerify).toBeLessThan(better.pVerify)
  expect(worse.shifts[0]!.flag).toBe('flaky')
})

// --- recording what the search learned, and scoring the plan ---

test('the library keeps where a run succeeded and what the world looked like', async () => {
  const { recordOutcome, readLibrary, libraryPath } = await import('./library.ts')
  const path = libraryPath(dir)
  const base = { signature: SIG, harnessId: 'wide', cost: 5, elapsedMs: 10, at: 1 }
  recordOutcome({ ...base, verified: true, attemptsUsed: 2, successAt: 2, context: { flaky: true, slow: false } }, path)
  recordOutcome({ ...base, verified: true, attemptsUsed: 1, successAt: 1, context: { flaky: false, slow: false } }, path)
  recordOutcome({ ...base, verified: false, attemptsUsed: 4, context: { flaky: true, slow: false } }, path)
  const library = readLibrary(path)
  expect(library.records[0]!.successAt).toEqual([1, 1])
  expect(library.flags!.wide!.flaky).toEqual({ on: { runs: 2, verified: 1 }, off: { runs: 1, verified: 1 } })
  expect(library.flags!.wide!.slow).toEqual({ on: { runs: 0, verified: 0 }, off: { runs: 3, verified: 2 } })
  // An old-shape outcome still records.
  recordOutcome({ ...base, verified: true, attemptsUsed: 1 }, path)
  expect(readLibrary(path).records[0]!.runs).toBe(4)
})

test('the plan commits to a rate before the search and is scored against the independent estimate on the same runs', () => {
  const path = plan.metaPath(dir)
  expect(plan.renderMeta(plan.readMeta(path))).toContain('none scored yet')
  // The planner said 0.8 where the independent estimate said 0.5; the runs verified 8 times in 10.
  for (let i = 0; i < 10; i++) plan.recordMeta({ harnessId: 'wide', pVerify: 0.8, independent: 0.5 }, i < 8, i < 2, path)
  const meta = plan.readMeta(path)
  expect(meta.n).toBe(10)
  expect(meta.differed).toBe(2)
  // Brier: planner (0.04*8 + 0.64*2)/10 = 0.16; independent (0.25*10)/10 = 0.25.
  expect(meta.planner / meta.n).toBeCloseTo(0.16, 9)
  expect(meta.independent / meta.n).toBeCloseTo(0.25, 9)
  expect(plan.metaSkill(meta)).toBeCloseTo(1 - 0.16 / 0.25, 9)
  expect(plan.renderMeta(meta)).toContain('36% better')
})

test('accuracy is not claimed until there is enough to say, and a worse planner says so', () => {
  const path = plan.metaPath(dir)
  for (let i = 0; i < 4; i++) plan.recordMeta({ harnessId: 'wide', pVerify: 0.9, independent: 0.5 }, false, false, path)
  expect(plan.metaSkill(plan.readMeta(path))).toBeUndefined()
  expect(plan.renderMeta(plan.readMeta(path))).toContain('needs 10 scored plans, has 4')
  for (let i = 0; i < 8; i++) plan.recordMeta({ harnessId: 'wide', pVerify: 0.9, independent: 0.5 }, false, false, path)
  expect(plan.renderMeta(plan.readMeta(path))).toContain('WORSE')
})

test('a missing or corrupt meta file is an empty one', () => {
  expect(plan.readMeta(join(dir, 'nope.json')).n).toBe(0)
})
