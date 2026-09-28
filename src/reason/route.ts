import type { SearchDecision } from './decide.ts'

/**
 * How one prompt is reasoned about — decided for every prompt, before it runs,
 * and written into the session so the decision can be read back.
 *
 * Every prompt goes through the reasoning layer; what differs is how much of
 * it the prompt can use, and the deciding question is always the same: what
 * could tell a better answer from a worse one? Where a check can, several
 * attempts are searched and the check picks (`search`). Where the answer is a
 * short fact, an independent attempt votes (`answer-check`). A build big enough
 * for the pipeline gets its plan → verify → repair cycle (`pipeline`). The rest
 * gets one attempt (`single`) — spending three there would buy agreement, not
 * correctness. Every route but the pipeline's then has its reply audited for
 * citations and arithmetic (audit.ts), which costs no model call.
 *
 * Nothing here is new judgement: the pieces were already decided in decide.ts
 * and at the call site. This names the outcome, so "did the reasoning layer see
 * this prompt, and why did it do what it did" has an answer in the transcript
 * rather than only in the code.
 */

export type ReasoningRoute = 'pipeline' | 'search' | 'answer-check' | 'single'

export interface RouteContext {
  reasonSearch: boolean
  /** elia's own source is being edited and still needs asking about. */
  selfEditClosed: boolean
  mode: string
  persona?: string
  planMode: boolean
  escalate: boolean
}

/** Why this prompt cannot be searched, known before reading the request. Undefined when it can. */
export function searchUnavailable(context: RouteContext): string | undefined {
  if (context.escalate) return 'it is a build for the autonomous pipeline, which plans, verifies and repairs it, starting each repair from a different approach'
  if (!context.reasonSearch) return 'the reasoning search is off (/search on turns it back on)'
  if (context.planMode) return 'plan mode changes nothing, so attempts would have nothing to differ on'
  if (context.persona) return `the ${context.persona} persona answers with its own voice and tools`
  if (context.mode !== 'dev') return `search attempts run with dev-mode tools, not ${context.mode} mode's`
  if (context.selfEditClosed) return 'elia\'s own source still needs asking about, and a search merges its winner past that check'
  return undefined
}

export function reasoningRoute(input: {
  unavailable?: string
  search?: SearchDecision
  answerCheck?: { check: boolean; why: string }
  escalate: boolean
  /** Whether replies are audited (/verify). */
  audited: boolean
}): { route: ReasoningRoute; line: string } {
  const audit = input.audited ? 'then the reply\'s citations and arithmetic are checked' : 'reply checks are off (/verify on)'
  if (input.escalate) return { route: 'pipeline', line: `pipeline — ${input.unavailable ?? 'a build for the autonomous pipeline'}` }
  if (input.search?.plan) return { route: 'search', line: `search — ${input.search.why}; ${audit}` }
  if (input.answerCheck?.check) return { route: 'answer-check', line: `answer check — ${input.answerCheck.why}; ${audit}` }
  const why = input.unavailable ?? input.search?.why ?? input.answerCheck?.why ?? 'one attempt is enough here'
  return { route: 'single', line: `single attempt — not searched because ${why}; ${audit}` }
}
