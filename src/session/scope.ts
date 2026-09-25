import { isAbsolute, relative, resolve } from 'node:path'
import type { SessionId, SessionScope } from './types.ts'
import { canonicalPathWithExistingParent, currentAgent, withAgentIdentity } from '../autonomy/context.ts'

/**
 * Runs `fn` under the given session's filesystem scope. Reuses elia's single
 * AsyncLocalStorage by lifting the scope onto the ambient `AgentIdentity`, so a
 * session agent's file tools inherit the boundary without threading a new
 * context argument through every signature.
 */
export function withSessionScope<T>(sessionId: SessionId, worktree: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withAgentIdentity({ ...currentAgent(), sessionScope: { sessionId, worktree } }, fn)
}

/** The scope of the session currently running, if any. */
export function currentSessionScope(): SessionScope | undefined {
  return currentAgent().sessionScope
}

/**
 * Defensive write boundary for the autonomy governor. When a session scope with
 * a worktree is active, a file path must resolve inside that worktree or this
 * throws — a session agent can never write outside its isolated tree even if
 * its cwd were misconfigured. With no scope (or an undefined worktree) there is
 * no restriction.
 */
export function assertWriteWithinSessionScope(resolvedPath: string): void {
  const scope = currentSessionScope()
  if (!scope || scope.worktree === undefined) return
  // Both sides are canonicalized: the governor hands over a realpath, so a
  // worktree reached through a symlink (macOS /var -> /private/var) must be too.
  const target = canonicalPathWithExistingParent(resolve(resolvedPath))
  const root = canonicalPathWithExistingParent(resolve(scope.worktree))
  const rel = relative(root, target)
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${'/'}`) && !rel.startsWith(`..${'\\'}`) && !isAbsolute(rel))) return
  throw new Error(`path escapes the session worktree: ${resolvedPath}`)
}