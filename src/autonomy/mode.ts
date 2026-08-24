/**
 * Which operating mode the current top-level turn is running as: dev, cyber,
 * sports, fitness, or battmann.
 *
 * Ambient rather than threaded as a parameter because sub-agents (dispatched via
 * the `task` tool, arbitrarily deep in a tool call) need to pick it up too: a
 * scout launched while the lead is in cyber mode should get security-flavoured
 * instructions and guardrails, not elia's dev-mode coding brief. Mirrors the
 * ambient-blackboard pattern in autonomy/blackboard.ts for the same reason —
 * the `Tool` interface is intentionally context-free.
 */
export type AgentMode = 'dev' | 'cyber' | 'sports' | 'fitness' | 'battmann'

let current: AgentMode = 'dev'

/** Set once at the top of `runTurn`, for it and everything it (and its sub-agents) awaits. */
export function setActiveMode(mode: AgentMode): void {
  current = mode
}

export function activeMode(): AgentMode {
  return current
}
