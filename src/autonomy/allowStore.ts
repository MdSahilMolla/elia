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
  /** For `run_command`: the leading command token this rule covers. */
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
  return scope === 'project' ? join(cwd, '.elia', 'allow.json') : join(homedir(), '.elia', 'allow.json')
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

/** The leading token of a shell command — `git push --force` → `git`. */
export function commandPrefix(command: string): string {
  const trimmed = command.trim().replace(/^[(!{]\s*/, '')
  const first = trimmed.split(/[\s;|&]+/, 1)[0] ?? ''
  // Keep a path-qualified binary readable: ./gradlew → gradlew, C:\x\node.exe → node.exe
  return first.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? first
}

function matches(rule: AllowRule, request: ActionRequest, assessment: ActionAssessment): boolean {
  if (rule.tool !== request.name) return false
  if (request.name === 'run_command') {
    const cmd = typeof request.input.command === 'string' ? request.input.command : ''
    return Boolean(rule.commandPrefix) && commandPrefix(cmd) === rule.commandPrefix
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
  if (request.name === 'run_command') {
    const cmd = typeof request.input.command === 'string' ? request.input.command : ''
    return { ...base, commandPrefix: commandPrefix(cmd) }
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
