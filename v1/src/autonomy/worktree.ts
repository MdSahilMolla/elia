import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '../config.ts'

/**
 * Isolated git worktrees for running several independent implementation
 * attempts of the same plan at once (see variants.ts) without them clobbering
 * each other or the user's real working tree.
 *
 * A plain `git worktree add` checks out from a *commit*, so it would silently
 * drop whatever uncommitted work the user already had sitting in their real
 * tree when the run started. `seedWorktreeWithDirtyState` copies that
 * uncommitted state in after creation, so each variant starts from exactly
 * what a normal (non-variant) execute phase would have started from: HEAD
 * plus whatever was already dirty.
 */

export interface Worktree {
  path: string
  branch: string
}

interface StatusChange {
  path: string
  deleted: boolean
}

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Runs git with a real argv array instead of a shell command string.
 *
 * `shell.ts`'s `runShell` goes through `cmd /c "<string>"` on Windows, and
 * cmd's re-lexing of that string mangles any quoted argument that contains a
 * space (e.g. a worktree path under a user directory like `C:\Users\Jane Doe`)
 * — confirmed live: even a bare `git worktree add "<path with a space>"`
 * fails with git's own usage error because cmd splits the path at the space
 * before git ever sees it. Spawning git directly sidesteps shell re-lexing
 * entirely, the same way passing a real argv array always has.
 */
async function runGit(args: string[], cwd?: string): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe', ...(cwd ? { cwd } : {}) })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** Parses `git status --porcelain=v1` output into the files a copy-based sync needs to touch. */
function parseStatus(porcelain: string): StatusChange[] {
  const changes: StatusChange[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let rawPath = line.slice(3)
    // A rename ("R  old -> new") only needs the destination copied — the
    // source's absence is already implied by it not existing at the new path.
    if (rawPath.includes(' -> ')) rawPath = rawPath.split(' -> ')[1] ?? rawPath
    const path = rawPath.trim().replace(/^"|"$/g, '')
    if (!path) continue
    changes.push({ path, deleted: code.includes('D') })
  }
  return changes
}

/** Copies every changed/untracked/deleted file from one working tree to another, in either direction. */
async function syncDirtyFiles(fromRoot: string, toRoot: string): Promise<string[]> {
  const status = await runGit(['status', '--porcelain=v1'], fromRoot)
  const changes = parseStatus(status.stdout)

  for (const change of changes) {
    const targetPath = join(toRoot, change.path)
    if (change.deleted) {
      await rm(targetPath, { force: true })
      continue
    }
    const source = Bun.file(join(fromRoot, change.path))
    if (await source.exists()) await Bun.write(targetPath, await source.arrayBuffer())
  }

  return changes.map((change) => change.path)
}

/**
 * Creates a new worktree on a fresh branch from HEAD, seeded with the source
 * repo's current uncommitted changes. `sourceRoot`/`baseDir` default to the
 * real repo and elia's real state dir — overridable so tests can point this
 * at a throwaway repo instead of touching this actual working tree.
 */
export async function createWorktree(
  runId: string,
  index: number,
  sourceRoot: string = process.cwd(),
  baseDir: string = paths.state,
): Promise<Worktree> {
  const branch = `elia/variant-${runId}-${index}`
  const path = join(baseDir, 'worktrees', runId, `v${index}`)

  const result = await runGit(['worktree', 'add', '-b', branch, path, 'HEAD'], sourceRoot)
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree for variant ${index + 1}: ${result.stderr || result.stdout}`)
  }

  await syncDirtyFiles(sourceRoot, path)
  return { path, branch }
}

/** Copies the winning variant's changes back into the real working tree (or `targetRoot`, for tests). Returns the files it touched. */
export function mergeWorktreeIntoCwd(worktree: Worktree, targetRoot: string = process.cwd()): Promise<string[]> {
  return syncDirtyFiles(worktree.path, targetRoot)
}

/**
 * Tears down a variant's worktree and branch. Best-effort — a stray worktree
 * under `.elia/worktrees/` is cheap to clean up manually and must never fail
 * the run that's already picked a winner.
 *
 * `sourceRoot` must be the repo that owns this worktree, not just "wherever
 * this process happens to be" — `git worktree remove`/`branch -D` resolve
 * against whatever repo their `cwd` points at, and get a plain "not found"
 * no-op against the wrong one rather than a loud error, which is exactly the
 * kind of failure this function's own try/catch would otherwise swallow
 * silently. Defaults to `process.cwd()` because that already IS the target
 * repo for every real elia auto run; only tests need to override it.
 */
export async function removeWorktree(worktree: Worktree, sourceRoot: string = process.cwd()): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktree.path], sourceRoot)
    await runGit(['branch', '-D', worktree.branch], sourceRoot)
  } catch {
    // Best-effort cleanup, see above.
  }
}
