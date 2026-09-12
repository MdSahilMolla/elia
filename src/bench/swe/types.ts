/**
 * One task instance, shaped after the SWE-bench Verified schema (repo,
 * base_commit, problem_statement, test_patch, FAIL_TO_PASS, PASS_TO_PASS —
 * see https://www.swebench.com). Not fetched or bundled by elia: SWE-bench's
 * own distribution terms and dataset size are the user's call, not
 * something to unilaterally download. Point `--file` at a real SWE-bench
 * Verified export (or any task file in this exact shape) to run it for real.
 */
export interface SweBenchInstance {
  instance_id: string
  /** "owner/repo" on GitHub. */
  repo: string
  base_commit: string
  problem_statement: string
  /** Unified diff that adds/modifies the hidden test(s) — applied before elia runs, never shown to it as "the answer". */
  test_patch: string
  /** Test node ids that must go from failing (before) to passing (after). */
  FAIL_TO_PASS: string[]
  /** Test node ids that must remain passing — elia's fix must not break them. */
  PASS_TO_PASS: string[]
  /**
   * A pre-built environment image for this instance (e.g. one of SWE-bench's
   * own published `sweb.eval.*` images) — run via the container sandbox
   * (sandbox/container.ts) so the test command executes in the environment
   * the instance actually needs. Without one, tests run on the bare host,
   * which most real SWE-bench repos (arbitrary Python package versions) do
   * not match — fine for a synthetic smoke instance, not for a real one.
   */
  dockerImage?: string
  /** Default: "python -m pytest". Overridable per instance for a non-pytest repo. */
  testCommand?: string
}

export interface SweBenchInstanceResult {
  instance_id: string
  resolved: boolean
  failToPass: Record<string, 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED' | 'MISSING'>
  passToPass: Record<string, 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED' | 'MISSING'>
  agentSteps?: number
  agentError?: string
  elapsedMs: number
  /** Kept only when the instance did not resolve, for inspection. */
  keptDir?: string
}

export interface SweBenchRunSummary {
  total: number
  resolved: number
  results: SweBenchInstanceResult[]
}
