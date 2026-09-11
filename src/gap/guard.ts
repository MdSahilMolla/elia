import type { GapVector } from './types.ts'

/**
 * The Verifier-Leads invariant, as a callable gate.
 *
 * Any path that would train or rewrite a generator on the strength of "the
 * verifier said it was fine" — Loop 2 distillation, `elia evolve` promotion —
 * calls this first. If the verifier got measurably worse between `before` and
 * `after`, the change does not ship, however good it looked on the task
 * benchmark: a stronger generator behind a weaker verifier is how a
 * self-improving system starts compounding its own mistakes.
 */

export interface GapGuardResult {
  ok: boolean
  regressions: string[]
}

export interface GapGuardOptions {
  /** How much noise to tolerate before a drop counts as real. */
  epsilon?: number
}

export function checkGapNotRegressed(before: GapVector, after: GapVector, options: GapGuardOptions = {}): GapGuardResult {
  const eps = options.epsilon ?? 0.02
  const regressions: string[] = []

  if (after.mechanicalCatchRate < before.mechanicalCatchRate - eps) {
    regressions.push(
      `mechanical catch rate fell ${pct(before.mechanicalCatchRate)} → ${pct(after.mechanicalCatchRate)}`,
    )
  }

  if (after.falsePositiveRate > before.falsePositiveRate + eps) {
    regressions.push(`false-positive rate rose ${pct(before.falsePositiveRate)} → ${pct(after.falsePositiveRate)}`)
  }

  if (
    after.criticFalseAcceptRate !== undefined &&
    before.criticFalseAcceptRate !== undefined &&
    after.criticFalseAcceptRate > before.criticFalseAcceptRate + eps
  ) {
    regressions.push(
      `critic false-accept rate rose ${pct(before.criticFalseAcceptRate)} → ${pct(after.criticFalseAcceptRate)}`,
    )
  }

  // A newly-escaping defect that used to be caught is a hard regression even if
  // the rate math stays within epsilon.
  const newEscapees = after.escapees.filter((id) => !before.escapees.includes(id))
  if (newEscapees.length > 0) {
    regressions.push(`defect(s) now getting through the ladder: ${newEscapees.join(', ')}`)
  }

  if (after.calibrationContradictionRate > before.calibrationContradictionRate + Math.max(eps, 0.05)) {
    regressions.push(
      `completion-calibration contradiction rate rose ${pct(before.calibrationContradictionRate)} → ${pct(after.calibrationContradictionRate)}`,
    )
  }

  return { ok: regressions.length === 0, regressions }
}

/** Throwing form for a gate that must stop a promotion. */
export function assertGapNotRegressed(before: GapVector, after: GapVector, options: GapGuardOptions = {}): void {
  const result = checkGapNotRegressed(before, after, options)
  if (!result.ok) {
    throw new Error(
      `Generator–verifier gap regressed — change rejected:\n${result.regressions.map((r) => `  - ${r}`).join('\n')}`,
    )
  }
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}
