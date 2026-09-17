import type { TurnOutcome } from '../autonomy/outcomes.ts'

/**
 * How much of elia's work gets checked at all.
 *
 * This is the number the verification work is aimed at, and it exists so that
 * the aim can be audited rather than asserted. The measurement that motivated
 * that work — 33 of 89 file-changing turns with nothing having looked at them —
 * came from reading `outcomes.jsonl` by hand in a session; a number arrived at
 * that way is a number nobody will recompute, and a gate whose effect is never
 * recomputed is how this codebase ended up with self-improvement gates that were
 * all vacuous and 76 lessons that helped nothing.
 *
 * So it lives here, reads the same records elia writes anyway, and prints in
 * `elia compounding` beside the rest. Two windows, because one number cannot
 * show a change: a gate shipped today moves the recent window while the lifetime
 * window barely stirs, and if the recent window does not move then the gate did
 * not work and should be said so.
 *
 * Only turns that changed files count. A question elia answered without touching
 * anything has nothing to verify, and including those would dilute the rate with
 * work that was never at risk — which would make the number look better for
 * exactly the wrong reason.
 */

export interface Coverage {
  /** Turns that changed files and were not aborted — the ones where verification means something. */
  turns: number
  /** A check that ran the behaviour passed. */
  verified: number
  /** A check ran and said no. Not a bad outcome for the record — it is the gate working. */
  failed: number
  /** Nothing checked it: no command, no render, nothing inferable. */
  unverified: number
  /** `unverified / turns`, 0 when there are no turns. */
  unverifiedRate: number
}

export const EMPTY_COVERAGE: Coverage = { turns: 0, verified: 0, failed: 0, unverified: 0, unverifiedRate: 0 }

/** Turns worth judging: they changed something, and they were allowed to finish. */
export function verifiableTurns(outcomes: TurnOutcome[]): TurnOutcome[] {
  return outcomes.filter((outcome) => outcome.filesChanged > 0 && !outcome.aborted && !outcome.failed)
}

export function coverageOf(outcomes: TurnOutcome[]): Coverage {
  const turns = verifiableTurns(outcomes)
  if (turns.length === 0) return EMPTY_COVERAGE
  const verified = turns.filter((turn) => turn.verify === 'pass').length
  const failed = turns.filter((turn) => turn.verify === 'fail').length
  const unverified = turns.filter((turn) => turn.verify === 'none' || turn.verify === 'skipped').length
  return { turns: turns.length, verified, failed, unverified, unverifiedRate: unverified / turns.length }
}

/** The most recent `count` verifiable turns, so a change shows up before the lifetime average catches on. */
export function recentCoverage(outcomes: TurnOutcome[], count = 30): Coverage {
  const recent = [...verifiableTurns(outcomes)].sort((a, b) => a.at - b.at).slice(-count)
  return coverageOf(recent)
}

function line(label: string, coverage: Coverage): string {
  if (coverage.turns === 0) return `  ${label}: no turns changed files yet`
  const percent = Math.round(coverage.unverifiedRate * 100)
  return `  ${label}: ${coverage.unverified}/${coverage.turns} unchecked (${percent}%) — ${coverage.verified} verified, ${coverage.failed} caught failing`
}

export function renderCoverage(all: Coverage, recent: Coverage): string {
  const lines = ['verification coverage — turns that changed files:', line('lifetime', all), line('last 30 ', recent)]
  if (recent.turns > 0 && all.turns > recent.turns) {
    const move = Math.round((all.unverifiedRate - recent.unverifiedRate) * 100)
    lines.push(
      move > 0
        ? `  recent window is ${move} points better than lifetime — the gates are catching more`
        : move < 0
          ? `  recent window is ${-move} points worse than lifetime — something regressed, or the work shifted to places nothing can check`
          : '  recent window matches lifetime — nothing has moved',
    )
  }
  return lines.join('\n')
}
