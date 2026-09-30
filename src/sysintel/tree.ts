import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * What exactly was reviewed or tested. A review approves one state of the code; a test run
 * passes on one state. If the code changes afterwards, both are stale — the change that
 * ships must be the change that was checked. The fingerprint is the git tree the working
 * directory would commit as right now (tracked changes and untracked, non-ignored files
 * included; elia's own .elia state excluded), so it is the same before and after the work
 * is committed, and different after any edit.
 */

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const result = spawnSync('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() }
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).out === 'true'
}

/** The content fingerprint of the working tree, or undefined outside a git repository. */
export function treeFingerprint(cwd: string): string | undefined {
  if (!isGitRepo(cwd)) return undefined
  const indexPath = git(cwd, ['rev-parse', '--git-path', 'index']).out
  const realIndex = indexPath && (isAbsolute(indexPath) ? indexPath : join(cwd, indexPath))
  const scratch = mkdtempSync(join(tmpdir(), 'elia-si-tree-'))
  const tempIndex = join(scratch, 'index')
  try {
    // Starting from a copy of the real index keeps git's stat cache, so only changed files are re-hashed.
    if (realIndex && existsSync(realIndex)) copyFileSync(realIndex, tempIndex)
    const env = { GIT_INDEX_FILE: tempIndex }
    // Naming an ignored path in a pathspec — even to exclude it — makes `git add` fail, so the
    // exclusion is only spelled out when .elia is not already ignored.
    const eliaIgnored = git(cwd, ['check-ignore', '-q', '.elia']).ok
    const added = git(cwd, ['add', '-A', '--', '.', ...(eliaIgnored ? [] : [':(exclude).elia'])], env)
    if (!added.ok) return undefined
    // A copied index still holds .elia entries the real index tracks; drop them from the fingerprint.
    git(cwd, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.elia'], env)
    const tree = git(cwd, ['write-tree'], env)
    return tree.ok && /^[0-9a-f]{40,64}$/.test(tree.out) ? tree.out : undefined
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export interface HeadState {
  /** The commit checked out when the work began, if any. */
  head?: string
  /** The committed tree at that commit, .elia excluded (the empty tree when there are no commits). */
  tree?: string
}

/**
 * The committed starting point of a piece of work. Using HEAD rather than the working tree
 * means changes already sitting uncommitted when the work is opened count toward it —
 * someone who fixed the bug and then opened the initiative still has a change to show.
 */
export function headState(cwd: string): HeadState {
  if (!isGitRepo(cwd)) return {}
  const head = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const scratch = mkdtempSync(join(tmpdir(), 'elia-si-head-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    if (head.ok) {
      if (!git(cwd, ['read-tree', 'HEAD'], env).ok) return { head: head.out }
      git(cwd, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.elia'], env)
    }
    const tree = git(cwd, ['write-tree'], env)
    return { head: head.ok ? head.out : undefined, tree: tree.ok ? tree.out : undefined }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Whether `sha` was already part of history at `base` — i.e. not new work since then. */
export function isAncestor(cwd: string, sha: string, base: string): boolean {
  return git(cwd, ['merge-base', '--is-ancestor', sha, base]).ok
}

export interface CommitInfo {
  sha: string
  subject: string
  author: string
  date: string
}

/** Resolves a commit that really exists in this repository. */
export function verifyCommit(cwd: string, ref: string): CommitInfo {
  if (!/^[0-9A-Za-z._/@^~-]{1,200}$/.test(ref) || ref.startsWith('-')) throw new Error(`"${ref}" is not a commit reference`)
  if (!isGitRepo(cwd)) throw new Error('this directory is not a git repository, so there is no commit to verify')
  const type = git(cwd, ['cat-file', '-t', `${ref}^{commit}`])
  if (!type.ok || type.out !== 'commit') throw new Error(`no commit "${ref}" exists in this repository`)
  const info = git(cwd, ['log', '-1', '--format=%H%x00%s%x00%an%x00%cI', `${ref}^{commit}`, '--'])
  const [sha, subject, author, date] = info.out.split('\0')
  if (!sha) throw new Error(`could not read commit "${ref}"`)
  return { sha, subject: subject ?? '', author: author ?? '', date: date ?? '' }
}

export interface BranchInfo {
  name: string
  head: string
  isDefault: boolean
}

/** Resolves a local branch, and whether it is the repository's default / production branch. */
export function verifyBranch(cwd: string, name?: string): BranchInfo {
  if (!isGitRepo(cwd)) throw new Error('this directory is not a git repository')
  const branch = name ?? git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out
  if (!branch || branch === 'HEAD') throw new Error('HEAD is detached — check out a branch first')
  if (!/^[0-9A-Za-z._/-]{1,200}$/.test(branch) || branch.startsWith('-')) throw new Error(`"${branch}" is not a branch name`)
  const head = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (!head.ok) throw new Error(`no local branch "${branch}"`)
  const remoteHead = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).out.replace(/^origin\//, '')
  const defaults = new Set(['main', 'master', 'production', 'trunk', 'develop', ...(remoteHead ? [remoteHead] : [])])
  return { name: branch, head: head.out, isDefault: defaults.has(branch) }
}
