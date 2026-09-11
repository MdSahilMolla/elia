import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveReward, digestArgs, readTrajectories, recordTrajectory, type TrajectoryInput } from './record.ts'
import { rotateSecureFile } from '../securePersistence.ts'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-traj-'))
  path = join(dir, 'interactive.ndjson')
  delete process.env.ELIA_NO_TRAJECTORY
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const input = (over: Partial<TrajectoryInput> = {}): TrajectoryInput => ({
  corr: 'task-1',
  kind: 'interactive',
  prompt: 'add a comment to foo.ts',
  systemPromptRef: 'ref',
  tools: [{ name: 'read_file', ok: true }, { name: 'edit_file', ok: true }],
  touched: [{ path: '/proj/foo.ts', before: 'a', after: 'a // note' }],
  verify: 'pass',
  cwdIsEliaRoot: false,
  reward: { scalar: 1, category: 'clean' },
  ...over,
})

// recordTrajectory writes to paths.trajectories, not a passed path — exercise it
// through a temp CWD-independent seam by writing/reading a file directly for the
// pure helpers, and testing recordTrajectory's guards separately.

test('deriveReward scores a clean verified turn at the top and an aborted turn at the bottom', () => {
  const clean = deriveReward({ toolErrors: 0, editRetries: 0, verify: 'pass', repairAttempts: 0, aborted: false })
  expect(clean).toEqual({ scalar: 1, category: 'clean' })

  const aborted = deriveReward({ toolErrors: 3, editRetries: 1, verify: 'none', repairAttempts: 0, aborted: true })
  expect(aborted).toEqual({ scalar: 0, category: 'aborted' })

  const repaired = deriveReward({ toolErrors: 1, editRetries: 2, verify: 'pass', repairAttempts: 1, aborted: false })
  expect(repaired.category).toBe('repaired')
  expect(repaired.scalar).toBeLessThan(1)
  expect(repaired.scalar).toBeGreaterThan(0)

  const failed = deriveReward({ toolErrors: 0, editRetries: 0, verify: 'fail', repairAttempts: 2, aborted: false })
  expect(failed.category).toBe('failed')

  const unverified = deriveReward({ toolErrors: 0, editRetries: 0, verify: 'skipped', repairAttempts: 0, aborted: false })
  expect(unverified.category).toBe('unverified')
  expect(unverified.scalar).toBeLessThan(1)
})

test('digestArgs is a short secret-free summary, never the raw input', () => {
  const d = digestArgs({ path: 'src/x.ts', count: 3, items: [1, 2], opts: { a: 1 } })
  expect(d).toContain('path=src/x.ts')
  expect(d).toContain('count=3')
  expect(d).toContain('items[2]')
  expect((d ?? '').length).toBeLessThanOrEqual(200)
})

test('recordTrajectory writes one interactive row per turn with the correlation id', () => {
  recordTrajectory(input(), dir)
  recordTrajectory(input({ corr: 'task-2' }), dir)
  const read = readTrajectories('interactive', path)
  expect(read).toHaveLength(2)
  expect(read.map((r) => r.corr)).toEqual(['task-1', 'task-2'])
  expect(read[0]?.tools.map((t) => t.name)).toEqual(['read_file', 'edit_file'])
})

test('recordTrajectory redacts the prompt and bounds oversized file bodies', () => {
  recordTrajectory(
    input({
      prompt: 'my key is sk-ant-api03-SECRETSECRETSECRET please use it',
      touched: [{ path: '/proj/big.ts', before: null, after: 'const value = computeThing();\n'.repeat(2_000) }],
    }),
    dir,
  )
  const row = readTrajectories('interactive', path)[0]!
  expect(row.promptRedacted).not.toContain('SECRETSECRETSECRET')
  expect((row.touched[0]?.after ?? '').length).toBeLessThan(25_000)
  expect(row.touched[0]?.after).toContain('more chars')
})

test('readTrajectories skips a corrupt line', () => {
  appendFileSync(path, `${JSON.stringify({ at: 1, corr: 'ok', kind: 'interactive' })}\n`)
  appendFileSync(path, 'not json at all\n')
  appendFileSync(path, `${JSON.stringify({ at: 2, corr: 'ok2', kind: 'interactive' })}\n`)
  const read = readTrajectories('interactive', path)
  expect(read.map((r) => r.corr)).toEqual(['ok', 'ok2'])
})

test('ELIA_NO_TRAJECTORY=1 disables capture', () => {
  process.env.ELIA_NO_TRAJECTORY = '1'
  recordTrajectory(input(), dir)
  expect(readTrajectories('interactive', path)).toHaveLength(0)
})

test('the trajectory file rotates and keeps the newest N past the size cap', () => {
  writeFileSync(path, 'x'.repeat(100))
  rotateSecureFile(path, 50, 3)
  expect(statSync(`${path}.1`).size).toBe(100)
  writeFileSync(path, 'y'.repeat(100))
  rotateSecureFile(path, 50, 3)
  expect(statSync(`${path}.2`).size).toBe(100) // the old .1
  expect(statSync(`${path}.1`).size).toBe(100) // the 'y' file
})

test('rotateSecureFile is a no-op below the size cap', () => {
  writeFileSync(path, 'small')
  rotateSecureFile(path, 1_000, 3)
  expect(statSync(path).size).toBe(5)
  expect(() => statSync(`${path}.1`)).toThrow()
})
