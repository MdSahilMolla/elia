import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FrontierReport } from './frontier.ts'
import type { LibraryHealth } from './library.ts'
import type { GrowthReport } from './growth.ts'
import { recommend, renderPlan, type GovernorState } from './governor.ts'
import { readActivityLog, runRound, type VdeState } from './round.ts'
import { sealedMinimumGain } from './acceptance.ts'
import { wilson } from './stats.ts'

function frontier(overrides: Partial<FrontierReport> = {}): FrontierReport {
  return {
    target: 0.5,
    families: [
      { family: 'code', regime: 'mechanical', turns: 40, unverified: 2, p: wilson(30, 40), status: 'inside' },
      { family: 'docs', regime: 'judgment', turns: 10, unverified: 5, p: wilson(1, 30), status: 'inside' },
    ],
    verifiers: {},
    mass: 1,
    unverifiedShare: wilson(7, 50),
    ...overrides,
  }
}

const healthy: LibraryHealth = { total: 10, byStatus: { admitted: 5, probation: 5, quarantined: 0, purged: 0 }, slip: wilson(0, 0), meanLeap: 1, auditFirst: false, notes: [] }
const flatGrowth: GrowthReport = { lessons: { n: 261, gamma: 0.25, se: 0.64, meanSuccess: 0.67, varied: 0.99, detail: '' }, detail: '' }
const queue = { queued: [{ candidate: { kind: 'command' as const, pattern: 'git diff', count: 53, examples: [] }, value: 53 }], refused: [] }

function state(overrides: Partial<GovernorState> = {}): GovernorState {
  return { frontier: frontier(), library: healthy, growth: flatGrowth, queue, bench: { tasks: 54, passRate: 0.93, minimumDetectable: sealedMinimumGain(54, 1) }, ...overrides }
}

test("the sealed gate's floor on today's bench is above its headroom", () => {
  // 54 tasks at 93%: fewer than 4 can still flip, and the gate needs more.
  expect(sealedMinimumGain(54, 1)).toBeGreaterThan(1 - 0.93)
  expect(sealedMinimumGain(500, 1)).toBeLessThan(0.05)
})

test('R4: a benchmark too small to certify a gain blocks the meta-loop and asks for more tasks', () => {
  // Under the legacy gate evolve can still promote — R4 says what that is worth, not that it cannot.
  const legacy = recommend(state()).find((rec) => rec.activity === 'meta')!
  expect(legacy.viable).toBe(true)
  expect(legacy.why).toContain('no stated error rate')
  const plan = recommend(state({ bench: { tasks: 54, passRate: 0.93, minimumDetectable: sealedMinimumGain(54, 1), gate: 'sealed' } }))
  expect(plan.find((rec) => rec.activity === 'meta')!.viable).toBe(false)
  const harvest = plan.find((rec) => rec.activity === 'harvest')!
  expect(harvest.rule).toBe('R4')
  expect(plan.findIndex((rec) => rec.activity === 'harvest')).toBeLessThan(plan.findIndex((rec) => rec.activity === 'meta'))
  // A big enough benchmark lets it through.
  expect(recommend(state({ bench: { tasks: 500, passRate: 0.7, minimumDetectable: sealedMinimumGain(500, 1) } })).find((rec) => rec.activity === 'meta')!.viable).toBe(true)
})

test('R1: a family outside the frontier makes verifier synthesis the first thing to do', () => {
  const outside = frontier({ families: [{ family: 'docs', regime: 'judgment', turns: 30, unverified: 0, p: wilson(1, 60), status: 'outside' }] })
  const plan = recommend(state({ frontier: outside, bench: { tasks: 500, passRate: 0.5, minimumDetectable: 0.02 } }))
  expect(plan[0]!.activity).toBe('verify')
  expect(plan[0]!.rule).toBe('R1')
})

test('R2 and R3: audit before growth when the library is at risk; compress when lessons do not help', () => {
  const risky = { ...healthy, auditFirst: true, notes: ['σ = 1.00: retrieval does not favour certified artifacts'] }
  const plan = recommend(state({ library: risky }))
  expect(plan[0]!.activity).toBe('audit') // free, and R2 says first
  const compress = plan.find((rec) => rec.activity === 'compress')!
  expect(compress.rule).toBe('R3')
  expect(compress.why).toContain('git diff')
  expect(renderPlan(plan)).toContain('RESOURCE GOVERNOR')
})

test('an empty library gets an audit, which is what certifies the existing store', () => {
  const empty = { ...healthy, total: 0, byStatus: { admitted: 0, probation: 0, quarantined: 0, purged: 0 } }
  const audit = recommend(state({ library: empty })).find((rec) => rec.activity === 'audit')!
  expect(audit.viable).toBe(true)
  expect(audit.why).toContain('certifies what is already stored')
})

test('measured history reorders the plan once an activity has enough runs', () => {
  const history = Array.from({ length: 4 }, () => ({ activity: 'solve' as const, deltaPhi: 0.5, cost: 1 }))
  const plan = recommend(state({ bench: { tasks: 500, passRate: 0.6, minimumDetectable: 0.02 } }), history)
  expect(plan.find((rec) => rec.activity === 'solve')!.why).toContain('measured ΔΦ/cost')
  expect(plan[0]!.activity).toBe('solve')
})

test('a round runs the best free activity, never a paid one without --spend, and logs ΔΦ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-vde-round-'))
  try {
    const s = state({ library: { ...healthy, auditFirst: true, notes: ['near L*'] } }) as VdeState
    const calls: string[] = []
    const result = await runRound({
      state: s,
      regather: () => s,
      runners: {
        audit: async () => {
          calls.push('audit')
          return { ran: true, detail: 'retired 1 lesson', cost: 0 }
        },
        compress: async () => {
          calls.push('compress')
          return { ran: true, detail: 'built', cost: 1 }
        },
      },
      paid: new Set(['compress', 'meta', 'harvest', 'verify', 'solve']),
      spend: false,
      logFile: join(dir, 'activities.jsonl'),
    })
    expect(calls).toEqual(['audit'])
    expect(result.ran!.activity).toBe('audit')
    expect(readActivityLog(join(dir, 'activities.jsonl'))).toHaveLength(1)

    // With the audit off the table, a paid activity is skipped, not run.
    const unpaid = await runRound({ state: state() as VdeState, regather: () => s, runners: { compress: async () => ({ ran: true, detail: '', cost: 1 }) }, paid: new Set(['compress']), spend: false, logFile: join(dir, 'b.jsonl') })
    expect(unpaid.ran).toBeUndefined()
    expect(unpaid.skipped.find((entry) => entry.activity === 'compress')!.reason).toContain('--spend')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
