import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionAssessment, ActionRequest, ActionRisk } from './governor.ts'

/**
 * A checked-in, deterministic policy that tightens the autonomy governor before
 * the model ever runs.
 *
 * The governor's built-in assessment is a fixed judgement about each tool. A
 * policy file is how a team says "in *this* repo, additionally, never do X" —
 * enforced by code at the tool boundary, not by asking the model nicely in a
 * prompt it can rationalise its way around. It can only ever make the governor
 * stricter: deny a tool outright, deny a shell command by pattern, or lower the
 * risk bar at which an action stops being auto-allowed in unattended mode. It
 * cannot loosen anything.
 *
 * Lives at `.elia/policy.json` in the project root so it is versioned and
 * reviewed like any other code.
 */
export interface EliaPolicy {
  /** Tool names that are always blocked, e.g. "codex_delegate", "communication". */
  denyTools: string[]
  /**
   * Governor intents that are always blocked, e.g. "github.push", "browser.click".
   * These are the `intent` field of an assessment — a tool.action pair — so a
   * policy can forbid `github.push` while leaving `github.commit` alone.
   */
  denyIntents: string[]
  /** Regular expressions (matched case-insensitively) that block a `run_command` when any matches its command string. */
  denyCommandPatterns: string[]
  /**
   * Any action assessed at this risk or higher stops being auto-allowed in
   * unattended mode and requires an explicit approval. "review" makes unattended
   * runs pause on every dependency install, push, or artifact write; "critical"
   * is the governor's own default.
   */
  requireApprovalAtOrAbove: ActionRisk
}

const RISK_ORDER: Record<ActionRisk, number> = { safe: 0, review: 1, critical: 2 }
const MAX_LIST = 200
const MAX_PATTERN_LENGTH = 500

export function policyPath(cwd = process.cwd()): string {
  return join(cwd, '.elia', 'policy.json')
}

interface CachedPolicy {
  mtimeMs: number
  policy: EliaPolicy | null
}
const cache = new Map<string, CachedPolicy>()

/**
 * Reads and validates `.elia/policy.json`. Returns null when the file is absent
 * (the common case — no policy means the governor's built-in behaviour is
 * unchanged). Throws on a malformed file rather than silently ignoring it: a
 * policy that does not load is a policy that is not protecting anything, and the
 * operator needs to know.
 */
export function loadPolicy(cwd = process.cwd()): EliaPolicy | null {
  const path = policyPath(cwd)
  if (!existsSync(path)) {
    cache.delete(path)
    return null
  }
  const mtimeMs = statSync(path).mtimeMs
  const cached = cache.get(path)
  if (cached && cached.mtimeMs === mtimeMs) return cached.policy

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid ${path}: expected JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const policy = validate(parsed, path)
  cache.set(path, { mtimeMs, policy })
  return policy
}

function validate(value: unknown, path: string): EliaPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected a JSON object`)
  }
  const raw = value as Record<string, unknown>

  const stringList = (field: string): string[] => {
    const list = raw[field] ?? []
    if (!Array.isArray(list) || list.length > MAX_LIST || list.some((item) => typeof item !== 'string' || item.length === 0 || item.length > MAX_PATTERN_LENGTH)) {
      throw new Error(`Invalid ${path}: "${field}" must be an array of non-empty strings`)
    }
    return [...new Set(list as string[])]
  }

  const denyCommandPatterns = stringList('denyCommandPatterns')
  for (const pattern of denyCommandPatterns) {
    try {
      new RegExp(pattern, 'i')
    } catch (error) {
      throw new Error(`Invalid ${path}: "${pattern}" in denyCommandPatterns is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const risk = raw.requireApprovalAtOrAbove ?? 'critical'
  if (risk !== 'safe' && risk !== 'review' && risk !== 'critical') {
    throw new Error(`Invalid ${path}: "requireApprovalAtOrAbove" must be "safe", "review", or "critical"`)
  }

  return {
    denyTools: stringList('denyTools'),
    denyIntents: stringList('denyIntents'),
    denyCommandPatterns,
    requireApprovalAtOrAbove: risk,
  }
}

export interface PolicyOutcome {
  assessment: ActionAssessment
  /** Set when the policy forbids the action outright, regardless of governance mode or an approval channel. */
  blocked: boolean
  message?: string
}

/**
 * Applies a loaded policy to a governor assessment. With no policy the
 * assessment passes through untouched. A policy can only tighten: block the
 * action, or raise its decision from "allow" to "approve".
 */
export function applyPolicy(assessment: ActionAssessment, request: ActionRequest, cwd = process.cwd(), policy = loadPolicy(cwd)): PolicyOutcome {
  if (!policy) return { assessment, blocked: false }

  if (policy.denyTools.includes(request.name)) {
    return { assessment: { ...assessment, decision: 'block' }, blocked: true, message: `Blocked by .elia/policy.json: tool "${request.name}" is on the deny list.` }
  }
  if (policy.denyIntents.includes(assessment.intent)) {
    return { assessment: { ...assessment, decision: 'block' }, blocked: true, message: `Blocked by .elia/policy.json: "${assessment.intent}" is on the deny list.` }
  }
  if (request.name === 'run_command') {
    const command = typeof request.input.command === 'string' ? request.input.command : ''
    const hit = policy.denyCommandPatterns.find((pattern) => new RegExp(pattern, 'i').test(command))
    if (hit) {
      return { assessment: { ...assessment, decision: 'block' }, blocked: true, message: `Blocked by .elia/policy.json: command matches forbidden pattern /${hit}/i.` }
    }
  }

  if (assessment.decision === 'allow' && RISK_ORDER[assessment.risk] >= RISK_ORDER[policy.requireApprovalAtOrAbove]) {
    return {
      assessment: { ...assessment, decision: 'approve', reason: `${assessment.reason} (.elia/policy.json requires approval at or above "${policy.requireApprovalAtOrAbove}" risk)` },
      blocked: false,
    }
  }

  return { assessment, blocked: false }
}
