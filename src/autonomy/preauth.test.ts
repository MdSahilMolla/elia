import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearPreauthCaches, consumePreauth, DEFAULT_PREAUTH_TTL_MS, grantPreauth, isPreauthorized, preauthPath } from './preauth.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-preauth-'))
  clearPreauthCaches()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  clearPreauthCaches()
})

test('a granted intent is preauthorized for its exact project + branch, not before granting', () => {
  expect(isPreauthorized('deployment.production', dir, 'main')).toBe(false)
  grantPreauth(['deployment.production'], dir, 'main')
  expect(isPreauthorized('deployment.production', dir, 'main')).toBe(true)
})

test('a grant does not cover a different branch or a different project', () => {
  grantPreauth(['deployment.production'], dir, 'main')
  expect(isPreauthorized('deployment.production', dir, 'feature-x')).toBe(false)
  expect(isPreauthorized('deployment.production', join(dir, 'other'), 'main')).toBe(false)
})

test('a grant does not cover an intent it was not issued for', () => {
  grantPreauth(['deployment.production'], dir, 'main')
  expect(isPreauthorized('github.pr_merge', dir, 'main')).toBe(false)
})

test('an expired grant is not preauthorized', () => {
  grantPreauth(['deployment.production'], dir, 'main', -1)
  expect(isPreauthorized('deployment.production', dir, 'main')).toBe(false)
})

test('an invalid intent string is silently dropped, not granted', () => {
  const granted = grantPreauth(['../not an intent!!', ''], dir, 'main')
  expect(granted).toEqual([])
  expect(isPreauthorized('../not an intent!!', dir, 'main')).toBe(false)
})

test('consumePreauth bumps usedCount and persists it, and is a no-op with nothing live', () => {
  expect(consumePreauth('deployment.production', dir, 'main')).toBeUndefined()

  grantPreauth(['deployment.production'], dir, 'main')
  const first = consumePreauth('deployment.production', dir, 'main')
  expect(first?.usedCount).toBe(1)
  const second = consumePreauth('deployment.production', dir, 'main')
  expect(second?.usedCount).toBe(2)

  clearPreauthCaches()
  const onDisk = JSON.parse(readFileSync(preauthPath(dir), 'utf8'))
  expect(onDisk.grants[0].usedCount).toBe(2)
})

test('grantPreauth defaults to a multi-hour TTL when none is given', () => {
  const before = Date.now()
  const [grant] = grantPreauth(['deployment.production'], dir, 'main')
  expect(grant!.expiresAt - before).toBeGreaterThan(DEFAULT_PREAUTH_TTL_MS - 1000)
  expect(grant!.expiresAt - before).toBeLessThanOrEqual(DEFAULT_PREAUTH_TTL_MS + 1000)
})

test('granting again drops expired grants but keeps other live ones', () => {
  grantPreauth(['github.pr_merge'], dir, 'main', -1) // already expired
  grantPreauth(['deployment.production'], dir, 'main')
  const onDisk = JSON.parse(readFileSync(preauthPath(dir), 'utf8'))
  expect(onDisk.grants).toHaveLength(1)
  expect(onDisk.grants[0].intent).toBe('deployment.production')
})
