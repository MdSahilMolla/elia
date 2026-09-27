import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '../config.ts'
import { MAX_SHELL_OUTPUT_LENGTH, readBoundedOutput } from '../shell.ts'

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
  /** The commit the worktree was cut from. Its changes are measured from here, committed or not. */
  base?: string
}

/** What bringing a worktree's work back into the real tree did. */
export interface MergeReport {
  /** Paths written or deleted in the target, relative to its root. */
  files: string[]
  /** Commits the worktree made on top of its base. */
  commits: number
  /** True when those commits now sit on the target's branch (a fast-forward). */
  commitsCarried: boolean
  /** Why they were not carried, when there were some and they were not. */
  commitsNote?: string
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
export async function runGit(args: string[], cwd?: string, env?: Record<string, string>): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
    // Merged rather than replacing the environment: git still needs PATH, and on
    // Windows it needs the rest of the ambient environment to find its own
    // helpers. Callers pass only the variables they mean to override — notably
    // GIT_INDEX_FILE, which is how a tree can be written out to some other
    // directory without staging anything in the real repository's index.
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    readBoundedOutput(proc.stdout, MAX_SHELL_OUTPUT_LENGTH),
    readBoundedOutput(proc.stderr, MAX_SHELL_OUTPUT_LENGTH),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** Decodes git's C-style escapes inside a quoted porcelain path (`"a\tb"` → `a<TAB>b`). */
function cUnescape(value: string): string {
  const singles: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' }
  return value.replace(/\\([abtnvfr"\\]|[0-7]{3})/g, (_, raw: string) =>
    raw.length === 1 ? singles[raw]! : String.fromCharCode(Number.parseInt(raw, 8)),
  )
}

/** Parses `git status --porcelain=v1` output into the files a copy-based sync needs to touch. */
/** Exported for tests that feed it porcelain directly — its syncs run against a real git repo, but the parser itself is content-only. */
export function parseStatus(porcelain: string): StatusChange[] {
  const changes: StatusChange[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let rawPath = line.slice(3)
    // A rename ("R  old -> new") only needs the destination copied — the
    // source's absence is already implied by it not existing at the new path.
    if (rawPath.includes(' -> ')) rawPath = rawPath.split(' -> ')[1] ?? rawPath
    let path: string
    if (rawPath.startsWith('"')) {
      path = cUnescape(rawPath.slice(1, rawPath.length - 1))
    } else {
      // A raw backslash names a real path on Windows (C:\dir\file.txt) and is
      // not an escape sequence — only quoted paths get C-unescaped.
      path = rawPath.trim()
    }
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

/** elia's own run state never travels between trees: it belongs to the tree that wrote it. */
function isEliaState(path: string): boolean {
  return path === '.elia' || path.startsWith('.elia/')
}

/**
 * Every path a worktree changed since it was cut: tracked files changed by a
 * commit *or* in the working tree (`git diff <base>`), plus each untracked
 * file. Status alone (the old measure) missed two things: anything the work
 * had committed, and the files inside a new directory, which status reports
 * as one `?? dir/` entry that is not a file to copy.
 */
export async function changesSinceBase(worktree: Worktree): Promise<StatusChange[]> {
  if (!worktree.base) {
    const status = await runGit(['status', '--porcelain=v1'], worktree.path)
    return parseStatus(status.stdout).filter((change) => !isEliaState(change.path))
  }
  const changes = new Map<string, StatusChange>()
  const diff = await runGit(['diff', '--name-status', '--no-renames', '-z', worktree.base], worktree.path)
  const fields = diff.stdout.split('\0')
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i]!.trim()
    const path = fields[i + 1]!
    if (code && path && !isEliaState(path)) changes.set(path, { path, deleted: code.startsWith('D') })
  }
  const untracked = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], worktree.path)
  for (const path of untracked.stdout.split('\0')) {
    if (path && !isEliaState(path) && !changes.has(path)) changes.set(path, { path, deleted: false })
  }
  return [...changes.values()]
}

async function copyChanges(fromRoot: string, toRoot: string, changes: StatusChange[]): Promise<string[]> {
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
 * Brings a worktree's work into `targetRoot` — commits included.
 *
 * When the work committed and the target is exactly where the worktree was cut
 * (same HEAD, nothing uncommitted in tracked files), its branch is
 * fast-forwarded, so the commits land as the work made them. Otherwise every
 * change since the base is copied in as uncommitted work, and the report says
 * why the commits themselves did not come along — a caller must never tell
 * the person "committed" when nothing was.
 */
export async function mergeWorktreeBack(worktree: Worktree, targetRoot: string = process.cwd()): Promise<MergeReport> {
  const commits = worktree.base
    ? Number.parseInt((await runGit(['rev-list', '--count', `${worktree.base}..HEAD`], worktree.path)).stdout.trim(), 10) || 0
    : 0
  if (commits > 0 && worktree.base) {
    const head = (await runGit(['rev-parse', 'HEAD'], targetRoot)).stdout.trim()
    const dirty = (await runGit(['status', '--porcelain', '--untracked-files=no'], targetRoot)).stdout.trim()
    let note = head !== worktree.base ? 'the branch moved on while the work ran' : dirty ? 'the working tree had uncommitted changes' : undefined
    if (!note) {
      const forward = await runGit(['merge', '--ff-only', '-q', worktree.branch], targetRoot)
      if (forward.exitCode === 0) {
        const committed = await runGit(['diff', '--name-only', '-z', worktree.base, 'HEAD'], targetRoot)
        const leftovers = await syncDirtyFiles(worktree.path, targetRoot)
        const files = [...new Set([...committed.stdout.split('\0').filter(Boolean), ...leftovers])].filter((path) => !isEliaState(path))
        return { files, commits, commitsCarried: true }
      }
      note = `git refused the fast-forward (${(forward.stderr || forward.stdout).trim().split('\n')[0]})`
    }
    const files = await copyChanges(worktree.path, targetRoot, await changesSinceBase(worktree))
    return { files, commits, commitsCarried: false, commitsNote: note }
  }
  return { files: await copyChanges(worktree.path, targetRoot, await changesSinceBase(worktree)), commits: 0, commitsCarried: false }
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
  const base = (await runGit(['rev-parse', 'HEAD'], path)).stdout.trim() || undefined

  await syncDirtyFiles(sourceRoot, path)
  return { path, branch, ...(base ? { base } : {}) }
}

/** Brings the winning variant's work back into the real working tree (or `targetRoot`, for tests). Returns the files it touched. */
export async function mergeWorktreeIntoCwd(worktree: Worktree, targetRoot: string = process.cwd()): Promise<string[]> {
  return (await mergeWorktreeBack(worktree, targetRoot)).files
}

/**
 * Total lines changed against the worktree's base, for ranking best-of-N
 * variants on something besides cost (see variants.ts): every variant forked
 * from the same base, so this is a fair size comparison across them. Compares
 * against `worktree.base` (the commit it was cut from), not the literal
 * `HEAD` — a variant's work can now include real commits (mergeWorktreeBack
 * fast-forwards them), and `diff HEAD` alone would only see what is still
 * uncommitted, silently scoring committed work as zero churn. `git diff`
 * never sees an untracked file either, so a variant that adds a whole new
 * file would otherwise score as a free, zero-churn change relative to one
 * that only edited existing files — each untracked file's own line count is
 * added in separately to close that gap.
 */
export async function diffChurn(worktree: Worktree): Promise<number> {
  const tracked = await runGit(['diff', '--shortstat', worktree.base ?? 'HEAD'], worktree.path)
  let churn = parseShortstat(tracked.stdout)

  const untrackedFiles = await runGit(['ls-files', '--others', '--exclude-standard'], worktree.path)
  const paths = untrackedFiles.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const path of paths) {
    const content = await Bun.file(join(worktree.path, path)).text().catch(() => '')
    if (content) churn += content.split('\n').length
  }
  return churn
}

/** Parses `git diff --shortstat`'s one-line summary into a single line-churn count. */
function parseShortstat(summary: string): number {
  const insertions = /(\d+) insertion/.exec(summary)?.[1]
  const deletions = /(\d+) deletion/.exec(summary)?.[1]
  return (insertions ? Number.parseInt(insertions, 10) : 0) + (deletions ? Number.parseInt(deletions, 10) : 0)
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
