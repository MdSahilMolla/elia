/**
 * Scoped, time-limited pre-authorization grants — the one deliberate way
 * around governor.ts's blanket unattended refusal for browser/comms/
 * production-deploy/PR-merge/force-push/codex_delegate actions.
 *
 * `policy.ts` can only ever tighten the governor; it says so in its own
 * doc comment, and that invariant is worth keeping simple and absolute. This
 * is the narrow, explicit exception to it, kept in its own file so that
 * invariant stays true of policy.ts specifically. A grant only ever loosens
 * governance for:
 *   - an intent the human named explicitly (never "everything critical")
 *   - the exact project directory + git branch it was granted for
 *   - a bounded time window
 * and every use is folded into the assessment reason that the normal action
 * audit ledger (audit.ts, via appendActionAudit) already records — so a
 * grant-authorized action is never invisible in the run's own audit trail.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
}

interface PreauthFile {
  grants: PreauthGrant[]
}

const MAX_GRANTS = 50
const INTENT_PATTERN = /^[a-z][a-z0-9_.]{1,80}$/
/** Generous enough to cover a long unattended run; short enough that a forgotten grant doesn't linger across sessions. */
export const DEFAULT_PREAUTH_TTL_MS = 4 * 60 * 60_000

export function preauthPath(cwd = process.cwd()): string {
  return join(cwd, '.elia', 'preauth.json')
}

interface Cached {
  mtimeMs: number
  file: PreauthFile
}
const cache = new Map<string, Cached>()
const EMPTY: PreauthFile = { grants: [] }

function load(path: string): PreauthFile {
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
          .filter((g): g is PreauthGrant => Boolean(g) && typeof g.intent === 'string' && typeof g.repo === 'string' && typeof g.branch === 'string' && typeof g.expiresAt === 'number')
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
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
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
}

/**
 * Records one grant per requested intent, scoped to this project directory
 * and the branch given (resolve it once via {@link currentBranch} at the call
 * site — a human granting `--authorize` from a terminal at run start). Returns
 * the grants actually written (invalid intents are dropped, not thrown).
 */
export function grantPreauth(intents: string[], cwd: string, branch: string, ttlMs = DEFAULT_PREAUTH_TTL_MS): PreauthGrant[] {
  const path = preauthPath(cwd)
  const file = load(path)
  const now = Date.now()
  const granted: PreauthGrant[] = []
  for (const intent of intents) {
    if (!INTENT_PATTERN.test(intent)) continue
    granted.push({ intent, repo: cwd, branch, grantedAt: now, expiresAt: now + ttlMs, usedCount: 0 })
  }
  if (granted.length === 0) return []
  const next: PreauthFile = { grants: [...file.grants.filter((g) => g.expiresAt > now), ...granted].slice(-MAX_GRANTS) }
  save(path, next)
  return granted
}

function findLive(intent: string, cwd: string, branch: string, now: number): { file: PreauthFile; path: string; grant: PreauthGrant } | undefined {
  const path = preauthPath(cwd)
  const file = load(path)
  const grant = file.grants.find((g) => g.intent === intent && g.repo === cwd && g.branch === branch && g.expiresAt > now)
  return grant ? { file, path, grant } : undefined
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
