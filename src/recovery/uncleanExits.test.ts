import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSessionEnded, writeSessionHeartbeat, type SessionHeartbeatInput } from '../sessionRegistry.ts'
import { crashLoop, describeUncleanExits, findUncleanExits, markSeen, readSeen, takeRecoveryNotice } from './uncleanExits.ts'
import type { FaultRecord } from './faults.ts'

const base = mkdtempSync(join(tmpdir(), 'elia-unclean-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let counter = 0
function layout() {
  const root = join(base, `case-${counter++}`)
  const dirs = { sessionStatusDir: join(root, 'session-status'), runsDir: join(root, 'runs'), sessionsDir: join(root, 'sessions'), faultsPath: join(root, 'faults.ndjson'), seenPath: join(root, 'seen.json') }
  mkdirSync(dirs.sessionsDir, { recursive: true })
  return dirs
}

const DEAD = 999_001
const ALIVE = 999_002
const isAlive = (pid: number) => pid === ALIVE

function beat(sessionId: string, pid: number, overrides: Partial<SessionHeartbeatInput> = {}): SessionHeartbeatInput {
  return { sessionId, pid, mode: 'dev', providerLabel: 'test', model: 'test', startedAt: Date.now() - 60_000, busy: false, lastAction: 'Idle at prompt', taskSummary: '', messageCount: 4, ...overrides }
}

function run(runsDir: string, runId: string, events: Array<Record<string, unknown>>): void {
  mkdirSync(join(runsDir, runId), { recursive: true })
  writeFileSync(join(runsDir, runId, 'events.ndjson'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

function fatal(pid: number, overrides: Partial<FaultRecord> = {}): FaultRecord {
  return { at: new Date().toISOString(), pid, version: '0', command: 'repl', source: 'uncaught-exception', fatal: true, name: 'TypeError', message: 'x is undefined', frames: ['src/a.ts:3 load'], signature: 'abc1234567', ...overrides }
}

test('a session whose process died without ending is found; live and cleanly ended ones are not', () => {
  const dirs = layout()
  writeSessionHeartbeat(beat('dead-busy', DEAD, { busy: true, lastAction: 'Running tests' }), dirs.sessionStatusDir)
  writeFileSync(join(dirs.sessionsDir, 'dead-busy.json'), '{}')
  writeSessionHeartbeat(beat('alive', ALIVE), dirs.sessionStatusDir)
  writeSessionEnded(beat('ended', DEAD), dirs.sessionStatusDir)

  const exits = findUncleanExits({ ...dirs, isAlive })
  expect(exits.map((exit) => exit.id)).toEqual(['dead-busy'])
  expect(exits[0]).toMatchObject({ kind: 'session', busy: true, resumable: true })
  expect(describeUncleanExits(exits)).toContain('elia --resume dead-busy')
  expect(describeUncleanExits(exits)).toContain('mid-turn (Running tests)')
})

test('a crash the guard recorded is reported even though its shutdown marked the session ended', () => {
  const dirs = layout()
  writeSessionEnded(beat('crashed', DEAD), dirs.sessionStatusDir)
  writeFileSync(dirs.faultsPath, `${JSON.stringify(fatal(DEAD, { sessionId: 'crashed' }))}\n`)
  const [exit] = findUncleanExits({ ...dirs, isAlive })
  expect(exit?.fault?.signature).toBe('abc1234567')
  expect(describeUncleanExits([exit!])).toContain('it crashed: TypeError: x is undefined — src/a.ts:3 load')
  expect(describeUncleanExits([exit!])).toContain('elia doctor --repair')
})

test('a crash from before the session started is never pinned on it through a reused pid', () => {
  const dirs = layout()
  writeSessionHeartbeat(beat('recycled', DEAD, { startedAt: Date.now() - 1_000 }), dirs.sessionStatusDir)
  writeFileSync(dirs.faultsPath, `${JSON.stringify(fatal(DEAD, { at: new Date(Date.now() - 3_600_000).toISOString() }))}\n`)
  const [exit] = findUncleanExits({ ...dirs, isAlive })
  expect(exit?.id).toBe('recycled')
  expect(exit?.fault).toBeUndefined()
})

test('a run with no run-end after its last start, whose process is gone, is interrupted', () => {
  const dirs = layout()
  const now = Date.now()
  run(dirs.runsDir, 'r-dead', [{ seq: 1, at: now - 5_000, kind: 'run-start', data: { goal: 'add rate limiting', pid: DEAD } }, { seq: 2, at: now - 4_000, kind: 'phase', data: {} }])
  run(dirs.runsDir, 'r-done', [{ seq: 1, at: now, kind: 'run-start', data: { goal: 'g', pid: DEAD } }, { seq: 2, at: now, kind: 'run-end', data: { outcome: 'completed' } }])
  run(dirs.runsDir, 'r-alive', [{ seq: 1, at: now, kind: 'run-start', data: { goal: 'g', pid: ALIVE } }])
  // Resumed, then died again: the second start is the one that counts.
  run(dirs.runsDir, 'r-resumed', [
    { seq: 1, at: now - 9_000, kind: 'run-start', data: { goal: 'g2', pid: ALIVE } },
    { seq: 2, at: now - 8_000, kind: 'run-end', data: { outcome: 'interrupted' } },
    { seq: 3, at: now - 7_000, kind: 'run-start', data: { goal: 'g2', pid: DEAD } },
  ])
  // Written before run-start carried a pid: cannot tell, so not claimed.
  run(dirs.runsDir, 'r-old', [{ seq: 1, at: now, kind: 'run-start', data: { goal: 'g' } }])

  const exits = findUncleanExits({ ...dirs, isAlive })
  expect(exits.map((exit) => exit.id).sort()).toEqual(['r-dead', 'r-resumed'])
  expect(describeUncleanExits(exits)).toContain('elia resume r-dead')
})

test('each exit is reported once', () => {
  const dirs = layout()
  writeSessionHeartbeat(beat('once', DEAD), dirs.sessionStatusDir)
  const first = takeRecoveryNotice({ ...dirs, isAlive })
  expect(first).toContain('session once')
  expect(takeRecoveryNotice({ ...dirs, isAlive })).toBeUndefined()
  expect(readSeen(dirs.seenPath).has('session:once')).toBe(true)
  // An unwritable seen file costs a repeat, never a throw.
  markSeen([{ kind: 'session', id: 'x', at: 0, pid: 1, busy: false, detail: '', resumable: false }], join(dirs.faultsPath, 'not-a-dir', 'seen.json'))
})

test('the crash-loop check reads the fault log', () => {
  const dirs = layout()
  writeFileSync(dirs.faultsPath, `${JSON.stringify(fatal(1))}\n${JSON.stringify(fatal(2))}\n`)
  expect(crashLoop({ faultsPath: dirs.faultsPath })).toMatchObject({ signature: 'abc1234567', count: 2 })
  expect(crashLoop({ faultsPath: join(dirs.faultsPath, 'missing') })).toBeUndefined()
})
