import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approveSelfEditFile,
  armSelfEditGuard,
  needsSelfEditApproval,
  assertSelfEditAllowed,
  describeSelfEdit,
  disarmSelfEditGuard,
  isEliaSource,
  selfEditFromEnv,
  selfEditGuard,
  selfEditRefusal,
  setSelfEditAllowed,
} from './selfEdit.ts'

let root: string

beforeEach(() => {
  // .native: the plain one leaves an 8.3 name (C:\Users\RUNNER~1) unexpanded,
  // and the guard stores the long form.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'elia-self-')))
  mkdirSync(join(root, 'workspace', 'app'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
})

afterEach(() => {
  disarmSelfEditGuard()
  rmSync(root, { recursive: true, force: true })
})

test('elia source is the checkout minus workspace/ and .elia/', () => {
  expect(isEliaSource(root, root)).toBe(true)
  expect(isEliaSource(join(root, 'src', 'skills', 'new.ts'), root)).toBe(true)
  expect(isEliaSource(join(root, 'package.json'), root)).toBe(true)
  expect(isEliaSource(join(root, 'workspace', 'app', 'index.html'), root)).toBe(false)
  expect(isEliaSource(join(root, '.elia', 'skills', 'x.skill.ts'), root)).toBe(false)
  // A folder whose name merely starts like an open one is still elia.
  expect(isEliaSource(join(root, 'workspaces', 'x.ts'), root)).toBe(true)
  expect(isEliaSource(join(tmpdir(), 'some-other-project', 'a.ts'), root)).toBe(false)
})

test('the guard arms only for a session on elia itself', () => {
  expect(armSelfEditGuard(join(tmpdir(), 'elsewhere'), false, root)).toBeUndefined()
  expect(armSelfEditGuard(join(root, 'workspace', 'app'), false, root)).toBeUndefined()
  expect(selfEditRefusal(join(root, 'src', 'a.ts'))).toBeUndefined()
  expect(describeSelfEdit()).toContain('does not apply')
  // Nothing to flip when unarmed.
  expect(setSelfEditAllowed(true)).toBeUndefined()

  expect(armSelfEditGuard(join(root, 'src'), false, root)).toMatchObject({ root, allowed: false })
  expect(armSelfEditGuard(root, false, root)).toMatchObject({ root, allowed: false })
})

test('while off, writes to elia are refused and writes to workspace/ and .elia/ are not; on lets them through', () => {
  armSelfEditGuard(root, false, root)
  expect(() => assertSelfEditAllowed(join(root, 'src', 'skills', 'ponytail.ts'))).toThrow(/nobody approved changing it/)
  expect(selfEditRefusal(join(root, 'src', 'skills', 'ponytail.ts'))).toMatch(/^src[\\/]skills[\\/]ponytail\.ts is part of elia's own source/)
  expect(() => assertSelfEditAllowed(join(root, 'workspace', 'app', 'index.html'))).not.toThrow()
  expect(() => assertSelfEditAllowed(join(root, '.elia', 'notes.md'))).not.toThrow()
  expect(() => assertSelfEditAllowed(join(tmpdir(), 'elsewhere.txt'))).not.toThrow()
  expect(describeSelfEdit()).toContain('asks before changing its own source')

  // One approved file opens only that file.
  approveSelfEditFile(join(root, 'src', 'skills', 'real.ts'))
  expect(needsSelfEditApproval(join(root, 'src', 'skills', 'real.ts'))).toBe(false)
  expect(needsSelfEditApproval(join(root, 'src', 'skills', 'ponytail.ts'))).toBe(true)

  expect(setSelfEditAllowed(true)?.allowed).toBe(true)
  expect(() => assertSelfEditAllowed(join(root, 'src', 'skills', 'ponytail.ts'))).not.toThrow()
  expect(describeSelfEdit()).toContain('Self-edit is ON')
  expect(selfEditGuard()?.allowed).toBe(true)
})

test('ELIA_SELF_EDIT turns it on only for an explicit yes', () => {
  expect(selfEditFromEnv({ ELIA_SELF_EDIT: '1' })).toBe(true)
  expect(selfEditFromEnv({ ELIA_SELF_EDIT: 'on' })).toBe(true)
  expect(selfEditFromEnv({ ELIA_SELF_EDIT: '0' })).toBe(false)
  expect(selfEditFromEnv({})).toBe(false)
})
