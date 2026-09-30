import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { withFileLock } from '../fileLock.ts'
import { writeSecureFile } from '../securePersistence.ts'
import { noteCorruptState } from '../localJson.ts'
import { preauthDir, userPreauthSecret } from './preauth.ts'

/**
 * A per-user record of which repo-resident files this person has reviewed and
 * accepted: `.elia/skills`, `.elia/mcp.json`, `.elia/allow.json`,
 * `.elia/schedules.json`, `.elia/autopilot/state.json`.
 *
 * A repository controls every byte inside its own tree, so a checked-in "this
 * project is trusted" flag proves nothing — `git clone` + `elia` must never be
 * enough to run someone else's code or inherit their standing approvals. The
 * decision therefore lives outside the repo, in the same per-user home as the
 * preauth grants (`~/.config/elia`, or `ELIA_PREAUTH_DIR` under test), and is
 * bound to what was reviewed: each entry is the canonical (realpath) path plus
 * the SHA-256 of that file's bytes (or, for a directory, of its matching
 * files). Edit the file — a `git pull` that changes it, a hostile commit — and
 * the hash no longer matches, so the trust lapses until the person says yes
 * again. The whole record is HMAC-SHA256 signed with the per-user secret that
 * also signs preauth grants and the global allow store, so a hand-written or
 * repo-shipped copy verifies as nothing.
 *
 * Files elia writes itself (an "always allow" rule, a schedule, pilot state)
 * record the hash of what they are about to write, so the normal flow of the
 * person's own commands keeps working without a second prompt.
 */

export const PROJECT_TRUST_FILE = 'project-trust.json'

/** Repo-relative things `elia trust` covers, and the file suffix (if any) that selects a directory's members. */
export const PROJECT_TRUST_TARGETS: readonly { path: string; suffix?: string; label: string }[] = [
  { path: join('.elia', 'skills'), suffix: '.skill.ts', label: 'project skills (.elia/skills)' },
  { path: join('.elia', 'mcp.json'), label: 'project MCP servers (.elia/mcp.json)' },
  { path: join('.elia', 'allow.json'), label: 'standing approvals (.elia/allow.json)' },
  { path: join('.elia', 'schedules.json'), label: 'schedules (.elia/schedules.json)' },
  { path: join('.elia', 'autopilot', 'state.json'), label: 'autopilot state (.elia/autopilot/state.json)' },
]

interface TrustEntry {
  path: string
  sha256: string
}

interface TrustFile {
  entries: TrustEntry[]
  /** HMAC-SHA256 over `entries` with the per-user secret. */
  mac?: string
}

export function projectTrustStorePath(): string {
  return join(preauthDir(), PROJECT_TRUST_FILE)
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Realpath of the target, falling back to a realpath'd parent + basename for a file that does not exist yet. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
}

/** SHA-256 of a file's bytes, or of a directory's `suffix`-matching files (name + content, sorted). Undefined when there is nothing to hash. */
export function fingerprintPath(path: string, suffix?: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    if (!statSync(path).isDirectory()) return sha256Hex(readFileSync(path))
    const names = readdirSync(path).filter((name) => !suffix || name.endsWith(suffix)).sort()
    if (names.length === 0) return undefined
    const parts = names.map((name) => `${name}\0${sha256Hex(readFileSync(join(path, name)))}\n`)
    return sha256Hex(parts.join(''))
  } catch {
    return undefined
  }
}

function signEntries(entries: TrustEntry[]): string {
  return createHmac('sha256', userPreauthSecret()).update(JSON.stringify(entries)).digest('hex')
}

function readStore(): TrustEntry[] {
  const path = projectTrustStorePath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrustFile>
    if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.mac !== 'string') throw new Error('not a project-trust file')
    const entries = parsed.entries.filter((entry): entry is TrustEntry => Boolean(entry) && typeof entry.path === 'string' && typeof entry.sha256 === 'string')
    const expected = signEntries(entries)
    if (entries.length !== parsed.entries.length || !timingSafeEqual(Buffer.from(parsed.mac, 'hex'), Buffer.from(expected, 'hex'))) {
      throw new Error('project-trust file failed its HMAC verification')
    }
    return entries
  } catch (error) {
    // An unsigned, edited or malformed record trusts nothing.
    noteCorruptState('projectTrust.verify', path, error, { keepCopy: true })
    return []
  }
}

function writeStore(entries: TrustEntry[]): void {
  const file: TrustFile = { entries, mac: signEntries(entries) }
  writeSecureFile(projectTrustStorePath(), `${JSON.stringify(file, null, 2)}\n`)
}

/** True when the user has trusted exactly this content (`sha256`) at this path. */
export function isHashTrusted(path: string, sha256: string): boolean {
  const key = canonicalPath(path)
  return readStore().some((entry) => entry.path === key && entry.sha256 === sha256)
}

/** True when the path's current content is covered by the user-level trust record. A missing path is never trusted. */
export function isPathTrusted(path: string, suffix?: string): boolean {
  const hash = fingerprintPath(path, suffix)
  return hash !== undefined && isHashTrusted(path, hash)
}

/** Records trust for a specific content hash — for files elia is about to write itself. */
export function trustHash(path: string, sha256: string): void {
  const key = canonicalPath(path)
  const lock = `${projectTrustStorePath()}.lock`
  withFileLock(lock, () => {
    const rest = readStore().filter((entry) => entry.path !== key)
    writeStore([...rest, { path: key, sha256 }].slice(-500))
  }, { ttlMs: 10_000, timeoutMs: 3_000 })
}

/** Records trust for the path's current content. Returns false when there is nothing there to trust. */
export function trustPath(path: string, suffix?: string): boolean {
  const hash = fingerprintPath(path, suffix)
  if (hash === undefined) return false
  trustHash(path, hash)
  return true
}

/** Drops any trust recorded for this path. */
export function untrustPath(path: string): void {
  const key = canonicalPath(path)
  const lock = `${projectTrustStorePath()}.lock`
  withFileLock(lock, () => {
    const entries = readStore()
    const rest = entries.filter((entry) => entry.path !== key)
    if (rest.length !== entries.length) writeStore(rest)
  }, { ttlMs: 10_000, timeoutMs: 3_000 })
}

/** One line telling the person how to trust what was skipped. */
export const TRUST_HINT = 'inspect it, then run `elia trust` in this project to allow it'

export interface ProjectTrustStatus {
  path: string
  label: string
  present: boolean
  trusted: boolean
}

/** Every repo-resident target under `root`, with whether it exists and is trusted right now. */
export function projectTrustStatus(root: string): ProjectTrustStatus[] {
  return PROJECT_TRUST_TARGETS.map((target) => {
    const path = join(root, target.path)
    const present = fingerprintPath(path, target.suffix) !== undefined
    return { path, label: target.label, present, trusted: present && isPathTrusted(path, target.suffix) }
  })
}

const FOLDER_MARKER = sha256Hex('elia-folder-trust-v1')

/**
 * Folder-level consent: "yes, elia may run this project's own check commands
 * unattended". Not bound to file content (a repo's manifest changes daily); it
 * gates only the autopilot's *first* automatic start in a folder.
 */
export function isFolderTrusted(root: string): boolean {
  return isHashTrusted(root, FOLDER_MARKER)
}

export function trustFolder(root: string): void {
  trustHash(root, FOLDER_MARKER)
}

/** Trusts everything present under `root`. Returns the labels that were trusted. */
export function trustProject(root: string): string[] {
  trustFolder(root)
  const trusted: string[] = ['folder (autopilot may start on its own and run project checks)']
  for (const target of PROJECT_TRUST_TARGETS) {
    if (trustPath(join(root, target.path), target.suffix)) trusted.push(target.label)
  }
  return trusted
}

/** Revokes trust for everything under `root`. */
export function untrustProject(root: string): void {
  untrustPath(root)
  for (const target of PROJECT_TRUST_TARGETS) untrustPath(join(root, target.path))
}
