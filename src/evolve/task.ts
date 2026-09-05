/**
 * The contract every benchmark task satisfies, whichever suite it came from.
 *
 * Lives apart from `suite.ts` so the synthetic tasks and the history-derived
 * ones in `history/` can both depend on it without depending on each other.
 */

export interface BenchCheck {
  passed: boolean
  detail: string
}

export interface BenchTask {
  id: string
  /** Relative importance in the weighted pass rate. */
  weight: number
  /** What elia is asked to do, verbatim. */
  prompt: string
  /**
   * Model round-trips this task is allowed before the loop is told to stop.
   *
   * The synthetic tasks are single-file and finish in single digits, so the
   * harness default is tuned for them. A task in a real repository spends most
   * of its budget just orienting — reading the failing test, finding the code it
   * describes, running the suite — and a budget set for a fixture repo measures
   * the budget rather than the agent.
   */
  maxSteps?: number
  /** Builds the starting repository in `dir`. */
  setup(dir: string): Promise<void>
  /** Decides pass/fail by inspecting `dir` afterwards. Must never call a model. */
  check(dir: string): Promise<BenchCheck>
}
