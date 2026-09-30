/**
 * The handful of git operations the autopilot runs itself, outside any model's
 * reach: survey reads, the branch it works on, checkpoints, and rollback.
 *
 * Synchronous and argv-only (never a shell string). Every mutating call here
 * refuses unless the checkout is on the autopilot's own branch, so a bug in
 * the caller can never reset or commit on the operator's branch.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { signCommitMessage } from '../provenance.ts'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

export function git(args: string[], root: string, timeoutMs = 60_000): GitResult {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  return {
    ok: result.status === 0 && !result.error,
    stdout: (result.stdout ?? '').trimEnd(),
    stderr: (result.stderr ?? '').trim() || (result.error?.message ?? ''),
    code: result.status ?? -1,
  }
}

export function isGitWorkTree(root: string): boolean {
  const inside = git(['rev-parse', '--is-inside-work-tree'], root)
  return inside.ok && inside.stdout === 'true'
}

export function headSha(root: string): string | undefined {
  const head = git(['rev-parse', 'HEAD'], root)
  return head.ok ? head.stdout : undefined
}

export function currentBranchName(root: string): string {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  return branch.ok ? branch.stdout : ''
}

/** Changed and untracked paths, minus elia's own state under `.elia/`. */
export function dirtyPaths(root: string): string[] {
  const status = git(['status', '--porcelain', '--untracked-files=all'], root)
  if (!status.ok) return []
  return status.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() ?? '')
    .filter((path) => path && !path.startsWith('.elia/'))
}

export function untrackedPaths(root: string): string[] {
  const listed = git(['ls-files', '--others', '--exclude-standard'], root)
  return listed.ok ? listed.stdout.split(/\r?\n/).filter((path) => path && !path.startsWith('.elia/')) : []
}

/**
 * Keeps `.elia/` out of `git status` for this clone only, through
 * `.git/info/exclude` — never the project's own `.gitignore`, which is theirs.
 * Without it every run's journal and receipts would read as uncommitted work.
 */
export function excludeEliaState(root: string): void {
  const gitDir = git(['rev-parse', '--git-common-dir'], root)
  if (!gitDir.ok) return
  const dir = join(root, gitDir.stdout)
  const exclude = join(existsSync(dir) ? dir : gitDir.stdout, 'info', 'exclude')
  try {
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (/^\/?\.elia\/?$/m.test(current)) return
    mkdirSync(join(exclude, '..'), { recursive: true })
    appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}# elia's local run state\n/.elia/\n`)
  } catch {
    // An unwritable exclude file only means .elia/ shows as untracked.
  }
}

export const AUTOPILOT_BRANCH_PREFIX = 'elia/autopilot-'

export function isAutopilotBranch(name: string): boolean {
  return name.startsWith(AUTOPILOT_BRANCH_PREFIX)
}

function requireAutopilotBranch(root: string): void {
  const branch = currentBranchName(root)
  if (!isAutopilotBranch(branch)) {
    throw new Error(`refusing to change git state: the checkout is on "${branch}", not an ${AUTOPILOT_BRANCH_PREFIX}* branch`)
  }
}

export function switchToNewBranch(root: string, name: string): GitResult {
  if (!isAutopilotBranch(name)) throw new Error(`autopilot branches must start with ${AUTOPILOT_BRANCH_PREFIX}`)
  return git(['switch', '-c', name], root)
}

export function switchToBranch(root: string, name: string): GitResult {
  return git(['switch', name], root)
}

/** The operator's own identity when they have one; a plain autopilot identity otherwise. */
function identityArgs(root: string): string[] {
  return git(['config', 'user.email'], root).ok ? [] : ['-c', 'user.name=elia autopilot', '-c', 'user.email=autopilot@elia.local']
}

/**
 * Commits every change on the autopilot branch except paths `exclude` names
 * (secrets). `hooks: false` is only for keeping a rejected attempt on a side
 * ref — an accepted change goes through the project's own commit hooks.
 */
export function commitEverything(
  root: string,
  message: string,
  exclude: (path: string) => boolean,
  options: { hooks?: boolean } = {},
): { committed: boolean; skipped: string[]; sha?: string } {
  requireAutopilotBranch(root)
  const paths = dirtyPaths(root)
  const skipped = paths.filter(exclude)
  const include = paths.filter((path) => !exclude(path))
  if (include.length === 0) return { committed: false, skipped }
  const add = git(['add', '-A', '--', ...include], root)
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`)
  const commit = git([...identityArgs(root), 'commit', '-q', ...(options.hooks === false ? ['--no-verify'] : []), '-m', signCommitMessage(message)], root, 300_000)
  if (!commit.ok) {
    git(['reset', '-q'], root)
    throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).slice(-600)}`)
  }
  return { committed: true, skipped, sha: headSha(root) }
}

/** Points `ref` at the current HEAD, so a rolled-back attempt stays inspectable. */
export function keepRef(root: string, ref: string): boolean {
  return git(['update-ref', ref, 'HEAD'], root).ok
}

/**
 * Returns the autopilot branch to `sha`: tracked files reset, files the attempt
 * created removed. Untracked files that existed before the attempt (`keep`)
 * and ignored files are left alone.
 */
export function rollbackTo(root: string, sha: string, keep: ReadonlySet<string>): void {
  requireAutopilotBranch(root)
  const reset = git(['reset', '-q', '--hard', sha], root)
  if (!reset.ok) throw new Error(`git reset failed: ${reset.stderr}`)
  const created = untrackedPaths(root).filter((path) => !keep.has(path))
  if (created.length > 0) git(['clean', '-q', '-f', '--', ...created], root)
}

/** Files that changed between two commits. */
export function changedFilesBetween(root: string, from: string, to: string): string[] {
  const result = git(['diff', '--name-only', `${from}..${to}`], root)
  return result.ok ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
}

/** A test file by the common conventions: `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, or anything under `test(s)/` or `__tests__/`. */
export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$|(?:^|\/)test_[^/]+\.py$/i.test(path)
}
