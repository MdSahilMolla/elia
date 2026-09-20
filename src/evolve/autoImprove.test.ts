import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BLOCKED_BACKOFF_MS,
  COOLDOWN_MS,
  MAX_RUN_MS,
  MIN_NEW_TURNS,
  autoImproveEnabled,
  looksBlocked,
  notePracticeTurn,
  practiceSummary,
  readAutoImproveState,
  renderPracticeStatus,
  shouldStartPractice,
  takePracticeReport,
  writeAutoImproveState,
} from './autoImprove.ts'

const now = 10 * COOLDOWN_MS
const dead = () => false
const alive = () => true

test('a project that has never practised starts as soon as it is idle', () => {
  expect(shouldStartPractice({}, { now, alive: dead }).start).toBe(true)
})

test('practice waits for the last run, a cooldown, and new experience — in that order', () => {
  const running = { pid: 42, startedAt: now - COOLDOWN_MS - 1, newTurns: 50 }
  expect(shouldStartPractice(running, { now, alive })).toEqual({ start: false, reason: 'a practice run is already going' })
  // A run that died without finishing does not hold the slot forever.
  expect(shouldStartPractice(running, { now, alive: dead }).start).toBe(true)
  // Nor does a pid Windows has since handed to some other process.
  expect(shouldStartPractice({ ...running, startedAt: now - MAX_RUN_MS - 1 }, { now, alive }).start).toBe(true)

  const recent = { startedAt: now - COOLDOWN_MS / 2, finishedAt: now - 1, newTurns: 50 }
  expect(shouldStartPractice(recent, { now, alive: dead }).reason).toBe('practised recently')

  const stale = { startedAt: now - COOLDOWN_MS * 2, finishedAt: now - COOLDOWN_MS, newTurns: MIN_NEW_TURNS - 1 }
  expect(shouldStartPractice(stale, { now, alive: dead }).reason).toContain('nothing new to learn from')
  expect(shouldStartPractice({ ...stale, newTurns: MIN_NEW_TURNS }, { now, alive: dead }).start).toBe(true)
})

test('a provider out of credit or rate-limited is left alone until the backoff passes', () => {
  const blocked = { startedAt: now - COOLDOWN_MS * 3, finishedAt: now - 1_000, newTurns: 100, blockedUntil: now + BLOCKED_BACKOFF_MS - 1_000 }
  expect(shouldStartPractice(blocked, { now, alive: dead }).start).toBe(false)
  expect(shouldStartPractice(blocked, { now: now + BLOCKED_BACKOFF_MS, alive: dead }).start).toBe(true)
  expect(looksBlocked('OpenRouter 402: insufficient credits')).toBe(true)
  expect(looksBlocked('429 Rate limit reached for model')).toBe(true)
  expect(looksBlocked('the baseline could not measure hist-7c2db18')).toBe(true)
  expect(looksBlocked('no measurable improvement (pass rate unchanged at 93%)')).toBe(false)
})

test('ELIA_AUTO_IMPROVE=off is the off switch, and on is the default', () => {
  expect(autoImproveEnabled({})).toBe(true)
  expect(autoImproveEnabled({ NODE_ENV: 'test' })).toBe(false)
  expect(autoImproveEnabled({ NODE_ENV: 'test', ELIA_AUTO_IMPROVE: 'on' })).toBe(true)
  expect(autoImproveEnabled({ ELIA_AUTO_IMPROVE: 'off' })).toBe(false)
  expect(shouldStartPractice({}, { now, enabled: false, alive: dead }).start).toBe(false)
})

test('turns from any session count as new experience, and a finished run is reported exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-practice-'))
  const path = join(dir, 'state.json')
  try {
    expect(takePracticeReport(path)).toBeUndefined()
    writeAutoImproveState({ startedAt: 1, newTurns: 0 }, path)
    for (let i = 0; i < 3; i += 1) notePracticeTurn(path)
    expect(readAutoImproveState(path).newTurns).toBe(3)
    // Still running: nothing to say yet.
    expect(takePracticeReport(path)).toBeUndefined()
    const summary = practiceSummary('promoted', 'read before guessing a path (same pass rate, 12% fewer tokens)', 'evolve/gen-3-2026-09-20')
    writeAutoImproveState({ ...readAutoImproveState(path), finishedAt: 2, outcome: 'promoted', summary }, path)
    expect(renderPracticeStatus(readAutoImproveState(path), { now: 3, alive: dead })).toContain('git merge evolve/gen-3-2026-09-20')
    expect(takePracticeReport(path)).toBe(summary)
    expect(takePracticeReport(path)).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
