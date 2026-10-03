import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultMaxConcurrentSchedules, runScheduledDaemon } from './daemon.ts'
import { ScheduleStore } from './scheduler.ts'
import type { AutonomousRunResult } from './loop.ts'

let dir: string
let scheduleFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-daemon-'))
  scheduleFile = join(dir, 'schedules.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A structurally-complete-enough AutonomousRunResult for the fields runOneSchedule actually reads. */
function fakeResult(outcome: AutonomousRunResult['outcome'] = 'completed'): AutonomousRunResult {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    workspace: {} as AutonomousRunResult['workspace'],
    outcome,
    usage: {} as AutonomousRunResult['usage'],
    elapsedMs: 5,
    lessons: [],
    completion: {
      state: outcome === 'completed' ? 'done' : 'blocked',
      confidence: 'high',
      summary: 'test',
      evidence: [],
      blockers: outcome === 'completed' ? [] : ['test blocker'],
      nextActions: [],
      completedSteps: 1,
      totalSteps: 1,
      pendingApprovals: 0,
    } as AutonomousRunResult['completion'],
    actionBudget: {} as AutonomousRunResult['actionBudget'],
  }
}

test('defaultMaxConcurrentSchedules defaults to 4 and honors ELIA_MAX_CONCURRENT_SCHEDULES, clamped to [1,16]', () => {
  expect(defaultMaxConcurrentSchedules({})).toBe(4)
  expect(defaultMaxConcurrentSchedules({ ELIA_MAX_CONCURRENT_SCHEDULES: '2' })).toBe(2)
  expect(defaultMaxConcurrentSchedules({ ELIA_MAX_CONCURRENT_SCHEDULES: '1' })).toBe(1)
  expect(defaultMaxConcurrentSchedules({ ELIA_MAX_CONCURRENT_SCHEDULES: '999' })).toBe(16)
  expect(defaultMaxConcurrentSchedules({ ELIA_MAX_CONCURRENT_SCHEDULES: 'nonsense' })).toBe(4)
})

// #1280: the daemon used to run only store.due().at(0) per tick, so a second
// concurrently-due schedule sat waiting for the next poll (commonly 30s)
// behind an unrelated first one. One tick now runs up to maxConcurrent due
// schedules at once, each independently claimed.
test('one tick runs two concurrently-due schedules together, not one-then-wait', async () => {
  const store = ScheduleStore.open(scheduleFile)
  const now = Date.now()
  const a = store.create({ title: 'A', goal: 'goal a', intervalMs: 60_000, now: now - 61_000 })
  const b = store.create({ title: 'B', goal: 'goal b', intervalMs: 60_000, now: now - 61_000 })
  expect(store.due(now)).toHaveLength(2)

  const started: string[] = []
  const finishedAfterBothStarted: boolean[] = []
  let inFlight = 0
  const runTask = async (opts: { goal: string }) => {
    started.push(opts.goal)
    inFlight++
    // If the daemon were still single-flight, the second call would only
    // start after the first one's runTask had already returned — so by the
    // time either call is mid-flight, inFlight would never exceed 1.
    await new Promise((resolve) => setTimeout(resolve, 20))
    finishedAfterBothStarted.push(inFlight === 2)
    inFlight--
    return fakeResult()
  }

  await runScheduledDaemon({ scheduleFile, once: true, runTask: runTask as never, maxConcurrent: 4 })

  expect(started.sort()).toEqual(['goal a', 'goal b'])
  expect(finishedAfterBothStarted).toContain(true)
  const after = ScheduleStore.open(scheduleFile)
  expect(after.list().find((r) => r.id === a.id)?.lastOutcome).toBe('completed')
  expect(after.list().find((r) => r.id === b.id)?.lastOutcome).toBe('completed')
})

test('maxConcurrent bounds how many due schedules one tick claims, leaving the rest for the next poll', async () => {
  const store = ScheduleStore.open(scheduleFile)
  const now = Date.now()
  store.create({ title: 'A', goal: 'goal a', intervalMs: 60_000, now: now - 61_000 })
  store.create({ title: 'B', goal: 'goal b', intervalMs: 60_000, now: now - 61_000 })
  store.create({ title: 'C', goal: 'goal c', intervalMs: 60_000, now: now - 61_000 })
  expect(store.due(now)).toHaveLength(3)

  const started: string[] = []
  const runTask = async (opts: { goal: string }) => {
    started.push(opts.goal)
    return fakeResult()
  }

  await runScheduledDaemon({ scheduleFile, once: true, runTask: runTask as never, maxConcurrent: 1 })

  expect(started).toHaveLength(1)
  const remainingDue = ScheduleStore.open(scheduleFile).due(now + 1)
  expect(remainingDue).toHaveLength(2)
})

test('a failing schedule does not block its sibling in the same tick', async () => {
  const store = ScheduleStore.open(scheduleFile)
  const now = Date.now()
  const failing = store.create({ title: 'Fails', goal: 'goal fail', intervalMs: 60_000, now: now - 61_000 })
  const ok = store.create({ title: 'OK', goal: 'goal ok', intervalMs: 60_000, now: now - 61_000 })

  const runTask = async (opts: { goal: string }) => {
    if (opts.goal === 'goal fail') throw new Error('boom')
    return fakeResult()
  }

  await runScheduledDaemon({ scheduleFile, once: true, runTask: runTask as never, maxConcurrent: 4 })

  const after = ScheduleStore.open(scheduleFile)
  expect(after.list().find((r) => r.id === failing.id)?.lastOutcome).toBe('needs-attention')
  expect(after.list().find((r) => r.id === ok.id)?.lastOutcome).toBe('completed')
})

test('a schedule file shipped by a repo is never run by the daemon until the user trusts it', async () => {
  writeFileSync(scheduleFile, JSON.stringify({ version: 2, schedules: [{ id: 'evil', goal: 'goal from the repo', intervalMs: 60_000, nextRunAt: 1, status: 'active' }] }))
  const started: string[] = []
  const runTask = async (opts: { goal: string }) => {
    started.push(opts.goal)
    return fakeResult()
  }
  await runScheduledDaemon({ scheduleFile, once: true, runTask: runTask as never })
  expect(started).toEqual([])
})
