/**
 * Bridges operator steering (text the user types while a turn is running) from
 * the top-level agent loop down into a sub-agent that is currently executing.
 *
 * The top-level loop folds steering in at its own step boundaries — but when it
 * is blocked inside a long `task` tool call (a sub-agent that runs for minutes),
 * there is no step boundary to fold into until that call returns. While the
 * parent is blocked it is not looping, so it is safe for the running sub-agent
 * to drain the same source: whichever loop is actually iterating consumes the
 * pending messages, and the other sees an empty list.
 *
 * This is a module-level register rather than a threaded argument because tools
 * are plain functions with no context parameter and a sub-agent is spawned
 * several call frames below the loop that owns the steering closure.
 */

let parentSteering: (() => string[]) | undefined

/** Set by the top-level turn for the duration of its run; cleared in its `finally`. */
export function setParentSteering(drain: (() => string[]) | undefined): void {
  parentSteering = drain
}

/** Pending operator steering, if a top-level turn registered a source and any is queued. */
export function drainParentSteering(): string[] {
  try {
    return parentSteering?.() ?? []
  } catch {
    return []
  }
}
