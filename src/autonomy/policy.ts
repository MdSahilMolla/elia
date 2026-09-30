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

// Deny-pattern checks run on every governed action; memoising the compiled
// regex avoids rebuilding one per check. Bounded so a session that swaps in
// hundreds of policies can't grow it without limit.
const compiledPatternCache = new Map<string, RegExp>()
function compiledPattern(pattern: string): RegExp {
  const cached = compiledPatternCache.get(pattern)
  if (cached) return cached
  const regex = new RegExp(pattern, 'i')
  if (compiledPatternCache.size < 200) compiledPatternCache.set(pattern, regex)
  return regex
}

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
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    // The file vanished between the existsSync above and the stat — treat it
    // as absent rather than letting the race surface as an uncaught throw on
    // every governed action.
    cache.delete(path)
    return null
  }
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
  // `process start` runs a shell command too, and `run_security_tool` is
  // nothing but one: a forbidden command must not get through just because it
  // was asked to keep running, or because it was routed through a tool whose
  // name the policy has never heard of. A deny list that only covers the two
  // shell tools is a hole the moment a third one exists.
  if (request.name === 'run_command' || request.name === 'run_security_tool' || request.name === 'run_program' || (request.name === 'process' && request.input.action === 'start')) {
    const command = request.name === 'run_program'
      ? [typeof request.input.program === 'string' ? request.input.program : '', ...(Array.isArray(request.input.args) ? request.input.args.filter((arg): arg is string => typeof arg === 'string') : [])].join(' ')
      : (typeof request.input.command === 'string' ? request.input.command : '')
    const hit = policy.denyCommandPatterns.find((pattern) => compiledPattern(pattern).test(command))
    if (hit) {
      return { assessment: { ...assessment, decision: 'block' }, blocked: true, message: `Blocked by .elia/policy.json: command matches forbidden pattern /${hit}/i.` }
    }
  }

  // The old guard only bumped `decision` from "allow" → "approve" when risk
  // met the threshold. That was a no-op for the governor's own "review"-band
  // actions, which already carry decision "approve" — line 635 of governor.ts
  // then auto-allowed them in unattended mode, completely ignoring the policy
  // setting.  Raising `risk` to "critical" is what makes the downstream gate
  // (unattended critical block or per-action approval) actually enforce the
  // threshold: review-risk actions are no longer eligible for the risk ===
  // review auto-allow, and safe-risk actions never hit the decision === allow
  // shortcut that bypasses the gate entirely.
  if (RISK_ORDER[assessment.risk] >= RISK_ORDER[policy.requireApprovalAtOrAbove] && policy.requireApprovalAtOrAbove !== 'critical') {
    return {
      assessment: {
        ...assessment,
        risk: 'critical',
        decision: 'approve',
        reason: `${assessment.reason} (.elia/policy.json requires approval at or above "${policy.requireApprovalAtOrAbove}" risk)`,
      },
      blocked: false,
    }
  }

  return { assessment, blocked: false }
}
