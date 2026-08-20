import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, join } from 'node:path'
import type { RoleName } from './types.ts'

/**
 * Who is currently running.
 *
 * Tools are plain functions with no context parameter, but once a fleet of
 * sub-agents is running in parallel *in the same process*, "who called this" is
 * suddenly load-bearing: blackboard posts need attribution and the journal needs
 * to say which worker did what. AsyncLocalStorage carries that identity across
 * awaits without threading a context argument through every tool signature.
 */
export interface AgentIdentity {
  /** Short display name, e.g. "scout#2". */
  name: string
  role: RoleName | 'lead'
  runId?: string
  /**
   * Working-directory root this identity's file/shell tools resolve relative
   * paths against. Unset means `process.cwd()`, the normal case for every
   * agent that isn't running inside an isolated git worktree — see
   * `autonomy/variants.ts`, the only thing that sets this today.
   */
  cwd?: string
}

const LEAD: AgentIdentity = { name: 'lead', role: 'lead' }

const storage = new AsyncLocalStorage<AgentIdentity>()

/** Runs `fn` with `identity` as the ambient agent, for it and everything it awaits. */
export function withAgentIdentity<T>(identity: AgentIdentity, fn: () => Promise<T>): Promise<T> {
  return storage.run(identity, fn)
}

export function currentAgent(): AgentIdentity {
  return storage.getStore() ?? LEAD
}

/**
 * Resolves a tool-supplied path against the current agent's working root
 * instead of always `process.cwd()` — the one hook that lets an isolated
 * variant's builders write into their own worktree using the exact same
 * relative paths a normal run would use. Absolute paths pass through
 * unchanged (the model still gets to be explicit).
 */
export function resolvePath(path: string): string {
  const root = currentAgent().cwd
  if (!root || isAbsolute(path)) return path
  return join(root, path)
}
