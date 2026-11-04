import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearPreauthCaches, consumePreauth, DEFAULT_PREAUTH_TTL_MS, grantPreauth, isPreauthorized, listLivePreauth, preauthPath, revokePreauth, userPreauthSecret } from './preauth.ts'

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

// Windows has no POSIX mode bits to assert on.
test.if(process.platform !== 'win32')('the grant store is written with owner-only permissions', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  const mode = statSync(preauthPath()).mode & 0o777
  expect(mode).toBe(0o600)
  // The store directory is owner-only too.
  expect(statSync(preauthDir).mode & 0o777).toBe(0o700)
})

test('a maxUses:1 grant is spent after its one use, even though its time window has not expired', () => {
  grantPreauth(['deployment.production'], repoDir, 'main', DEFAULT_PREAUTH_TTL_MS, 1)
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(true)
  expect(consumePreauth('deployment.production', repoDir, 'main')?.usedCount).toBe(1)
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
  expect(consumePreauth('deployment.production', repoDir, 'main')).toBeUndefined()
})

test('a grant with no maxUses stays usable across repeated consumption', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  for (let i = 0; i < 5; i++) expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(true)
  for (let i = 0; i < 5; i++) consumePreauth('deployment.production', repoDir, 'main')
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(true)
})

test('a maxUses of 3 allows exactly 3 uses, not 2 or 4', () => {
  grantPreauth(['deployment.production'], repoDir, 'main', DEFAULT_PREAUTH_TTL_MS, 3)
  for (let i = 0; i < 3; i++) {
    expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(true)
    consumePreauth('deployment.production', repoDir, 'main')
  }
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
})

test('a hand-edited maxUses (loosening a cap after the fact) invalidates the signature', () => {
  grantPreauth(['deployment.production'], repoDir, 'main', DEFAULT_PREAUTH_TTL_MS, 1)
  const path = preauthPath()
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  onDisk.grants[0].maxUses = 1000 // forged: raise the cap without the secret
  writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n')
  clearPreauthCaches()
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
})

test('a grant signed before `mode` was signed still verifies, and keeps its old meaning', () => {
  // The upgrade hazard: `mode` joined the signed payload, so a grant written by
  // an earlier version carries a signature over six fields, not seven. If only
  // the new form verified, every live grant on the machine would fail closed on
  // upgrade and an operator's `/scope all` would vanish with nothing to explain
  // it. Re-sign it the old way to stand in for that file.
  grantPreauth(['deployment.production'], repoDir, 'main')
  const path = preauthPath()
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  const grant = onDisk.grants[0]
  const legacy = [grant.intent, grant.repo, grant.branch, grant.grantedAt, grant.expiresAt, grant.maxUses ?? ''].join('\n')
  grant.hmac = createHmac('sha256', userPreauthSecret()).update(legacy).digest('hex')
  writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n')
  clearPreauthCaches()

  // No `mode` field, so it means what it always meant: every mode.
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(true)
})

test('adding a mode to a six-field-signed grant does not verify', () => {
  // The direction that matters for safety. The six-field signature never covered
  // `mode`, so someone who can write the file must not be able to attach one and
  // keep a valid signature — otherwise hand-editing a grant into `mode: "cyber"`
  // would be a privilege edit the secret was never asked about.
  grantPreauth(['deployment.production'], repoDir, 'main')
  const path = preauthPath()
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  const grant = onDisk.grants[0]
  const legacy = [grant.intent, grant.repo, grant.branch, grant.grantedAt, grant.expiresAt, grant.maxUses ?? ''].join('\n')
  grant.hmac = createHmac('sha256', userPreauthSecret()).update(legacy).digest('hex')
  grant.mode = 'cyber'
  writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n')
  clearPreauthCaches()

  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
})

test('revokePreauth removes a live grant immediately, before it expires or is spent', () => {
  grantPreauth(['deployment.production'], repoDir, 'main')
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(true)
  expect(revokePreauth('deployment.production', repoDir, 'main')).toBe(1)
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
  // Revoking again finds nothing left to remove.
  expect(revokePreauth('deployment.production', repoDir, 'main')).toBe(0)
})

test('revokePreauth only removes the named intent + project + branch, not siblings', () => {
  grantPreauth(['deployment.production', 'github.pr_merge'], repoDir, 'main')
  expect(revokePreauth('deployment.production', repoDir, 'main')).toBe(1)
  expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
  expect(isPreauthorized('github.pr_merge', repoDir, 'main')).toBe(true)
})

test('listLivePreauth reports only live grants for the given project + branch, with use counts', () => {
  grantPreauth(['deployment.production'], repoDir, 'main', DEFAULT_PREAUTH_TTL_MS, 2)
  grantPreauth(['github.pr_merge'], repoDir, 'main', -1) // already expired
  consumePreauth('deployment.production', repoDir, 'main')
  const live = listLivePreauth(repoDir, 'main')
  expect(live).toHaveLength(1)
  expect(live[0]).toMatchObject({ intent: 'deployment.production', usedCount: 1, maxUses: 2 })
})

test('the grant store lives under ~/.config/elia, never in the repo tree (#1272)', () => {
  const override = process.env.ELIA_PREAUTH_DIR
  delete process.env.ELIA_PREAUTH_DIR
  clearPreauthCaches()
  try {
    const home = homedir().replaceAll('\\', '/')
    expect(preauthPath().replaceAll('\\', '/')).toBe(`${home}/.config/elia/preauth.json`)
    // And it is not the project's own `.elia`, which a repository could ship.
    expect(preauthPath().replaceAll('\\', '/')).not.toContain('/.elia/')
  } finally {
    if (override) process.env.ELIA_PREAUTH_DIR = override
    clearPreauthCaches()
  }
})

test('a pre-relocation ~/.elia store is migrated once, and its grants stay valid (#1272)', () => {
  // What the previous location looked like: a store plus the secret that signs
  // its grants, both under ~/.elia.
  const legacy = mkdtempSync(join(tmpdir(), 'elia-preauth-legacy-'))
  const legacyStore = join(legacy, 'preauth.json')
  const legacySecret = join(legacy, 'preauth.secret')
  writeFileSync(legacySecret, 'legacy-secret-value\n', { mode: 0o600 })
  const relocated = mkdtempSync(join(tmpdir(), 'elia-preauth-dir-'))
  try {
    process.env.ELIA_PREAUTH_DIR = legacy
    clearPreauthCaches()
    grantPreauth(['deployment.production'], repoDir, 'main')

    process.env.ELIA_PREAUTH_DIR = relocated
    process.env.ELIA_PREAUTH_LEGACY_PATH = legacyStore
    clearPreauthCaches()

    // The grant still verifies, which it only can if the legacy secret came
    // across with it — a fresh secret would silently invalidate every grant.
    expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(true)
    expect(preauthPath()).toBe(join(relocated, 'preauth.json'))
    expect(readFileSync(join(relocated, 'preauth.secret'), 'utf8').trim()).toBe('legacy-secret-value')
    // Moved, not copied: no second, unmigrated copy of live authority is left
    // behind in the old location.
    expect(existsSync(legacyStore)).toBe(false)
    expect(existsSync(legacySecret)).toBe(false)
  } finally {
    delete process.env.ELIA_PREAUTH_LEGACY_PATH
    process.env.ELIA_PREAUTH_DIR = preauthDir
    clearPreauthCaches()
    rmSync(legacy, { recursive: true, force: true })
    rmSync(relocated, { recursive: true, force: true })
  }
})

test('a legacy store is left alone when the store is relocated by a test override (#1272)', () => {
  // With ELIA_PREAUTH_DIR set and no ELIA_PREAUTH_LEGACY_PATH, migration is
  // disabled: a test run must never consume the real machine's ~/.elia store
  // (and delete it), which is exactly what a naive "migrate on first read"
  // would do to whoever runs the suite.
  const untouched = mkdtempSync(join(tmpdir(), 'elia-preauth-untouched-'))
  try {
    writeFileSync(join(untouched, 'preauth.json'), '{"grants":[]}', { mode: 0o600 })
    expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
    expect(existsSync(join(untouched, 'preauth.json'))).toBe(true)
  } finally {
    rmSync(untouched, { recursive: true, force: true })
  }
})

test('an empty secret file is replaced, not used as an empty HMAC key (#1272)', () => {
  // An empty key would make every grant signature forgeable — the exact hole
  // the per-user secret exists to close — so a blank or truncated secret file
  // (an interrupted write, a bad disk) must regenerate rather than verify
  // anything.
  const blank = mkdtempSync(join(tmpdir(), 'elia-preauth-blank-'))
  try {
    writeFileSync(join(blank, 'preauth.secret'), '   \n', { mode: 0o600 })
    process.env.ELIA_PREAUTH_DIR = blank
    clearPreauthCaches()
    expect(userPreauthSecret().length).toBe(64)
    expect(readFileSync(join(blank, 'preauth.secret'), 'utf8').trim().length).toBe(64)
    // A grant signed by the regenerated key is the only one that verifies.
    grantPreauth(['deployment.production'], repoDir, 'main')
    const store = JSON.parse(readFileSync(join(blank, 'preauth.json'), 'utf8'))
    store.grants[0].hmac = 'f'.repeat(64)
    writeFileSync(join(blank, 'preauth.json'), JSON.stringify(store))
    clearPreauthCaches()
    expect(isPreauthorized('deployment.production', repoDir, 'main')).toBe(false)
  } finally {
    process.env.ELIA_PREAUTH_DIR = preauthDir
    clearPreauthCaches()
    rmSync(blank, { recursive: true, force: true })
  }
})
