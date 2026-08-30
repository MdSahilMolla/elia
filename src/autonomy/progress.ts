import type { CriticVerdict } from './types.ts'
import type { VerificationOutcome } from './verify.ts'

/**
 * A deterministic "are we actually getting somewhere?" signal for the
 * verify → repair loop.
 *
 * The loop's failure mode is thrashing: repair attempt 2 reproduces exactly the
 * failure of attempt 1, attempt 3 the same, and the run only stops when the
 * attempt counter runs out — having spent the whole budget going nowhere and
 * then reporting a vague failure. This turns each attempt's failures into stable
 * fingerprints and compares consecutive attempts, so the loop can stop early
 * with a precise "attempts N and N-1 both failed X the same way — this needs a
 * human" instead of burning the budget first.
 *
 * No model is involved: fingerprints come from exit output and review verdicts,
 * comparison is set arithmetic.
 */

export interface AttemptSnapshot {
  /** 0 for the initial verification, 1+ for each post-repair re-verification. */
  attempt: number
  /** Stable fingerprints of everything still failing after this attempt. Empty means it passed. */
  failures: string[]
}

export type ProgressTrend = 'first-attempt' | 'resolved' | 'converging' | 'stalled' | 'diverging'

export interface ProgressAssessment {
  trend: ProgressTrend
  /** `stop` means further repair attempts are very unlikely to help — hand off now. */
  recommendation: 'continue' | 'stop'
  reason: string
  /** Fingerprints that survived from the previous attempt to this one — repair did not touch them. */
  repeated: string[]
}

const HEX = /\b[0-9a-f]{7,}\b/gi
const NUMS = /\b\d[\d.,]*\b/g
const WS = /\s+/g
// Absolute-ish paths and drive letters, so the same error from two machines fingerprints identically.
const PATHS = /(?:[a-z]:)?(?:[\\/][\w.@ -]+)+[\\/]?/gi

/** The most salient, machine-stable line of a failing command's output. */
export function errorSignature(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return 'no-output'

  const salient =
    lines.find((line) => /error\s+TS\d{2,}/i.test(line)) ??
    lines.find((line) => /^(?:error|fail(?:ed)?|assertion|assertionerror|typeerror|referenceerror|syntaxerror|panic|traceback)\b/i.test(line)) ??
    lines.find((line) => /\b(?:expected|received|to (?:be|equal|contain)|assert)\b/i.test(line)) ??
    lines.find((line) => /\b\d+ (?:failing|failed|errors?)\b/i.test(line)) ??
    lines[0]!

  return salient
    .toLowerCase()
    .replace(PATHS, '<path>')
    .replace(HEX, '<hex>')
    .replace(NUMS, '<n>')
    .replace(WS, ' ')
    .trim()
    .slice(0, 140)
}

/** The set of stable failure fingerprints for one verify+review pass. */
export function failureFingerprints(verification: VerificationOutcome, verdict?: CriticVerdict): string[] {
  const out = new Set<string>()

  if (!verification.passed) {
    for (const result of verification.results) {
      if (result.exitCode === 0 && !result.timedOut) continue
      if (result.timedOut) {
        out.add(`verify:${result.command}::timeout`)
      } else {
        out.add(`verify:${result.command}::${errorSignature(`${result.stdout}\n${result.stderr}`)}`)
      }
    }
  }

  if (verdict && verdict.verdict === 'revise') {
    for (const issue of verdict.issues) {
      if (issue.severity === 'minor') continue
      const detail = issue.detail
        .toLowerCase()
        .replace(PATHS, '<path>')
        .replace(NUMS, '<n>')
        .replace(WS, ' ')
        .trim()
        .slice(0, 140)
      out.add(`review:${issue.severity}:${issue.file ?? ''}:${detail}`)
    }
  }

  return [...out].sort()
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bs = new Set(b)
  return a.every((x) => bs.has(x))
}

/**
 * Looks at the trajectory of failures across repair attempts and says whether
 * another attempt is worth making. Only ever recommends stopping once at least
 * one real repair attempt has been made and re-verified (history length >= 2).
 */
export function assessProgress(history: AttemptSnapshot[]): ProgressAssessment {
  if (history.length === 0) return { trend: 'first-attempt', recommendation: 'continue', reason: 'no attempts yet', repeated: [] }

  const latest = history[history.length - 1]!
  if (latest.failures.length === 0) {
    return { trend: 'resolved', recommendation: 'stop', reason: 'the latest verification and review passed', repeated: [] }
  }
  if (history.length === 1) {
    return { trend: 'first-attempt', recommendation: 'continue', reason: 'first verification failed; one repair attempt not yet made', repeated: [] }
  }

  const previous = history[history.length - 2]!
  const prevSet = new Set(previous.failures)
  const repeated = latest.failures.filter((f) => prevSet.has(f))
  const isNew = latest.failures.filter((f) => !prevSet.has(f))

  // Every failure from last time is still here, unchanged, and nothing new — the
  // repair pass did not move the needle at all.
  if (sameSet(latest.failures, previous.failures)) {
    return {
      trend: 'stalled',
      recommendation: 'stop',
      reason: `repair attempt ${latest.attempt} reproduced exactly the same ${latest.failures.length} failure(s) as attempt ${previous.attempt}: ${short(repeated)}. Further attempts along this line are very unlikely to help.`,
      repeated,
    }
  }

  // More failures than before, or the same count with fresh failures introduced
  // — the repair is breaking as much as it fixes.
  if (latest.failures.length > previous.failures.length || (isNew.length > 0 && latest.failures.length >= previous.failures.length)) {
    return {
      trend: 'diverging',
      recommendation: 'stop',
      reason: `repair attempt ${latest.attempt} left ${latest.failures.length} failure(s), up from ${previous.failures.length}${isNew.length > 0 ? `, and introduced new ones: ${short(isNew)}` : ''}. The change is regressing, not converging.`,
      repeated,
    }
  }

  // Three-plus attempts and a hard core of the same failures has survived every
  // one of them.
  if (history.length >= 3) {
    const survivedAll = history.every((h) => h === latest || latest.failures.some((f) => h.failures.includes(f)))
    const persistent = latest.failures.filter((f) => history.slice(0, -1).every((h) => h.failures.includes(f)))
    if (survivedAll && persistent.length > 0) {
      return {
        trend: 'stalled',
        recommendation: 'stop',
        reason: `${persistent.length} failure(s) have survived every one of the ${history.length - 1} repair attempts: ${short(persistent)}.`,
        repeated: persistent,
      }
    }
  }

  return {
    trend: 'converging',
    recommendation: 'continue',
    reason: `failures dropped from ${previous.failures.length} to ${latest.failures.length}; another attempt is warranted`,
    repeated,
  }
}

function short(fingerprints: string[]): string {
  return fingerprints.slice(0, 3).map((f) => f.replace(/^(verify|review):/, '')).join(' | ') + (fingerprints.length > 3 ? ` (+${fingerprints.length - 3} more)` : '')
}
