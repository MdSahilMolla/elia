/**
 * Scoped, time-limited pre-authorization grants — the one deliberate way
 * around governor.ts's blanket unattended refusal for browser/comms/
 * production-deploy/PR-merge/force-push/codex_delegate actions.
 *
 * Grants live under the user's home directory (~/.config/elia/preauth.json),
 * NOT in the project tree. A repository once shipped grant data via its own
 * `.elia/preauth.json`; that let any commit forge silent authority for the
 * critical intents below. Keeping the grant file out of the repo means a
 * cloned or compromised repository can never contribute an authorization. (It
 * also used to be ~/.elia/preauth.json, one dot-directory away from where a
 * session's own state lives; the grant store, its secret and the global
 * allow-file now share one ~/.config/elia home, and a pre-existing ~/.elia
 * store is migrated on first read.) Grants are keyed by the exact project
 * directory + git branch they name, and each carries an HMAC-SHA256 signature
 * over its own fields, produced from a per-user secret stored at
 * ~/.config/elia/preauth.secret (generated on first use) — a file whose content
 * nobody but this machine's `--authorize` invocation can reproduce, so a file
 * edited by hand (or committed somewhere by accident) verifies as nothing.
 *
 * `policy.ts` can only ever tighten the governor; it says so in its own
 * doc comment, and that invariant is worth keeping simple and absolute. This
 * is the narrow, explicit exception to it, kept in its own file so that
 * invariant stays true of policy.ts specifically. A grant only ever loosens
 * governance for:
 *   - an intent the human named explicitly (never "everything critical")
 *   - the exact project directory + git branch it was granted for
 *   - a bounded time window, hard-capped at DEFAULT_PREAUTH_TTL_MS — grants
 *     whose TTL exceeds the cap are rejected on load, so a "temporary" grant
 *     cannot be written as year-2999
 * and every use is folded into the assessment reason that the normal action
 * audit ledger (audit.ts, via appendActionAudit) already records — so a
 * grant-authorized action is never invisible in the run's own audit trail.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execCapture } from '../github/exec.ts'

export interface PreauthGrant {
  /** A governor `assessment.intent`, e.g. "deployment.production", "github.pr_merge". */
  intent: string
  /** The project directory this grant covers — never carries across projects. */
  repo: string
  /** The git branch this grant covers — never carries across a branch switch mid-run. */
  branch: string
  grantedAt: number
  expiresAt: number
  usedCount: number
  lastUsedAt?: number
  /** Once `usedCount` reaches this, the grant is spent even if still inside its time window. `--authorize deployment.production:1` sets this to 1 for a true one-shot. Absent means uncapped (the original time-window-only behavior). */
  maxUses?: number
  /** HMAC-SHA256 over intent/repo/branch/grantedAt/expiresAt/maxUses with the per-user secret. */
  hmac?: string
}

interface PreauthFile {
  grants: PreauthGrant[]
}

const MAX_GRANTS = 50
const INTENT_PATTERN = /^[a-z][a-z0-9_.-]{1,80}$/
/** Generous enough to cover a long unattended run; short enough that a forgotten grant doesn't linger across sessions. */
export const DEFAULT_PREAUTH_TTL_MS = 4 * 60 * 60_000
/**
 * Grants are hard-capped at twice the documented TTL. The CLI always grants
 * DEFAULT_PREAUTH_TTL_MS; the 2× bound absorbs a user-supplied `ttlMs` while
 * still rejecting a hand-edited `expiresAt` like year 2999.
 */
const MAX_ACCEPTED_TTL_MS = DEFAULT_PREAUTH_TTL_MS * 2

// Test seam: ELIA_PREAUTH_DIR relocates the grant store (mirrors how
// ELIA_ALLOW_GLOBAL_PATH relocates the global allow-file for hermetic tests).
// Computed dynamically so tests can change ELIA_PREAUTH_DIR between imports.
// The per-user trust stores live under ~/.config/elia (not the project's
// `.elia`) so no checked-out repo picks up or shadows them; a one-time
// migration moves an existing ~/.elia store across on first read.
export function preauthDir(): string {
  return process.env.ELIA_PREAUTH_DIR ?? join(homedir(), '.config', 'elia')
}

/**
 * The pre-relocation location. Only consulted when migration is allowed:
 * with ELIA_PREAUTH_DIR set for a test, the real ~/.elia store must never be
 * consumed (and deleted) by a test run, so ELIA_PREAUTH_LEGACY_PATH is the
 * only way to point a test at a legacy store to migrate.
 */
function legacyPreauthPath(): string {
  return process.env.ELIA_PREAUTH_LEGACY_PATH ?? join(homedir(), '.elia', 'preauth.json')
}

function legacyPreauthSecretPath(): string {
  const base = process.env.ELIA_PREAUTH_LEGACY_PATH
  // Mirror the real legacy layout: the store is preauth.json, the secret
  // preauth.secret, side by side.
  return base ? `${base.replace(/\.json$/, '')}.secret` : join(homedir(), '.elia', 'preauth.secret')
}

/** True when a legacy `~/.elia` store may be migrated into the active one. */
function legacyMigrationAllowed(): boolean {
  return !process.env.ELIA_PREAUTH_DIR || process.env.ELIA_PREAUTH_LEGACY_PATH !== undefined
}

function preauthSecretPath(): string {
  return join(preauthDir(), 'preauth.secret')
}

export function preauthPath(): string {
  return join(preauthDir(), 'preauth.json')
}

/** The per-user HMAC secret, created lazily at ~/.config/elia/preauth.secret (mode 0600). */
let cachedSecret: string | undefined
function getSecret(): string {
  if (cachedSecret !== undefined) return cachedSecret
  const secretPath = preauthSecretPath()
  const existing = existsSync(secretPath) ? readFileSync(secretPath, 'utf8').trim() : ''
  if (existing) {
    cachedSecret = existing
    return cachedSecret
  }
  mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 })
  // First use under the new home: carry a legacy secret across rather than
  // silently invalidating every pre-existing grant, then discard the old file.
  // An empty or missing secret falls back to a fresh random one: an empty HMAC
  // key would make every signature forgeable, which is the hole this secret
  // exists to close.
  const legacySecret = legacyPreauthSecretPath()
  const migrated = legacySecret && legacyMigrationAllowed() && existsSync(legacySecret)
    ? readFileSync(legacySecret, 'utf8').trim()
    : ''
  cachedSecret = migrated || randomBytes(32).toString('hex')
  writeFileSync(secretPath, `${cachedSecret}\n`, { mode: 0o600 })
  if (migrated && legacySecret) {
    try {
      rmSync(legacySecret, { force: true })
    } catch {
      /* best effort */
    }
  }
  return cachedSecret
}

/** The per-user HMAC secret — also signs the global allow-store. */
export function userPreauthSecret(): string {
  return getSecret()
}

function hmacGrant(grant: PreauthGrant): string {
  const data = [grant.intent, grant.repo, grant.branch, grant.grantedAt, grant.expiresAt, grant.maxUses ?? ''].join('\n')
  return createHmac('sha256', getSecret()).update(data).digest('hex')
}

interface Cached {
  mtimeMs: number
  file: PreauthFile
}
const cache = new Map<string, Cached>()
const EMPTY: PreauthFile = { grants: [] }

function load(path: string): PreauthFile {
  // One-time migration of a pre-relocation store at ~/.elia/preauth.json: the
  // grants are whatever the previous elia wrote (signed with the migrated
  // secret above), so copying the file over keeps live grants alive. New
  // writes land on the ~/.config/elia path from here on.
  const legacy = legacyPreauthPath()
  if (legacyMigrationAllowed() && legacy !== path && !existsSync(path) && existsSync(legacy)) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, readFileSync(legacy, 'utf8'), { mode: 0o600 })
      rmSync(legacy, { force: true })
    } catch {
      /* migration is best effort; a failed load below simply grants nothing */
    }
  }
  if (!existsSync(path)) {
    cache.delete(path)
    return EMPTY
  }
  const hit = cache.get(path)
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return EMPTY
  }
  if (hit && hit.mtimeMs === mtimeMs) return hit.file
  let file: PreauthFile = EMPTY
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as PreauthFile).grants)) {
      file = {
        grants: (parsed as PreauthFile).grants
          .filter((g): g is PreauthGrant => {
            if (!g || typeof g.intent !== 'string' || typeof g.repo !== 'string' || typeof g.branch !== 'string' || typeof g.grantedAt !== 'number' || typeof g.expiresAt !== 'number') return false
            if (g.maxUses !== undefined && (typeof g.maxUses !== 'number' || !Number.isInteger(g.maxUses) || g.maxUses < 1)) return false
            // A grant with no signature is not one the CLI produced — and a
            // malformed one grants nothing. Signing requires the per-user
            // secret, so a hand-written or repo-committed grant fails here.
            if (!g.hmac || g.hmac !== hmacGrant(g)) return false
            // Bounds the TTL to what grantPreauth can produce: a hand-edited
            // far-future expiresAt is rejected instead of honored as live.
            if (g.expiresAt - g.grantedAt > MAX_ACCEPTED_TTL_MS) return false
            return true
          })
          .slice(0, MAX_GRANTS),
      }
    }
  } catch {
    // A malformed preauth.json grants nothing — treat it as empty rather than throw.
    file = EMPTY
  }
  cache.set(path, { mtimeMs, file })
  return file
}

function save(path: string, file: PreauthFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  cache.delete(path)
}

/** Best-effort current branch, resolved once and reused — never blocks or throws on a git failure. */
const branchCache = new Map<string, Promise<string>>()
export function currentBranch(cwd = process.cwd()): Promise<string> {
  let cached = branchCache.get(cwd)
  if (!cached) {
    cached = execCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
      .then((result) => (result.ok ? result.stdout.trim() || 'unknown' : 'unknown'))
      .catch(() => 'unknown')
    branchCache.set(cwd, cached)
  }
  return cached
}

/** Test seam. */
export function clearPreauthCaches(): void {
  cache.clear()
  branchCache.clear()
  cachedSecret = undefined
}

/**
 * Records one grant per requested intent, scoped to this project directory
 * and the branch given (resolve it once via {@link currentBranch} at the call
 * site — a human granting `--authorize` from a terminal at run start). Returns
 * the grants actually written (invalid intents are dropped, not thrown).
 */
export function grantPreauth(intents: string[], cwd: string, branch: string, ttlMs = DEFAULT_PREAUTH_TTL_MS, maxUses?: number): PreauthGrant[] {
  const path = preauthPath()
  const file = load(path)
  const now = Date.now()
  // Clamp rather than honor: `-1` (an already-expired grant, used under test)
  // and oversized TTLs both resolve to the supported window.
  const clampedTtlMs = Math.min(Math.max(0, ttlMs), MAX_ACCEPTED_TTL_MS)
  const clampedMaxUses = maxUses !== undefined && Number.isInteger(maxUses) && maxUses >= 1 ? maxUses : undefined
  const granted: PreauthGrant[] = []
  for (const intent of intents) {
    if (!INTENT_PATTERN.test(intent)) continue
    const grant: PreauthGrant = { intent, repo: cwd, branch, grantedAt: now, expiresAt: now + clampedTtlMs, usedCount: 0, maxUses: clampedMaxUses }
    grant.hmac = hmacGrant(grant)
    granted.push(grant)
  }
  if (granted.length === 0) return []
  const next: PreauthFile = { grants: [...file.grants.filter((g) => g.expiresAt > now), ...granted].slice(-MAX_GRANTS) }
  save(path, next)
  return granted
}

function isSpent(grant: PreauthGrant): boolean {
  return grant.maxUses !== undefined && grant.usedCount >= grant.maxUses
}

function findLive(intent: string, cwd: string, branch: string, now: number): { file: PreauthFile; path: string; grant: PreauthGrant } | undefined {
  const path = preauthPath()
  const file = load(path)
  const grant = file.grants.find((g) => g.intent === intent && g.repo === cwd && g.branch === branch && g.expiresAt > now && !isSpent(g))
  return grant ? { file, path, grant } : undefined
}

/** Every live (unexpired, not yet spent) grant for this project + branch — for `elia control preauth list`. */
export function listLivePreauth(cwd = process.cwd(), branch = 'unknown', now = Date.now()): PreauthGrant[] {
  const file = load(preauthPath())
  return file.grants.filter((g) => g.repo === cwd && g.branch === branch && g.expiresAt > now && !isSpent(g))
}

/**
 * Removes every live grant for this intent + project + branch immediately,
 * regardless of remaining time or uses. Returns how many were revoked. The
 * one way to take back a grant before it expires or is spent on its own.
 */
export function revokePreauth(intent: string, cwd = process.cwd(), branch = 'unknown'): number {
  const path = preauthPath()
  const file = load(path)
  const now = Date.now()
  const remaining = file.grants.filter((g) => !(g.intent === intent && g.repo === cwd && g.branch === branch && g.expiresAt > now))
  const revokedCount = file.grants.length - remaining.length
  if (revokedCount > 0) save(path, { grants: remaining })
  return revokedCount
}

/** True when a live, unexpired grant covers this exact intent + project + branch. */
export function isPreauthorized(intent: string, cwd = process.cwd(), branch = 'unknown', now = Date.now()): boolean {
  return findLive(intent, cwd, branch, now) !== undefined
}

/**
 * Marks one use of a live grant (bumps usedCount/lastUsedAt, persisted) and
 * returns it — call only after {@link isPreauthorized} confirmed one exists,
 * to fold its provenance into the assessment reason the audit ledger records.
 * A no-op (returns undefined) if the grant has since expired or was never there.
 */
export function consumePreauth(intent: string, cwd = process.cwd(), branch = 'unknown', now = Date.now()): PreauthGrant | undefined {
  const found = findLive(intent, cwd, branch, now)
  if (!found) return undefined
  const used: PreauthGrant = { ...found.grant, usedCount: found.grant.usedCount + 1, lastUsedAt: now }
  const next: PreauthFile = { grants: found.file.grants.map((g) => (g === found.grant ? used : g)) }
  save(found.path, next)
  return used
}
