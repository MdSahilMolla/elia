import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import type { RoleName } from './types.ts'

/**
 * Who is currently running.
 *
 * Tools are plain functions with no context parameter, but once a fleet of
 * sub-agents is running in parallel *in the same process*, "who called this"
 * is suddenly load-bearing: blackboard posts need attribution and the journal
 * needs to say which worker did what. AsyncLocalStorage carries that identity
 * across awaits without threading a context argument through every tool
 * signature.
 */
export interface AgentIdentity {
  /** Short display name, e.g. "scout#2". */
  name: string
  role: RoleName | 'lead'
  runId?: string
  /** Working-directory root this identity's file/shell tools resolve against. */
  cwd?: string
  /** Cooperative cancellation inherited by tools in this execution context. */
  signal?: AbortSignal
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
 * Resolves a tool-supplied path against the current agent's working root.
 * Callers that access the filesystem must use `resolveWorkspacePath`, not this
 * compatibility helper, because lexical resolution alone is not a security
 * boundary.
 */
export function resolvePath(path: string): string {
  const root = currentAgent().cwd
  if (!root || isAbsolute(path)) return path
  return join(root, path)
}

/**
 * Resolve an input path through the real filesystem and require the resulting
 * target to remain below the active workspace. For a new file, the nearest
 * existing parent is canonicalized so symlinked directories cannot redirect a
 * write outside the workspace. The returned path is canonical, which avoids
 * continuing through a checked symlink after validation.
 */
export function resolveWorkspacePath(inputPath: string, cwd = currentAgent().cwd ?? process.cwd()): string {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) throw new Error('path must be a non-empty string')
  const raw = inputPath.trim()
  const root = canonicalExistingPath(resolve(cwd))
  const target = resolve(cwd, raw)
  const canonicalTarget = canonicalPathWithExistingParent(target)
  if (!isWithin(root, canonicalTarget)) throw new Error(`Path escapes the active workspace: ${raw}`)
  return canonicalTarget
}

/** Resolve a path inside the active workspace or one of explicitly designated safe roots. */
export function resolveAllowedWorkspacePath(inputPath: string, cwd = currentAgent().cwd ?? process.cwd(), allowedRoots: string[] = []): string {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) throw new Error('path must be a non-empty string')
  const raw = inputPath.trim()
  const canonicalTarget = canonicalPathWithExistingParent(resolve(cwd, raw))
  const roots = [resolve(cwd), ...allowedRoots.map((root) => resolve(root))]
  if (roots.some((root) => isWithin(canonicalPathWithExistingParent(root), canonicalTarget))) return canonicalTarget
  throw new Error(`Path escapes the active workspace: ${raw}`)
}

/** Returns whether an input path resolves inside the canonical workspace. */
export function isPathWithinWorkspace(inputPath: string, cwd = currentAgent().cwd ?? process.cwd()): boolean {
  try {
    resolveWorkspacePath(inputPath, cwd)
    return true
  } catch {
    return false
  }
}

function canonicalPathWithExistingParent(target: string): string {
  const missing: string[] = []
  let current = target
  while (true) {
    try {
      lstatSync(current)
      return join(canonicalExistingPath(current), ...missing)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
      const parent = dirname(current)
      if (parent === current) throw new Error(`Path has no existing parent: ${target}`)
      missing.unshift(basename(current))
      current = parent
    }
  }
}

function canonicalExistingPath(path: string): string {
  return realpathSync(path)
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${'/'}`) && !rel.startsWith(`..${'\\'}`) && !isAbsolute(rel))
}
