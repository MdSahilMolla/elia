import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BLOCKED_BACKOFF_MS,
  COOLDOWN_MS,
  HEARTBEAT_STALE_MS,
  MAX_RUN_MS,
  MIN_NEW_TURNS,
  autoImproveEnabled,
  looksBlocked,
  notePracticeTurn,
  practicePhase,
  practiceSummary,
  readAutoImproveState,
  reapCrashedRun,
  reapPractice,
  renderPracticeStatus,
  shouldStartPractice,
  startPracticeHeartbeat,
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

test('a run that is killed is noticed, not reported as still running forever', () => {
  // The real case this comes from: a practice run died four minutes in, wrote no
  // outcome, and `elia compounding` said "running since ..." for hours afterwards
  // while nothing was practising and nobody was told.
  const started = now - 4 * 60_000
  const killed = { pid: 9640, startedAt: started, heartbeatAt: started, newTurns: 0 }

  expect(practicePhase(killed, { now, alive })).toBe('running')
  expect(practicePhase(killed, { now, alive: dead })).toBe('crashed')
  // Alive but silent for too long is a reused pid, not a working run.
  expect(practicePhase({ ...killed, heartbeatAt: now - HEARTBEAT_STALE_MS - 1 }, { now, alive })).toBe('crashed')
  // And a pid held past any plausible run length is not trusted either.
  expect(practicePhase({ ...killed, startedAt: now - MAX_RUN_MS - 1, heartbeatAt: now }, { now, alive })).toBe('crashed')
  expect(practicePhase({}, { now, alive: dead })).toBe('never')
  expect(practicePhase({ startedAt: started, finishedAt: now - 1 }, { now, alive })).toBe('finished')

  const reaped = reapCrashedRun(killed, { now, alive: dead })!
  expect(reaped.outcome).toBe('failed')
  expect(reaped.finishedAt).toBe(now)
  expect(reaped.reported).toBe(false)
  expect(reaped.summary).toContain('stopped without finishing')
  // How long it worked, not how long it took to notice.
  expect(reaped.summary).toContain('ran for 1 minute(s)')
  expect(reapCrashedRun({ ...killed, heartbeatAt: started + 6 * 60_000 }, { now, alive: dead })!.summary).toContain('ran for 6 minute(s)')
  expect(reapCrashedRun({ ...killed, heartbeatAt: undefined }, { now, alive: dead })!.summary).toContain('never said how far it got')
  // Nothing to reap twice, nor while it is genuinely running.
  expect(reapCrashedRun(reaped, { now, alive: dead })).toBeUndefined()
  expect(reapCrashedRun(killed, { now, alive })).toBeUndefined()

  // The status stops lying, and the crash is still held off by the cooldown so a
  // run that dies on every attempt cannot spin.
  const rendered = renderPracticeStatus(killed, { now, alive: dead })
  expect(rendered).toContain('stopped without finishing')
  expect(rendered).not.toContain('running since')
  expect(shouldStartPractice(killed, { now, alive: dead }).reason).toBe('practised recently')
})

test('the next session is told a practice run died, exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-practice-'))
  const path = join(dir, 'state.json')
  try {
    writeAutoImproveState({ pid: 999_999, startedAt: Date.now() - 5 * 60_000, newTurns: 0 }, path)
    const report = takePracticeReport(path)
    expect(report).toContain("practice run failed")
    expect(report).toContain('auto-improve.log')
    expect(takePracticeReport(path)).toBeUndefined()
    expect(readAutoImproveState(path).outcome).toBe('failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a heartbeat marks the run alive, and stops when the slot is someone else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-practice-'))
  const path = join(dir, 'state.json')
  try {
    writeAutoImproveState({ pid: process.pid, startedAt: Date.now() }, path)
    const stop = startPracticeHeartbeat(path, 60_000)
    stop()
    const beat = readAutoImproveState(path).heartbeatAt
    expect(beat).toBeGreaterThan(0)
    // A finished run is not ours to keep touching.
    writeAutoImproveState({ pid: process.pid, startedAt: 1, finishedAt: 2, heartbeatAt: 5 }, path)
    startPracticeHeartbeat(path, 60_000)()
    expect(readAutoImproveState(path).heartbeatAt).toBe(5)
    // Nor is one another process claimed.
    writeAutoImproveState({ pid: process.pid + 1, startedAt: 1, heartbeatAt: 7 }, path)
    startPracticeHeartbeat(path, 60_000)()
    expect(readAutoImproveState(path).heartbeatAt).toBe(7)
    // Reaping persists the crash so later reads agree.
    expect(reapPractice(path, { now: Date.now(), alive: dead }).outcome).toBe('failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
