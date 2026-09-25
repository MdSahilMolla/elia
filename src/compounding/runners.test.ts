import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordGapVector } from '../gap/report.ts'
import type { GapVector } from '../gap/types.ts'
import type { LibraryHealth } from '../autonomy/certifiedLibrary.ts'
import type { EngineState } from './round.ts'
import { ago, AUDIT_EVERY_MS, createRunners, LADDER_STALE_MS, lastRunAt, PAID_ACTIVITIES } from './runners.ts'
import { wilson } from './stats.ts'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'elia-runners-'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

const NOW = Date.parse('2026-09-23T12:00:00Z')
const HOUR = 3_600_000

const healthy: LibraryHealth = { total: 10, byStatus: { admitted: 5, probation: 5, quarantined: 0, purged: 0 }, slip: wilson(0, 0), meanLeap: 1, auditFirst: false, notes: [] }

function state(library: LibraryHealth = healthy): EngineState {
  return {
    frontier: { target: 0.5, families: [], verifiers: {}, unverifiedShare: wilson(0, 0), checkableUnverified: wilson(0, 0) },
    library,
    growth: { lessons: { n: 0, varied: 0, detail: '' }, detail: '' },
    queue: { queued: [], refused: [] },
  }
}

function vector(at: number, critic = false): GapVector {
  return {
    at: new Date(at).toISOString(),
    ref: 'abc1234',
    defectsTotal: 9,
    defectsScored: 9,
    mechanicalCatchRate: 1,
    falsePositiveRate: 0,
    byRegime: { mechanical: { total: 9, caught: 9 }, empirical: { total: 0, caught: 0 }, judgment: { total: 0, caught: 0 } },
    byRung: {},
    calibrationContradictionRate: 0,
    escapees: [],
    ...(critic ? { criticVerdicts: [{ defectId: 'd', caughtDefective: true, flaggedClean: false, note: '' }] } : {}),
  }
}

test('lastRunAt reads the newest run of one activity from the log', () => {
  const history = [
    { activity: 'audit' as const, deltaPhi: 0, cost: 0, at: 5 },
    { activity: 'audit' as const, deltaPhi: 0, cost: 0, at: 9 },
    { activity: 'verify' as const, deltaPhi: 0, cost: 0, at: 20 },
    { activity: 'audit' as const, deltaPhi: 0, cost: 0 },
  ]
  expect(lastRunAt(history, 'audit')).toBe(9)
  expect(lastRunAt(history, 'harvest')).toBeUndefined()
})

test('a routine audit waits its turn, so a free activity that always "runs" cannot starve the rest', async () => {
  const recent = [{ activity: 'audit' as const, deltaPhi: 0, cost: 0, at: NOW - 2 * HOUR }]
  const skipped = await createRunners({ spend: false, history: recent, now: NOW, cwd }).audit!(state())
  expect(skipped.ran).toBe(false)
  expect(skipped.detail).toContain('nothing is urgent')
  expect(AUDIT_EVERY_MS).toBeGreaterThan(2 * HOUR)
})

test('the verifier ladder is not re-measured while its last measurement is fresh', async () => {
  recordGapVector(vector(NOW - 2 * 24 * HOUR), cwd)
  const fresh = await createRunners({ spend: false, history: [], now: NOW, cwd }).verify!(state())
  expect(fresh.ran).toBe(false)
  expect(fresh.detail).toContain('deterministic')

  // Allowed to spend with no critic verdicts on record, it would re-run to add
  // the critic rung — unless it already tried this week and got nothing back.
  const tried = [{ activity: 'verify' as const, deltaPhi: 0, cost: 1, at: NOW - HOUR }]
  const again = await createRunners({ spend: true, history: tried, now: NOW, cwd }).verify!(state())
  expect(again.ran).toBe(false)
  expect(LADDER_STALE_MS).toBeGreaterThan(2 * 24 * HOUR)
})

test('every activity but solving has a runner; solving is the person\'s own work', () => {
  const runners = createRunners({ spend: false, history: [], meta: async () => ({ ran: true, detail: '', cost: 5 }) })
  expect(Object.keys(runners).sort()).toEqual(['audit', 'compress', 'harvest', 'meta', 'verify'])
  // Harvesting and measuring the ladder make no model calls, so they need no --spend.
  expect(PAID_ACTIVITIES.has('harvest')).toBe(false)
  expect(PAID_ACTIVITIES.has('verify')).toBe(false)
  expect(PAID_ACTIVITIES.has('meta')).toBe(true)
})

test('how long ago reads right from seconds to days', () => {
  expect(ago(6_000)).toBe('moments ago')
  expect(ago(20 * 60_000)).toBe('20 minute(s) ago')
  expect(ago(5 * HOUR)).toBe('5 hour(s) ago')
  expect(ago(72 * HOUR)).toBe('3 day(s) ago')
})
