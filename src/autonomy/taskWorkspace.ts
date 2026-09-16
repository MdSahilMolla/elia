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
  /**
   * Set when an isolated workspace could not be given a repository of its own,
   * saying why. Until the scaffold retries, git run there resolves to the
   * checkout around it — which is the failure isolation exists to prevent, so
   * it is reported rather than left silent.
   */
  repositoryWarning?: string
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
    const repositoryWarning = initOwnRepository(root)
    return {
      runId: input.runId,
      root: realpathSync(root),
      kind: 'isolated',
      launchedFrom,
      allowedRoots: [realpathSync(root)],
      ...(repositoryWarning ? { repositoryWarning } : {}),
    }
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
 * the moment the directory does.
 *
 * Returns why it could not, when it could not. It used to fail in silence, and
 * so did the test for it: in a sibling session's full `bun test src/` runs the
 * repository was missing three times out of three, the whole call took 14 ms,
 * and nothing said what `git init` had answered. A `.git` without a HEAD — an
 * init killed part-way — is not a repository either, and is initialised again
 * (`git init` on an existing repository changes nothing).
 */
export function initOwnRepository(root: string, git = 'git'): string | undefined {
  const head = join(root, '.git', 'HEAD')
  if (existsSync(head)) return undefined
  const options = { cwd: root, windowsHide: true, timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'] as ['ignore', 'ignore', 'pipe'], encoding: 'utf8' as const }
  let init = spawnSync(git, ['init', '-q', '-b', 'main'], options)
  // Git older than 2.28 has no `-b`.
  if (!init.error && init.status !== 0) init = spawnSync(git, ['init', '-q'], options)
  if (!init.error && init.status === 0 && existsSync(head)) return undefined
  const why = init.error
    ? `${(init.error as NodeJS.ErrnoException).code ?? 'error'}: ${init.error.message}`
    : init.signal
      ? `killed by ${init.signal}`
      : `exit ${init.status}${init.stderr?.trim() ? `: ${init.stderr.trim().slice(0, 300)}` : ''}`
  return `could not give this workspace a repository of its own (git init — ${why}); until the scaffold retries, git here resolves to the checkout around it`
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
