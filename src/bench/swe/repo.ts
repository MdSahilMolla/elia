import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../../statePaths.ts'
import { runGit } from '../../autonomy/worktree.ts'

/**
 * Clones and checks out an *arbitrary* external repository for one SWE-bench
 * instance — a different problem from evolve/history/materialize.ts's
 * checkoutTree, which always reads from elia's own repo. Each `repo` is
 * cloned once into a shared bare cache and reused across every instance that
 * names it (SWE-bench Verified has far fewer distinct repos than instances),
 * then a throwaway working tree is checked out per instance from that cache
 * — no network fetch for the second, third, … instance from the same repo.
 */

function reposCacheDir(): string {
  return join(paths.state, 'bench', 'swe-repos')
}

function cachePathFor(repo: string): string {
  // "owner/repo" -> "owner__repo.git", safe as a single path segment on every platform.
  return join(reposCacheDir(), `${repo.replace(/\//g, '__')}.git`)
}

/** Clones `repo` (bare, once) into the shared cache and returns its local path. A second call for the same repo is a cheap fetch, not a re-clone. */
const REPO_SEGMENT = /^(?!\.\.?$)[\w.-]+$/

export async function ensureRepoCached(repo: string): Promise<string> {
  const segments = repo.split('/')
  if (segments.length !== 2 || !segments.every((segment) => REPO_SEGMENT.test(segment))) {
    throw new Error(`refusing to clone "${repo}" — expected "owner/repo"`)
  }
  const cachePath = cachePathFor(repo)
  mkdirSync(reposCacheDir(), { recursive: true })

  if (existsSync(cachePath)) {
    const fetch = await runGit(['--git-dir', cachePath, 'fetch', '--all', '--quiet'])
    if (fetch.exitCode !== 0) {
      throw new Error(`could not refresh cached clone of ${repo}: ${fetch.stderr || fetch.stdout}`)
    }
    return cachePath
  }

  const url = `https://github.com/${repo}.git`
  const clone = await runGit(['clone', '--bare', '--quiet', url, cachePath])
  if (clone.exitCode !== 0) {
    throw new Error(`could not clone ${url}: ${clone.stderr || clone.stdout}`)
  }
  return cachePath
}

/**
 * Checks out `commit` from a local git-dir (bare or not) into a fresh
 * throwaway work-tree. Split out from {@link checkoutInstanceTree} so the
 * actual git mechanics — the part that matters — are testable against a
 * hand-built local repo, without every test run needing network access to
 * clone a real GitHub repo.
 */
export async function checkoutFromLocalGitDir(gitDir: string, commit: string, instanceId: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `elia-swebench-${instanceId.replace(/[^\w.-]/g, '_')}-`))
  const indexFile = join(dir, '.elia-swebench-index')
  const result = await runGit(['--git-dir', gitDir, '--work-tree', dir, 'checkout', commit, '--', '.'], undefined, { GIT_INDEX_FILE: indexFile })
  if (result.exitCode !== 0) {
    throw new Error(`could not check out ${commit} into ${dir}: ${result.stderr || result.stdout}`)
  }
  return dir
}

/** A throwaway working tree for one instance, checked out from the shared bare cache at an exact commit. */
export async function checkoutInstanceTree(repo: string, commit: string, instanceId: string): Promise<string> {
  const cachePath = await ensureRepoCached(repo)
  try {
    return await checkoutFromLocalGitDir(cachePath, commit, instanceId)
  } catch (err) {
    throw new Error(`could not check out ${repo}@${commit}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Applies a unified diff (e.g. an instance's test_patch) to a checked-out tree. Throws with git's own message on a patch that doesn't apply cleanly — a real signal the instance's base_commit or patch is stale, not something to silently ignore. */
export async function applyPatch(dir: string, patch: string): Promise<void> {
  if (!patch.trim()) return
  const patchPath = join(dir, '.elia-swebench-patch.diff')
  await Bun.write(patchPath, patch)
  try {
    const result = await runGit(['apply', '--whitespace=nowarn', patchPath], dir)
    if (result.exitCode !== 0) {
      throw new Error(`patch did not apply cleanly: ${result.stderr || result.stdout}`)
    }
  } finally {
    await Bun.file(patchPath).delete().catch(() => undefined)
  }
}
