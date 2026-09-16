import type { ToolEvent } from './agentLoop.ts'

/**
 * Keeps a worker whose only useful output is one structured tool call — a
 * reviewer's `submit_verdict`, the acceptance check's `submit_acceptance` —
 * from finishing without making it.
 *
 * It happens two ways. The worker spends its whole step budget reading, and
 * the loop's step-budget wrap-up then tells it to stop calling tools and
 * summarise: the one call that mattered can no longer be made, and a tool call
 * in that final reply is never executed. Runs 2026-09-10-754n-8z17 and
 * 2026-09-12-zjga-se2f each lost a build that had passed verification that way
 * — critic#1 used 27 and 28 of its 30 steps, reported nothing, and the gate
 * failed closed on "submit_verdict was never called". Or the worker simply
 * answers in prose.
 *
 * So: one warning while a few steps are still left, and one nudge if it tries
 * to end without the call. Both arrive through the loop's `drainDirectives`,
 * framed as elia's own directive. Neither relaxes the gate — a worker that
 * still does not call the tool fails it exactly as before.
 */
export function requiredToolReminders(tool: string, maxSteps: number): { onTool: (event: ToolEvent) => void; drain: () => string[] } {
  let called = false
  let boundaries = 0
  let toolEventsSinceBoundary = 0
  let warned = false
  let nudged = false
  // The warning lands with three model calls left: the one that reads it, and
  // two spare in case the call is rejected (a "revise" with no issues) and has
  // to be made again.
  const warnAt = Math.max(2, maxSteps - 2)

  return {
    onTool(event) {
      toolEventsSinceBoundary += 1
      if (event.name === tool && !event.isError) called = true
    },
    // Called at the top of every step, and once more when a reply calls no
    // tools at all — the model is about to end. The second case is the one
    // with no tool events since the previous boundary.
    drain() {
      boundaries += 1
      const endingWithoutTools = boundaries > 1 && toolEventsSinceBoundary === 0
      toolEventsSinceBoundary = 0
      if (called) return []
      if (endingWithoutTools && !nudged) {
        nudged = true
        return [`You are finishing without calling ${tool}, so none of this work counts. Call ${tool} now with your conclusion.`]
      }
      if (!warned && boundaries >= warnAt) {
        warned = true
        return [`Only a few steps of your budget are left. Stop investigating and call ${tool} now with what you have found. A conclusion from partial evidence counts; running out of steps does not.`]
      }
      return []
    },
  }
}
