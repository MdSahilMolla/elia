export type RoleName = 'scout' | 'builder' | 'critic' | 'tester' | 'scribe'

export const ROLE_NAMES: RoleName[] = ['scout', 'builder', 'critic', 'tester', 'scribe']

export function isRoleName(value: unknown): value is RoleName {
  return typeof value === 'string' && (ROLE_NAMES as string[]).includes(value)
}

/**
 * One unit of work in a proposal — sized to be handed to a single sub-agent with
 * no further conversation, which is why `instructions` has to be self-contained.
 */
export interface ProposalStep {
  id: string
  title: string
  role: RoleName
  instructions: string
  /** Files the step expects to touch. Used to warn about steps that would collide if run in parallel. */
  files: string[]
  /** Ids of steps that must finish first. Steps with no unmet dependencies run together. */
  dependsOn: string[]
}

/**
 * What elia says it is going to do, before it does any of it. This is the
 * artifact the user approves; everything downstream executes against it.
 */
export interface Proposal {
  goal: string
  /** What elia believes to be true about the codebase after orienting. Wrong beliefs here are the cheapest thing to correct. */
  understanding: string
  assumptions: string[]
  steps: ProposalStep[]
  risks: string[]
  /** Shell commands that must all pass for the work to count as done. */
  verification: string[]
  /** Things deliberately not being done, so scope creep is visible up front. */
  outOfScope: string[]
}

export interface CriticIssue {
  severity: 'blocker' | 'major' | 'minor'
  file?: string
  detail: string
}

export interface CriticVerdict {
  verdict: 'approve' | 'revise'
  summary: string
  issues: CriticIssue[]
}

export type PhaseName = 'orient' | 'propose' | 'execute' | 'verify' | 'reflect' | 'learn'

export const PHASE_ORDER: PhaseName[] = ['orient', 'propose', 'execute', 'verify', 'reflect', 'learn']
