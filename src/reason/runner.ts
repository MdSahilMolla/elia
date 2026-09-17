import { runSubAgent } from '../subagent.ts'
import { totalTokens } from '../usage.ts'
import type { RoleName } from '../autonomy/types.ts'
import type { ToolEvent } from '../agentLoop.ts'
import type { AttemptRunner } from './attempt.ts'

/**
 * What actually makes an attempt: a real elia sub-agent, rooted in that
 * attempt's own worktree.
 *
 * `attempt.ts` owns the isolation and `select.ts` owns the search, but neither
 * of them may know how elia runs a turn — that is the whole reason the runner
 * is injected. This is the one implementation that does, and it is deliberately
 * thin: `runSubAgent` already resolves the role's model, tool set and prompt,
 * and already honours a `cwd` so its file and shell tools resolve inside the
 * worktree rather than the user's checkout. That `cwd` parameter exists because
 * `autonomy/variants.ts` needed exactly this; the search is its second caller.
 *
 * The approach instruction arrives as the briefing rather than glued onto the
 * request. The request is what the user asked for and must reach every attempt
 * identically — if attempts differed in the task as well as the method, a win
 * could not be attributed to the method, and the library would be measuring
 * noise dressed as a harness.
 */

/** Cost is counted in tokens, which is what a budget is actually spent in. */
export function subAgentRunner(options: {
  /** The user's request, verbatim and identical for every attempt. */
  request: string
  /** Correlates this search's sub-agents in logs. */
  runId: string
  /** Defaults to `builder` — the role that writes code. */
  role?: RoleName
  onTool?: (event: ToolEvent) => void
}): AttemptRunner {
  const role = options.role ?? 'builder'
  return async ({ cwd, approach, round, briefing, signal }) => {
    const result = await runSubAgent({
      prompt: options.request,
      briefing,
      role,
      name: `attempt/${approach.id}${round > 0 ? `#${round + 1}` : ''}`,
      runId: options.runId,
      cwd,
      signal,
      onTool: options.onTool,
    })
    // A sub-agent that reported `ok: false` still produced a tree, and the
    // verifier is what decides — its own opinion of how it went is exactly the
    // kind of self-assessment this layer exists to stop trusting.
    return { text: result.report, cost: totalTokens(result.usage) }
  }
}
