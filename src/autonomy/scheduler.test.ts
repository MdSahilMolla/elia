import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { formatScheduleInterval, MIN_SCHEDULE_INTERVAL_MS, parseScheduleInterval, ScheduleStore } from './scheduler.ts'

describe('durable scheduler', () => {
  test('parses bounded human intervals', () => {
    expect(parseScheduleInterval('60s')).toBe(MIN_SCHEDULE_INTERVAL_MS)
    expect(parseScheduleInterval('2h')).toBe(2 * 60 * 60_000)
    expect(formatScheduleInterval(24 * 60 * 60_000)).toBe('1d')
    expect(() => parseScheduleInterval('30s')).toThrow('between 60s and 30d')
    expect(() => parseScheduleInterval('31d')).toThrow('between 60s and 30d')
  })

  test('persists a claimed run and schedules the next occurrence after completion', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'elia-schedule-')), 'schedules.json')
    const store = ScheduleStore.open(path)
    const created = store.create({ title: 'Health check', goal: 'Inspect local health evidence', intervalMs: MIN_SCHEDULE_INTERVAL_MS, now: 1_000 })
    expect(store.due(1_000)).toHaveLength(0)
    const claimed = store.claim(created.id, created.nextRunAt)
    expect(claimed.status).toBe('running')
    const completed = store.complete(created.id, { runId: 'run-1', outcome: 'completed' }, 70_000)
    expect(completed.status).toBe('active')
    expect(completed.nextRunAt).toBe(130_000)
    expect(ScheduleStore.open(path).list()[0]).toMatchObject({ runCount: 1, lastRunId: 'run-1', lastOutcome: 'completed' })
  })

  test('recovers an expired lease as due work instead of duplicating a running action', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'elia-schedule-')), 'schedules.json')
    const store = ScheduleStore.open(path)
    const created = store.create({ title: 'Recover me', goal: 'Read the local report', intervalMs: MIN_SCHEDULE_INTERVAL_MS, maxRunMs: 1, now: 1_000 })
    store.claim(created.id, created.nextRunAt)
    expect(store.due(62_000)).toHaveLength(0)
    const recovered = store.recoverExpired(200_000)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ status: 'active', nextRunAt: 200_000, failureCount: 1 })
    expect(store.due(200_000)).toHaveLength(1)
  })

  test('pause and resume provide an explicit operator control plane', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'elia-schedule-')), 'schedules.json')
    const store = ScheduleStore.open(path)
    const created = store.create({ title: 'Control me', goal: 'Review local evidence', intervalMs: MIN_SCHEDULE_INTERVAL_MS, now: 1_000 })
    expect(store.pause(created.id).status).toBe('paused')
    expect(store.due(created.nextRunAt)).toHaveLength(0)
    expect(store.resume(created.id, created.nextRunAt).status).toBe('active')
    expect(store.due(created.nextRunAt)).toHaveLength(1)
  })
})


test('persists a bounded action budget for scheduled runs', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'elia-schedule-')), 'schedules.json')
  const store = ScheduleStore.open(path)
  const created = store.create({ title: 'Bounded', goal: 'Inspect local evidence', intervalMs: MIN_SCHEDULE_INTERVAL_MS, maxActions: 42, now: 1_000 })
  expect(created.maxActions).toBe(42)
  expect(ScheduleStore.open(path).list()[0]?.maxActions).toBe(42)
  expect(() => store.create({ title: 'Invalid', goal: 'x', intervalMs: MIN_SCHEDULE_INTERVAL_MS, maxActions: 0 })).toThrow('between 1 and 10000')
  expect(() => store.create({ title: 'Invalid', goal: 'x', intervalMs: MIN_SCHEDULE_INTERVAL_MS, maxActions: 10_001 })).toThrow('between 1 and 10000')
})

test('persists Battmann mode for recurring intelligence runs', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'elia-schedule-')), 'schedules.json')
  const store = ScheduleStore.open(path)
  store.create({ title: 'Risk watch', goal: 'Refresh the risk brief', intervalMs: MIN_SCHEDULE_INTERVAL_MS, mode: 'battmann', now: 1_000 })
  expect(ScheduleStore.open(path).list()[0]?.mode).toBe('battmann')
})
