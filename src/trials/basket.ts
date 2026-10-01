import { createHash } from 'node:crypto'

/**
 * The outcome basket: what the world does to a change after it lands.
 *
 * elia's gate certifies a change against a benchmark someone on this side of the
 * loop wrote. Every such verifier can, in principle, be satisfied without the
 * change being any good, and the self-improvement literature keeps finding that
 * it is (a proxy gain with no real gain is the common case, not the rare one).
 * What cannot be satisfied that way is an outcome that does not exist yet when
 * the change is made: whether the code is still standing two weeks later, whether
 * someone reverted it, whether someone had to fix the same files.
 *
 * This file fixes that list *before* any analysis, and hashes it. A result that
 * names the digest says "these were the outcomes, chosen in advance" — the same
 * thing a pre-registered trial says, and for the same reason: an outcome picked
 * after looking is an outcome picked to win.
 *
 * Outcomes are measured from git alone. That is deliberate. Git is the one record
 * of what happened to a change that neither the agent nor this repository's
 * tooling writes after the fact.
 */

export const DEFAULT_HORIZON_DAYS = 14

/** Paths whose lines say nothing about a change's quality: generated, vendored or binary. */
export const EXCLUDED_PATHS: readonly string[] = [
  '(^|/)(bun\\.lockb?|package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock)$',
  '(^|/)(dist|node_modules|target|vendor)/',
  '\\.(png|jpe?g|gif|svg|ico|pdf|woff2?|ttf|mp4|mov|zip|gz|min\\.js|map)$',
]

/** A commit whose every counted file matches this is documentation, not code. */
export const DOC_PATHS = '(\\.(md|mdx|txt|rst)$|(^|/)docs/)'

/** A subject that says the commit repairs something. Conventional-commit prefixes, nothing cleverer. */
export const FIX_SUBJECT = '^(fix|hotfix|bugfix|revert)(\\(|:|!|\\s)'

export interface SignalCriteria {
  minMeasurable: number
  minSurvivalSpread: number
  maxSaturatedShare: number
  eventRateBand: readonly [number, number]
  minInvariantShare: number
  invariantSlackLines: number
}

/**
 * When the basket is good enough to build a trial on.
 *
 * A signal that never varies cannot tell a good change from a bad one, and one
 * that disagrees with itself is measuring several things. These are the checks
 * that catch both, stated as numbers so a "usable" verdict can be argued with.
 */
export const SIGNAL_CRITERIA: SignalCriteria = {
  /** Commits with a defined line-survival value before any spread is worth judging. */
  minMeasurable: 100,
  /** Standard deviation of line survival; below this nearly every change looks the same. */
  minSurvivalSpread: 0.15,
  /** A share of commits keeping ≥95% of their lines above this means the metric is saturated. */
  maxSaturatedShare: 0.9,
  /** A binary outcome outside this band happens too rarely, or too often, to compare. */
  eventRateBand: [0.05, 0.95],
  /**
   * Lines a fix removed can never outnumber the lines that died. This share of the
   * commits a fix touched must satisfy that (within `invariantSlackLines`), or the
   * survival and fix measurements are not describing the same lines.
   */
  minInvariantShare: 0.95,
  invariantSlackLines: 2,
}

export interface BasketDefinition {
  /**
   * This definition was revised twice after seeing elia's own history, both times
   * because the instrument failed its own validity check, never because of what it
   * said about the agent. The digest moved each time, so it cannot be done quietly.
   *
   *   v1  "fixed after" = a later fix touched one of the commit's files. Flagged 83% of
   *       commits (a repo landing ~20 a day always has a fix nearby) and the coherence
   *       check failed.
   *   v2  SZZ line-level, coherence as a yes/no association between "a fix rewrote it"
   *       and lower survival. Flagged 50% and still failed (p=0.375): large commits
   *       attract small fixes and mostly die through refactors no fix touches, so the
   *       association is confounded by size. The check was badly specified.
   *   v3  Counts the lines fixes removed, and checks the exact invariant that they are
   *       a subset of the lines that died. It also reports what share of all deaths
   *       were fix-driven, which is what says whether survival is a defect signal.
   */
  version: number
  horizonDays: number
  outcomes: Record<string, string>
  excludedPaths: readonly string[]
  docPaths: string
  fixSubject: string
  criteria: SignalCriteria
}

export function basketDefinition(horizonDays = DEFAULT_HORIZON_DAYS): BasketDefinition {
  return {
    version: 3,
    horizonDays,
    outcomes: {
      lineSurvival:
        'Of the lines a commit added to counted files, the share still attributed to it (git blame -w) at the last mainline commit within the horizon of the commit reaching the ref.',
      reverted: 'A later commit says "This reverts commit <sha>" for it within the horizon.',
      fixedAfter:
        'A later fix/hotfix/bugfix/revert commit, between its authoring and the horizon, removed or rewrote a line this commit last touched (SZZ: git blame -w of the fix\'s removed lines at its parent). Line-level, but still a heuristic: a fix commit is one whose subject says so.',
    },
    excludedPaths: EXCLUDED_PATHS,
    docPaths: DOC_PATHS,
    fixSubject: FIX_SUBJECT,
    criteria: SIGNAL_CRITERIA,
  }
}

/** Key-sorted JSON, so the digest does not depend on the order fields were written in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function basketDigest(definition: BasketDefinition = basketDefinition()): string {
  return `sha256:${createHash('sha256').update(canonicalJson(definition)).digest('hex')}`
}
