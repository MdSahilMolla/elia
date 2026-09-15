import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { ELIA_ROOT } from '../statePaths.ts'

export type TaskWorkspaceKind = 'isolated' | 'selected'

/** The single filesystem boundary for an autonomous run. */
export interface TaskWorkspace {
  runId: string
  root: string
  kind: TaskWorkspaceKind
  /** The directory Elia was launched from, retained for display and auditing. */
  launchedFrom: string
  /** Roots that commands, workers, review, and verification may access. */
  allowedRoots: readonly string[]
}

function slug(goal: string): string {
  const normalized = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (normalized || 'task').slice(0, 48)
}

function canonicalDirectory(path: string): string {
  const resolved = resolve(path)
  if (!existsSync(resolved)) throw new Error(`Selected task workspace does not exist: ${resolved}`)
  return realpathSync(resolved)
}

/**
 * Selects a root before any worker starts. New builds launched from Elia's own
 * repository get a fresh child workspace; changing Elia itself requires an
 * explicit --workspace selection.
 */
export function provisionTaskWorkspace(input: { runId: string; goal: string; workspaceRoot?: string; launchedFrom?: string }): TaskWorkspace {
  const launchedFrom = canonicalDirectory(input.launchedFrom ?? process.cwd())
  if (input.workspaceRoot) {
    const root = canonicalDirectory(input.workspaceRoot)
    return { runId: input.runId, root, kind: 'selected', launchedFrom, allowedRoots: [root] }
  }

  if (launchedFrom === realpathSync(ELIA_ROOT)) {
    const root = resolve(launchedFrom, 'workspace', `${input.runId}-${slug(input.goal)}`)
    mkdirSync(root, { recursive: true })
    initOwnRepository(root)
    return { runId: input.runId, root: realpathSync(root), kind: 'isolated', launchedFrom, allowedRoots: [realpathSync(root)] }
  }

  return { runId: input.runId, root: launchedFrom, kind: 'selected', launchedFrom, allowedRoots: [launchedFrom] }
}

/**
 * An isolated workspace sits inside elia's checkout, under a `workspace/` that
 * checkout ignores, so without a repository of its own every git command run
 * in it resolves to elia's. The scaffold would create one after plan approval
 * (see `ensureRepository`), but that is too late for two things that happen
 * first: the planner orienting in what looks like elia's repo, and the run's
 * "already uncommitted before I started" snapshot, which would list elia's
 * dirty files — and a dirty `package.json` in elia would then keep the run's
 * own `package.json` out of every wave commit. So the repository exists from
 * the moment the directory does. Best effort: without git, the scaffold
 * reports the missing history later.
 */
function initOwnRepository(root: string): void {
  if (existsSync(join(root, '.git'))) return
  const options = { cwd: root, windowsHide: true, timeout: 10_000, stdio: 'ignore' as const }
  const init = spawnSync('git', ['init', '-q', '-b', 'main'], options)
  // Git older than 2.28 has no `-b`.
  if (!init.error && init.status !== 0) spawnSync('git', ['init', '-q'], options)
}

export function isWithinTaskWorkspace(path: string, workspace: Pick<TaskWorkspace, 'root'>): boolean {
  const rel = relative(workspace.root, resolve(path))
  return rel === '' || (!rel.startsWith('..\\') && !rel.startsWith('../') && rel !== '..')
}

export function taskWorkspaceLabel(workspace: TaskWorkspace): string {
  return workspace.kind === 'isolated'
    ? `isolated workspace: ${workspace.root}`
    : `selected workspace: ${workspace.root}${basename(workspace.root) === basename(ELIA_ROOT) ? ' (Elia source selected explicitly)' : ''}`
}
