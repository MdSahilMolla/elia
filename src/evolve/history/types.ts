/**
 * A benchmark task derived from one real commit in elia's own history.
 *
 * The synthetic suite in ../suite.ts measures competencies in fixture repos that
 * fit in a single file. These measure the thing elia is actually sold on: take a
 * real repository at a real point in its history, hand over the tests that
 * describe work that had not been done yet, and see whether the agent can make
 * them pass. Construction follows SWE-bench's: the tests are the specification,
 * they must fail before the change and pass after it, and nothing in the scoring
 * path is a model.
 */
export interface HistoryTaskSpec {
  /** `hist-<short sha>`; stable across harvests of the same commit. */
  id: string
  /** The commit whose work is being asked for. */
  sha: string
  /** The tree the agent starts from — the commit's first parent. */
  parent: string
  /** The commit subject, used as the ticket title. */
  subject: string
  /**
   * Test files taken from `sha` and laid over the parent tree. These are the
   * specification, and the agent must not edit them — `check` verifies their
   * contents are byte-identical afterwards.
   */
  testFiles: string[]
  /** Source files the commit changed. Recorded for reporting, not enforced. */
  sourceFiles: string[]
  /** The command whose exit code decides pass or fail. */
  verifyCommand: string
  /**
   * Proof the task is real, recorded at harvest time: the tests failed on the
   * parent tree and passed once the commit's own source landed. A task that
   * cannot show both is not a task, and is never written out.
   */
  evidence: {
    failingBefore: number
    passingAfter: number
  }
  /** Relative importance in the weighted pass rate. */
  weight: number
}
