/**
 * Shared shapes for `elia autopilot` — goal-free, unsupervised development.
 *
 * The pipeline, in the order it runs:
 *
 *   survey      what the repository is, read from its own files and history
 *   health      which of its own checks pass right now — measured, not guessed
 *   understand  purpose, current state and direction, each claim citing survey
 *               evidence or a file that exists (ungrounded claims are dropped)
 *   backlog     candidate goals — failing checks first — scored in code
 *   work        each goal is a governed `elia auto` run on elia's own branch
 *   ratchet     re-measure; a goal that turns any passing check red is rolled
 *               back (the attempt is kept as a git ref, never destroyed)
 *
 * Everything is durable under `.elia/autopilot/`, so a stopped pilot resumes
 * where it stood.
 */

export type EvidenceKind = 'identity' | 'readme' | 'docs' | 'git' | 'marker' | 'structure' | 'tests' | 'ci' | 'database' | 'environment' | 'checks'

export interface Evidence {
  /** `E1`, `E2`, … — what claims cite. */
  id: string
  kind: EvidenceKind
  /** Where it was read from: a path, `git log`, `package.json#scripts`. */
  source: string
  text: string
}

export interface GitFacts {
  branch: string
  head: string
  commits: number
  commitsLast30Days: number
  firstCommitDate?: string
  lastCommitDate?: string
  recentSubjects: string[]
  hotPaths: Array<{ path: string; changes: number }>
  dirty: string[]
}

export interface RepoSurvey {
  root: string
  takenAt: string
  name: string
  description?: string
  stacks: string[]
  packageManager: string
  checks: string[]
  git?: GitFacts
  files: { total: number; source: number; tests: number; topDirs: Array<{ dir: string; files: number }> }
  markerCount: number
  ci: string[]
  database: string[]
  environmentBlockers: string[]
  setupCommands: string[]
  evidence: Evidence[]
}

export type CheckStatus = 'pass' | 'fail' | 'timeout' | 'inconclusive' | 'blocked'

export interface CheckHealth {
  command: string
  status: CheckStatus
  exitCode: number
  elapsedMs: number
  /** Last lines of output for a check that did not pass; empty for a pass. */
  tail: string
  /** For a red check whose runner names its failing tests (health.ts `failingTests`), which ones. */
  failures?: string[]
}

export interface HealthReport {
  takenAt: string
  checks: CheckHealth[]
}

export interface Claim {
  claim: string
  /** Evidence ids (`E4`) or repo-relative paths that exist. */
  evidence: string[]
}

export interface Understanding {
  purpose: string
  audience: string
  currentState: Claim[]
  direction: Claim[]
  vision: string
  risks: Claim[]
  /** Claims the model made that cited nothing real — counted, then dropped. */
  droppedClaims: number
  model: string
  formedAt: string
}

export type GoalKind = 'user' | 'repair' | 'provision' | 'test' | 'hardening' | 'feature' | 'refactor' | 'docs'
/** `event`: something a watcher saw while the pilot ran with `--watch` (watch.ts). */
export type GoalOrigin = 'user' | 'health' | 'environment' | 'model' | 'event'
export type GoalStatus = 'open' | 'done' | 'parked'

export interface GoalOutcome {
  at: string
  runId?: string
  runOutcome: string
  accepted: boolean
  reason: string
  beforeSha?: string
  afterSha?: string
  /** Where a rolled-back attempt was kept: `refs/elia/autopilot/…`. */
  keptAt?: string
  regressions: string[]
  fixed: string[]
  elapsedMs: number
  /** What the goal cost, from the session's priced usage while it ran. */
  costUsd?: number
  blockers: string[]
}

export interface Goal {
  id: string
  title: string
  detail: string
  kind: GoalKind
  origin: GoalOrigin
  /** 1–5 each; the score is computed from these in code, never taken from the model. */
  value: number
  effort: number
  risk: number
  verification: string[]
  evidence: string[]
  status: GoalStatus
  attempts: number
  outcomes: GoalOutcome[]
  createdAt: string
}

export type PilotPhase = 'survey' | 'health' | 'understand' | 'plan' | 'work' | 'finished' | 'stopped'

export interface PilotState {
  version: 1
  id: string
  root: string
  branch?: string
  baseBranch?: string
  baseSha?: string
  startedAt: string
  updatedAt: string
  phase: PilotPhase
  baseline?: HealthReport
  latest?: HealthReport
  survey?: RepoSurvey
  understanding?: Understanding
  backlog: Goal[]
  currentGoalId?: string
  goalsRun: number
  stopReason?: string
  /** Things only a person can do: refused critical actions, missing tools, credentials. */
  needsHuman: string[]
  /**
   * What goals cost, by UTC day (`2026-09-30`). Kept in the state, not the
   * process, so a watching pilot that the service manager restarts cannot
   * reset its own budget by exiting.
   */
  spentByDay?: Record<string, number>
}
