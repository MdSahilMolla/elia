import type { ProgressTrend } from './progress.ts'

/**
 * When the repair loop is not converging (see progress.ts), *why* it is stuck
 * decides what to do about it. Feeding the same "here's what failed, fix it"
 * prompt into attempt after attempt only helps when the problem is a fixable
 * mistake in the code. If the agent is missing a fact only the user has, or a
 * dependency isn't installed, or the governor is blocking a step, more repair
 * passes are pure waste — the run should ask, fix the environment, or hand off.
 *
 * This classifies the stall from the failure output and the agent's own last
 * words, deterministically. No model call.
 */

export type StuckCategory = 'wrong-approach' | 'missing-information' | 'environment' | 'external-blocker' | 'unknown'

export type StuckRecovery = 'replan' | 'ask-user' | 'fix-environment' | 'resolve-approval' | 'handoff'

export interface StuckDiagnosis {
  category: StuckCategory
  recovery: StuckRecovery
  reason: string
  /** Populated for `ask-user`: the specific question to put to the operator. */
  question?: string
}

const ENVIRONMENT = /\b(?:command not found|not recognized as an internal or external command|ENOENT|cannot find module|module not found|no such file or directory|permission denied|EACCES|EPERM\b|ECONNREFUSED| ETIMEDOUT|getaddrinfo|could not resolve host|connection refused|address already in use|EADDRINUSE|no matching version found|unable to resolve dependency|python: not found|command failed: (?:pip|npm|bun|cargo|go|poetry)\b)/i

const EXTERNAL_BLOCKER = /\b(?:blocked by .{0,40}governor|requires? .{0,20}approval|exact approval|approval (?:is )?required|awaiting approval|rate limit|HTTP 429|\b429\b|quota exceeded|not signed in|unauthorized|HTTP 401|\b401\b|invalid api key|authentication (?:failed|required)|credentials? (?:missing|not found))/i

const MISSING_INFO = /\bI (?:could|can) ?n[o']t (?:determine|find|tell|figure out|locate|establish|be sure)\b|\bunclear (?:what|whether|how|which|if)\b|\bambiguous\b|\bneed(?:s|ed)? (?:more (?:info|information|context)|clarification|to know)\b|\bnot sure (?:what|which|whether|how|if)\b|\b(?:which|what) .{0,60}(?:did you (?:mean|intend)|is intended|should (?:it|I))\b|\bno (?:documentation|spec|example) (?:for|of)\b/i

const LOGIC_FAILURE = /\b(?:expected|received|assert|assertion|to (?:be|equal|contain|match)|deep equal|toBe|toEqual|error TS\d|type .{0,40}is not assignable|property .{0,40}does not exist|\d+ (?:failing|failed))\b/i

/** Pulls the first genuine question out of the agent's report, for the ask-user path. */
export function extractQuestion(text: string): string | undefined {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.?!]*\?/g)
  if (!sentences || sentences.length === 0) return undefined
  // Prefer a question that asks the operator to choose or confirm, not a
  // rhetorical aside ("Why is it like this?").
  const decisionLike = sentences.find((s) =>
    /\b(?:should I\b|do you want\b|would you (?:prefer|like)\b|can you (?:confirm|clarify)\b|which (?:one|of|approach|option|value)\b|\bor\b.*\?$)/i.test(s.trim()),
  )
  return (decisionLike ?? sentences[0]!).trim().slice(0, 300)
}

export function classifyStuck(input: { failureText: string; agentReport?: string; trend: ProgressTrend }): StuckDiagnosis {
  const failure = input.failureText ?? ''
  const report = input.agentReport ?? ''
  const haystack = `${failure}\n${report}`

  if (EXTERNAL_BLOCKER.test(haystack)) {
    return {
      category: 'external-blocker',
      recovery: 'resolve-approval',
      reason: 'A step is blocked on an approval, a credential, or a rate/quota limit — repair passes cannot clear that.',
    }
  }

  if (ENVIRONMENT.test(haystack)) {
    return {
      category: 'environment',
      recovery: 'fix-environment',
      reason: 'The failure is an environment problem (a missing dependency, tool, file, port, or network reachability), not a defect in the change.',
    }
  }

  if (MISSING_INFO.test(report)) {
    return {
      category: 'missing-information',
      recovery: 'ask-user',
      reason: 'The agent reports it is missing a fact it cannot obtain on its own.',
      question: extractQuestion(report),
    }
  }

  if ((input.trend === 'stalled' || input.trend === 'diverging') && LOGIC_FAILURE.test(failure)) {
    return {
      category: 'wrong-approach',
      recovery: 'replan',
      reason: 'The same logic/type failures are surviving every repair attempt — the approach itself, not just this fix, needs reconsidering.',
    }
  }

  return {
    category: 'unknown',
    recovery: 'handoff',
    reason: 'The stall does not match a known recoverable pattern; a human should look at the diagnostics.',
  }
}
