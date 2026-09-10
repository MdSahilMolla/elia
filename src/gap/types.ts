import type { VerificationRegime } from '../autonomy/detectChecks.ts'

/**
 * The generator–verifier gap, made observable.
 *
 * You cannot measure the gap directly — if you could tell the generator had
 * outrun the verifier, the verifier would already be ahead. What you *can*
 * measure are proxies: how often the verification ladder waves a known-bad
 * change through, how often it flags a known-good one, and how that tracks
 * against the run-completion contradictions already being logged. A regression
 * in any of these is the signal that self-improvement has started compounding
 * in the wrong direction.
 */

/** Which rung of the ladder a defect is expected to die on. */
export type LadderRung = 'structural' | 'typecheck' | 'test' | 'hygiene' | 'critic'

export interface PlantedDefect {
  id: string
  /** The verification regime this defect lives in — a `judgment` defect is, by design, one the cheap ladder cannot catch. */
  regime: VerificationRegime
  /** One line: what is wrong. */
  summary: string
  /** The rung that *should* catch this. `critic` means only an adversarial model reviewer would. */
  expectedCatch: LadderRung
  /** Files of the clean control, keyed by repo-relative path. */
  clean: Record<string, string>
  /** The same files with the defect introduced. Must have the same keys as `clean`. */
  defective: Record<string, string>
  /**
   * A test file (repo-relative path → contents) that passes on `clean` and
   * fails on `defective`. Present for `test`-rung defects; run with `bun test`.
   */
  test?: Record<string, string>
  /** How many times a failure of this shape actually shows up in this project's history. 0 = seeded, not observed. */
  observedInHistory?: number
}

/** What the deterministic ladder did with one defect. */
export interface LadderResult {
  defectId: string
  regime: VerificationRegime
  expectedCatch: LadderRung
  /** Rungs that fired on the defective variant. */
  caughtBy: LadderRung[]
  /** True when at least one rung fired — the defect did not get through. */
  caught: boolean
  /** True when a rung fired on the *clean* control — a false positive. */
  falsePositiveOnClean: boolean
  /** Rungs that could not run (no checker, spawn failed) — excluded from scoring, surfaced for honesty. */
  skipped: LadderRung[]
  notes: string[]
}

export interface GapVector {
  at: string
  /** git HEAD short sha the scoreboard ran against, or 'working-tree'. */
  ref: string
  defectsTotal: number
  defectsScored: number
  /** caught / scored — higher is a stronger verifier. The primary number. */
  mechanicalCatchRate: number
  /** clean controls that tripped a rung / total controls — lower is better. */
  falsePositiveRate: number
  byRegime: Record<VerificationRegime, { total: number; caught: number }>
  byRung: Partial<Record<LadderRung, { expected: number; caught: number }>>
  /** From the existing completion-calibration log: verdicts that contradicted the facts. */
  calibrationContradictionRate: number
  /** Present only when the scoreboard was run with an adversarial-model pass. */
  criticFalseAcceptRate?: number
  /** Ids of defects that got all the way through the ladder. */
  escapees: string[]
}
