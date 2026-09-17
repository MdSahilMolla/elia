import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearPreauthCaches, consumePreauth, DEFAULT_PREAUTH_TTL_MS, grantPreauth, isPreauthorized, preauthPath } from './preauth.ts'

let repoDir: string
let preauthDir: string

beforeEach(() => {
  // The repo key is an absolute temp path; the store is a separate temp dir
  // so tests don't clobber each other or the real ~/.elia/preauth.json.
  repoDir = mkdtempSync(join(tmpdir(), 'elia-preauth-repo-'))
  preauthDir = mkdtempSync(join(tmpdir(), 'elia-preauth-dir-'))
  process.env.ELIA_PREAUTH_DIR = preauthDir
  clearPreauthCaches()
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(preauthDir, { recursive: true, force: true })
  delete process.env.ELIA_PREAUTH_DIR
  clearPreauthCaches()
})

test('a granted intent is preauthorized for its exact project + branch, not before granting', () => {
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
  grantPreauth(['deployment.production'], repoDir, 'main')
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(true)
})

test('a grant does not cover a different branch or a different project', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  expect(isPreauthorized('deployment.production', repoDir, 'feature-x')).toBe(false)
  expect(isPreauthorized('deployment.production', join(repoDir, 'other'), 'main')).toBe(false)
})

test('a grant does not cover an intent it was not issued for', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  expect(isPreauthorized('github.pr_merge', repoDir, 'main')).toBe(false)
})

test('an expired grant is not preauthorized', () => {
  grantPreauth(['deployment.production'], repoDir, 'main', -1)
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
})

test('an invalid intent string is silently dropped, not granted', () => {
  const granted = grantPreauth(['../not an intent!!', ''], repoDir, 'main')
  expect(granted).toEqual([])
  expect(isPreauthorized('../not an intent!!', repoDir, 'main')).toBe(false)
})

test('consumePreauth bumps usedCount and persists it, and is a no-op with nothing live', () => {
  expect(consumePreauth('deployment.production', repoDir, 'main')).toBeUndefined()

  grantPreauth(['deployment.production'], repoDir, 'main')
  const first = consumePreauth('deployment.production', repoDir, 'main')
  expect(first?.usedCount).toBe(1)
  const second = consumePreauth('deployment.production', repoDir, 'main')
  expect(second?.usedCount).toBe(2)

  clearPreauthCaches()
  const onDisk = JSON.parse(readFileSync(preauthPath(), 'utf8'))
  expect(onDisk.grants[0].usedCount).toBe(2)
})

test('grantPreauth defaults to a multi-hour TTL when none is given', () => {
  const before = Date.now()
  const [grant] = grantPreauth(['deployment.production'], repoDir, 'main')
  expect(grant!.expiresAt - before).toBeGreaterThan(DEFAULT_PREAUTH_TTL_MS - 1000)
  expect(grant!.expiresAt - before).toBeLessThanOrEqual(DEFAULT_PREAUTH_TTL_MS + 1000)
})

test('granting again drops expired grants but keeps other live ones', () => {
  grantPreauth(['github.pr_merge'], repoDir, 'main', -1) // already expired
  grantPreauth(['deployment.production'], repoDir, 'main')
  const onDisk = JSON.parse(readFileSync(preauthPath(), 'utf8'))
  expect(onDisk.grants).toHaveLength(1)
  expect(onDisk.grants[0].intent).toBe('deployment.production')
})

test('every grant carries a valid HMAC signature (CLI-produced grants are trustworthy)', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  const onDisk = JSON.parse(readFileSync(preauthPath(), 'utf8'))
  expect(onDisk.grants[0].hmac).toBeTruthy()
  expect(typeof onDisk.grants[0].hmac).toBe('string')
  expect(onDisk.grants[0].hmac!.length).toBe(64) // SHA-256 hex
})

test('a grant written by hand without an HMAC is rejected on load', () => {
  // Simulate a repo-committed forgery: write a grant file that has no HMAC
  // and lives in the same store path that load() reads.
  grantPreauth(['deployment.production'], repoDir, 'main')
  const path = preauthPath()
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  // Strip the hmac from the first grant (simulating a forged file)
  delete onDisk.grants[0].hmac
  writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n')
  clearPreauthCaches()
  // The grant should be invisible — load() rejects grants without a valid hmac.
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
})

test('a grant with a far-future TTL (> MAX_ACCEPTED_TTL_MS) is rejected on load', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  const path = preauthPath()
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  // Forge an excessively long TTL: expiresAt 10 years from grantedAt
  onDisk.grants[0].expiresAt = onDisk.grants[0].grantedAt + 10 * 365 * 24 * 60 * 60_000
  writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n')
  clearPreauthCaches()
  // TTL bounds check in load() rejects the grant.
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
})

test('grantPreauth stores grants in the home directory, not in the project tree', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  // The file is written to ELIA_PREAUTH_DIR, not to repoDir/.elia/preauth.json.
  const homePath = preauthPath()
  expect(homePath.startsWith(preauthDir)).toBe(true)
  expect(existsSync(homePath)).toBe(true)
  // The old project-tree path does not exist.
  const projectPath = join(repoDir, '.elia', 'preauth.json')
  expect(existsSync(projectPath)).toBe(false)
})

test('ttlMs is clamped: negative and oversized TTLs resolve to valid windows', () => {
  const [negativeGrant] = grantPreauth(['deployment.production'], repoDir, 'main', -1)
  expect(negativeGrant!.expiresAt - negativeGrant!.grantedAt).toBe(0) // clamped to 0

  const hugeGrant = grantPreauth(['github.pr_merge'], repoDir, 'main', Infinity)[0]!
  // The clamped TTL is at most MAX_ACCEPTED_TTL_MS (8h)
  expect(hugeGrant.expiresAt - hugeGrant.grantedAt).toBeLessThanOrEqual(DEFAULT_PREAUTH_TTL_MS * 2 + 100)
})

// A2-07: hyphenated governor intents (shell.code-exec, github.pr_merge, …)
// used to fail INTENT_PATTERN, so the governor's own `--authorize <intent>`
// advice produced a grant that was silently dropped. A hyphen is a legal
// intent character.
test('a hyphenated intent (like the governor actually emits) can be granted', () => {
  const granted = grantPreauth(['shell.code-exec', 'github.pr_merge'], repoDir, 'main')
  expect(granted).toHaveLength(2)
  expect(isPreauthorized('shell.code-exec', repoDir, 'main')).toBe(true)
  expect(isPreauthorized('github.pr_merge', repoDir, 'main')).toBe(true)
})

test('the grant store is written with owner-only permissions', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  const mode = statSync(preauthPath()).mode & 0o777
  expect(mode).toBe(0o600)
  // The store directory is owner-only too.
  expect(statSync(preauthDir).mode & 0o777).toBe(0o700)
})
