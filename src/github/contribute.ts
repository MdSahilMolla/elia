import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { stateDir, paths } from '../statePaths.ts'
import { writeSecureFile } from '../securePersistence.ts'
import { withFileLock } from '../fileLock.ts'
import type { ExecResult } from './exec.ts'

/**
 * Contributing to a repository that is not this project's.
 *
 * This exists because of a session on 2026-09-20. Asked to fix an issue in
 * pallets/click, elia cloned the repo into its *own* checkout root, edited it,
 * ran click's test suite, got a real fix — and then committed the whole dirty
 * working tree of elia's repo under a message describing the click fix, added
 * the clone as a stray gitlink, and finally reset the clone, destroying the
 * only copy of the work. Nothing reached GitHub. The engineering was right and
 * every step around it was wrong, and the lesson elia wrote for itself
 * afterwards named the missing workflow exactly: fork, branch, push to the
 * fork, open the PR upstream — a local fix that gets reverted is not a
 * contribution.
 *
 * So the workflow is code, not advice:
 *
 *   1. the clone lands under `workspace/` — which elia's own .gitignore
 *      excludes, so `git add -A` in elia's repo cannot sweep it in even if
 *      something else goes wrong;
 *   2. `origin` is the fork and `upstream` is the source, with upstream's push
 *      URL disabled, so a push cannot reach a repo the user does not own;
 *   3. every step is recorded in `.elia/contributions.json`, so a later
 *      session (or `elia compounding`) can see that a contribution exists and
 *      whether it ever became a pull request;
 *   4. the record is what makes "reverted without contributing" visible at
 *      all — it is the difference between work and a story about work.
 */

export type ContributionStatus = 'cloned' | 'branched' | 'committed' | 'pushed' | 'pr_open' | 'merged' | 'abandoned'

export interface Contribution {
  /** The upstream repository being contributed to, `owner/repo`. */
  slug: string
  /** The fork the branch is pushed to, `viewer/repo`. Absent when the viewer can push to `slug` directly. */
  forkSlug?: string
  /** Absolute path of the local clone. */
  dir: string
  /** Upstream's default branch — the base a pull request targets. */
  defaultBranch: string
  /** The working branch inside the clone. */
  branch?: string
  /** The upstream issue this is fixing, when the work started from one. */
  issue?: number
  status: ContributionStatus
  prUrl?: string
  prNumber?: number
  /**
   * What was actually run in the clone to check the change, and what it said.
   * A contribution with no verification line is an untested patch, and saying
   * so is the point.
   */
  verified?: string
  startedAt: number
  updatedAt: number
}

export const CONTRIBUTIONS_PATH = join(stateDir, 'contributions.json')

let pathOverride: string | undefined

/**
 * Test-only: point the record at a temporary file. Without it a test that
 * starts a contribution writes into the real `.elia/contributions.json`, and
 * the tool then refuses commits in this very checkout because it believes an
 * external contribution is open. Pass nothing to restore.
 */
export function setContributionsPathForTests(path?: string): void {
  pathOverride = path
}

function statePath(path?: string): string {
  return path ?? pathOverride ?? CONTRIBUTIONS_PATH
}

/** GitHub's own owner/repo charset, minus anything that could be read as a flag by argv-based git/gh. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface RepoRef {
  slug: string
  owner: string
  repo: string
  issue?: number
}

/**
 * Reads the many ways a person names a GitHub repository or issue into one
 * shape: `owner/repo`, `owner/repo#12`, a web URL for the repo, an issue or a
 * pull request, or an ssh/https clone URL. Returns undefined rather than
 * guessing — the caller reports what it could not read, so a typo surfaces
 * instead of a clone of the wrong project.
 */
export function parseRepoRef(input: string): RepoRef | undefined {
  const text = input.trim()
  if (!text) return undefined

  let owner: string | undefined
  let repo: string | undefined
  let issue: number | undefined

  const url = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(issues|pull)\/(\d+))?/i)
  const ssh = text.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i)
  const bare = text.match(/^([^/\s#]+)\/([^/\s#]+?)(?:\.git)?(?:#(\d+))?$/)

  if (url) {
    owner = url[1]
    repo = url[2]?.replace(/\.git$/i, '')
    if (url[4]) issue = Number.parseInt(url[4], 10)
  } else if (ssh) {
    owner = ssh[1]
    repo = ssh[2]
  } else if (bare) {
    owner = bare[1]
    repo = bare[2]
    if (bare[3]) issue = Number.parseInt(bare[3], 10)
  }

  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return undefined
  return { slug: `${owner}/${repo}`, owner, repo, ...(issue !== undefined && Number.isFinite(issue) ? { issue } : {}) }
}

/**
 * Where a clone of `repo` goes.
 *
 * Under the scratch workspace when that sits inside the directory elia is
 * working in — the one place the model is already told to put standalone
 * projects, and the one place elia's own .gitignore excludes. An isolated task
 * workspace is its own root and the shared scratch folder is outside it, so
 * there the clone goes directly under the task root instead of reaching up.
 *
 * A second contribution to a different owner's repo of the same name gets
 * `owner-repo`, so `pallets/click` and `someone-else/click` cannot land on top
 * of each other.
 */
export function contributionDirFor(
  ref: RepoRef,
  options: { cwd: string; workspace?: string; taken?: readonly string[] } = { cwd: process.cwd() },
): string {
  const cwd = resolve(options.cwd)
  const workspace = resolve(options.workspace ?? paths.workspace)
  const inside = workspace === cwd || !relative(cwd, workspace).startsWith('..')
  const base = inside ? workspace : cwd
  const plain = join(base, ref.repo)
  const taken = (options.taken ?? []).map((path) => resolve(path))
  const isFree = !taken.includes(plain) && !existsSync(plain)
  return isFree ? plain : join(base, `${ref.owner}-${ref.repo}`)
}

interface ContributionFile {
  version: 1
  contributions: Contribution[]
}

function lockPath(path: string): string {
  return `${path}.lock`
}

export function readContributions(path?: string): Contribution[] {
  try {
    const parsed = JSON.parse(readFileSync(statePath(path), 'utf8')) as ContributionFile
    return Array.isArray(parsed?.contributions) ? parsed.contributions : []
  } catch {
    return []
  }
}

/**
 * Writes one contribution, merging it over any existing record for the same
 * repository. Several elia processes share one checkout (and one state
 * directory), so the read-modify-write is taken under the same advisory lock
 * every other shared ledger uses.
 */
export function saveContribution(next: Contribution, pathInput?: string): Contribution {
  const path = statePath(pathInput)
  return withFileLock(lockPath(path), () => {
    const all = readContributions(path)
    const index = all.findIndex((row) => row.slug === next.slug && row.dir === next.dir)
    const merged: Contribution = { ...(index >= 0 ? all[index] : {}), ...next, updatedAt: Date.now() }
    if (index >= 0) all[index] = merged
    else all.push(merged)
    writeSecureFile(path, `${JSON.stringify({ version: 1, contributions: all } satisfies ContributionFile, null, 2)}\n`)
    return merged
  })
}

/** Contributions that have not reached a maintainer's decision yet. */
export function openContributions(path?: string): Contribution[] {
  return readContributions(statePath(path)).filter((row) => row.status !== 'merged' && row.status !== 'abandoned')
}

/** The contribution whose clone contains `dir`, if any — so a tool call can tell which repo it is standing in. */
export function contributionForDir(dir: string, path?: string): Contribution | undefined {
  const target = resolve(dir)
  return readContributions(statePath(path)).find((row) => {
    const root = resolve(row.dir)
    if (root === target) return true
    const rel = relative(root, target)
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
  })
}

export function findContribution(slug: string, path?: string): Contribution | undefined {
  return readContributions(statePath(path)).find((row) => row.slug.toLowerCase() === slug.toLowerCase())
}

/**
 * The reason to refuse a sweeping commit.
 *
 * `github commit all:true` is `git add -A`: everything in the working tree,
 * including work this turn never touched. That is how a click fix became a
 * commit full of someone else's uncommitted files. When an external
 * contribution is open in a *different* directory, a sweep here is never what
 * was meant — so it is refused, with the call that was meant instead. Naming
 * `paths`, or committing inside the clone, both still work: this closes the one
 * shape that has never once been correct.
 */
export function sweepBlockedBy(
  dir: string,
  contributions: readonly Contribution[],
  options: { now?: number; maxAgeMs?: number } = {},
): Contribution | undefined {
  const here = resolve(dir)
  const now = options.now ?? Date.now()
  // Bounded on purpose. A contribution that already has a pull request has been
  // delivered, and one nobody has touched for a fortnight is a leftover record —
  // neither is evidence about what the commit happening right now is for. Left
  // unbounded, one abandoned record would refuse every sweeping commit in this
  // project forever, and a guard people have to route around stops being one.
  const window = options.maxAgeMs ?? 14 * 24 * 60 * 60 * 1000
  return contributions.find((row) => {
    if (row.prUrl) return false
    if (now - row.updatedAt > window) return false
    const root = resolve(row.dir)
    const rel = relative(root, here)
    const inside = root === here || (Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel))
    return !inside
  })
}

export type Run = (args: string[], cwd?: string, timeoutMs?: number) => Promise<ExecResult>

function parseJson<T>(result: ExecResult): T | undefined {
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    return undefined
  }
}

interface RepoView {
  nameWithOwner: string
  defaultBranchRef?: { name: string } | null
  viewerPermission?: string | null
  isFork?: boolean
  isArchived?: boolean
  parent?: { nameWithOwner: string } | null
}

/** Permissions that let a branch be pushed straight to the repository, making a fork unnecessary. */
const CAN_PUSH = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

/**
 * Makes the clone invisible to the repository it sits inside.
 *
 * Under `workspace/` elia's own .gitignore already does this, but a clone in an
 * isolated task root, or in some other project's checkout, is not covered by
 * anything. So the path is added to that repository's `.git/info/exclude`: a
 * local ignore, never committed, never shown in the project's own .gitignore,
 * and enough that a later `git add -A` by any tool — this one, a per-wave
 * commit, a person at a terminal — cannot pick the clone up. The guard in the
 * commit path stays as well; this is the layer underneath it.
 */
async function hideFromHostRepo(dir: string, host: string, git: Run): Promise<void> {
  const rel = relative(resolve(host), resolve(dir)).split('\\').join('/')
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
  const inRepo = await git(['rev-parse', '--git-dir'], host)
  if (!inRepo.ok) return
  const already = await git(['check-ignore', '-q', rel], host)
  if (already.ok) return
  const gitDir = inRepo.stdout.trim()
  const excludeFile = join(isAbsolute(gitDir) ? gitDir : join(host, gitDir), 'info', 'exclude')
  try {
    mkdirSync(dirname(excludeFile), { recursive: true })
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    if (existing.split(/\r?\n/).some((line) => line.trim() === `/${rel}/`)) return
    appendFileSync(excludeFile, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}# a clone of another project, added by elia\n/${rel}/\n`)
  } catch {
    // Not fatal: the commit-path guard still refuses to sweep it.
  }
}

export interface StartOptions {
  ref: string
  git: Run
  gh: Run
  cwd: string
  workspace?: string
  /** Branch name to work on. Defaults to `fix/issue-<n>` when an issue was named. */
  branch?: string
  statePath?: string
  /** A slow network clone is normal; the default exec timeout is not built for it. */
  cloneTimeoutMs?: number
}

export interface StartResult {
  contribution?: Contribution
  report: string
}

/**
 * Fork, clone and branch, in the order that makes the later steps safe.
 *
 * Idempotent on purpose: a session that dies after the clone can call this
 * again and get the same directory back rather than a second copy beside it.
 */
export async function startContribution(options: StartOptions): Promise<StartResult> {
  const { ref: rawRef, git, gh, cwd } = options
  const state = statePath(options.statePath)
  const ref = parseRepoRef(rawRef)
  if (!ref) {
    return { report: `Could not read "${rawRef}" as a GitHub repository. Use owner/repo, owner/repo#123, or a github.com URL for the repo, an issue, or a pull request.` }
  }

  const view = parseJson<RepoView>(await gh(['repo', 'view', ref.slug, '--json', 'nameWithOwner,defaultBranchRef,viewerPermission,isFork,isArchived,parent']))
  if (!view?.nameWithOwner) {
    return { report: `Could not read ${ref.slug} from GitHub. Check the name, and that \`gh\` is authenticated (\`gh auth status\`).` }
  }
  if (view.isArchived) {
    return { report: `${view.nameWithOwner} is archived — it accepts no pull requests. Nothing to contribute to here.` }
  }

  // A fork's own issues are almost never the ones worth fixing; the parent is
  // where the code and the maintainers are.
  const slug = view.nameWithOwner
  const defaultBranch = view.defaultBranchRef?.name ?? 'main'
  const canPushDirectly = CAN_PUSH.has((view.viewerPermission ?? '').toUpperCase())

  let forkSlug: string | undefined
  if (!canPushDirectly) {
    const login = (await gh(['api', 'user', '--jq', '.login'])).stdout.trim()
    if (!login) return { report: 'Could not determine the authenticated GitHub account (`gh api user` returned nothing). Run `gh auth login` first.' }
    const fork = await gh(['repo', 'fork', slug, '--clone=false', '--default-branch-only'])
    // `gh repo fork` exits non-zero on some "already exists" paths and zero on
    // others; the fork's existence is the fact that matters, so it is checked
    // rather than inferred from the exit code.
    const candidate = `${login}/${ref.repo}`
    const forkView = parseJson<RepoView>(await gh(['repo', 'view', candidate, '--json', 'nameWithOwner,parent']))
    if (!forkView?.nameWithOwner) {
      return { report: `Could not fork ${slug} to ${login}: ${fork.stderr || fork.stdout || 'the fork does not exist afterwards'}` }
    }
    forkSlug = forkView.nameWithOwner
  }

  const existing = findContribution(slug, state)
  const dir = existing?.dir ?? contributionDirFor({ ...ref, slug }, { cwd, workspace: options.workspace, taken: readContributions(state).map((row) => row.dir) })
  const cloneUrl = `https://github.com/${forkSlug ?? slug}.git`

  const alreadyCloned = existsSync(join(dir, '.git'))
  if (!alreadyCloned) {
    const clone = await git(['clone', cloneUrl, dir], cwd, options.cloneTimeoutMs ?? 300_000)
    if (!clone.ok) return { report: `Could not clone ${cloneUrl} into ${dir}: ${clone.stderr || clone.stdout}` }
  }
  await hideFromHostRepo(dir, cwd, git)

  if (forkSlug) {
    const remotes = (await git(['remote'], dir)).stdout.split(/\r?\n/).map((line) => line.trim())
    if (!remotes.includes('upstream')) {
      await git(['remote', 'add', 'upstream', `https://github.com/${slug}.git`], dir)
    } else {
      await git(['remote', 'set-url', 'upstream', `https://github.com/${slug}.git`], dir)
    }
    // Structural, not advisory: with no usable push URL, a `git push upstream`
    // cannot reach a repository the user does not own, however it is invoked.
    await git(['remote', 'set-url', '--push', 'upstream', 'DISABLED-push-to-origin-instead'], dir)
  }

  const branch = options.branch ?? (ref.issue !== undefined ? `fix/issue-${ref.issue}` : `elia/${defaultBranch}-fix`)
  if (!NAME.test(branch.split('/')[0] ?? '')) return { report: `Refusing branch name "${branch}".` }
  const existingBranch = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir)
  const checkout = existingBranch.ok ? await git(['checkout', branch], dir) : await git(['checkout', '-b', branch], dir)
  const onBranch = checkout.ok

  const contribution = saveContribution(
    {
      slug,
      ...(forkSlug ? { forkSlug } : {}),
      dir,
      defaultBranch,
      ...(onBranch ? { branch } : {}),
      ...(ref.issue !== undefined ? { issue: ref.issue } : {}),
      status: onBranch ? 'branched' : 'cloned',
      startedAt: existing?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    },
    state,
  )

  return { contribution, report: renderStartReport(contribution, { alreadyCloned, canPushDirectly, checkoutError: onBranch ? undefined : checkout.stderr || checkout.stdout }) }
}

function renderStartReport(
  contribution: Contribution,
  context: { alreadyCloned: boolean; canPushDirectly: boolean; checkoutError?: string },
): string {
  const short = `dir: "${contribution.dir}"`
  const lines = [
    `${context.alreadyCloned ? 'Reusing the existing clone of' : 'Ready to contribute to'} ${contribution.slug}.`,
    `  clone: ${contribution.dir}${context.alreadyCloned ? ' (already there)' : ''}`,
    context.canPushDirectly
      ? `  remotes: origin = ${contribution.slug} — you have push access, so no fork was made`
      : `  remotes: origin = ${contribution.forkSlug} (your fork, push here) · upstream = ${contribution.slug} (read-only, push disabled)`,
    `  branch: ${contribution.branch ?? '(not created)'} off ${contribution.defaultBranch}`,
    contribution.issue !== undefined ? `  issue: ${contribution.slug}#${contribution.issue}` : '',
    context.checkoutError ? `  branch failed: ${context.checkoutError}` : '',
    '',
    'From here, every tool call must name that directory — this is a different repository from the one you are running in:',
    `  · read/edit files under ${contribution.dir}`,
    `  · run_command with cwd: "${contribution.dir}" for its tests, linters and build`,
    `  · github commit ${short} paths: [...] — only the files you changed`,
    `  · github push ${short} — goes to ${contribution.forkSlug ?? 'origin'}`,
    `  · github pr_create ${short} repo: "${contribution.slug}" — opens the pull request upstream`,
    '',
    'Reproduce the problem first (a failing test if the project has a suite), then fix it, then run that project\'s own checks. The pull request is the deliverable: a fix that stays local, or gets reverted, is not a contribution.',
  ]
  return lines.filter(Boolean).join('\n')
}

export interface PrOptions {
  contribution: Contribution
  title: string
  body?: string
  draft?: boolean
  gh: Run
  git: Run
  statePath?: string
}

/**
 * Opens the pull request on the upstream repository, from the fork's branch.
 *
 * A cross-repository PR needs `--repo upstream` and an owner-qualified
 * `--head`; without both, `gh pr create` run inside a fork opens the PR against
 * the *fork's* default branch, which looks like success and reaches no
 * maintainer. That mistake is invisible in the output, so it is not left to
 * argument order.
 */
export async function openContributionPr(options: PrOptions): Promise<string> {
  const { contribution, gh, git } = options
  const state = statePath(options.statePath)
  if (!contribution.branch) return 'This contribution has no branch yet — create one before opening a pull request.'

  const ahead = await git(['rev-list', '--count', `${contribution.defaultBranch}..${contribution.branch}`], contribution.dir)
  if (ahead.ok && ahead.stdout.trim() === '0') {
    return `The branch ${contribution.branch} has no commits that ${contribution.defaultBranch} does not. There is nothing to propose — commit the fix first.`
  }

  const push = await git(['push', '-u', 'origin', contribution.branch], contribution.dir, 120_000)
  if (!push.ok) return `Could not push ${contribution.branch} to origin (${contribution.forkSlug ?? 'origin'}): ${push.stderr || push.stdout}`
  saveContribution({ ...contribution, status: 'pushed' }, state)

  const head = contribution.forkSlug ? `${contribution.forkSlug.split('/')[0]}:${contribution.branch}` : contribution.branch
  const body = [
    options.body ?? '',
    // Maintainers ask "did you run the tests" on nearly every drive-by patch.
    // The answer is already recorded, so it travels with the request.
    contribution.verified ? `\n\nVerified with: ${contribution.verified}` : '',
    contribution.issue !== undefined ? `\n\nFixes #${contribution.issue}` : '',
  ].join('').trim()
  const args = [
    'pr', 'create',
    '--repo', contribution.slug,
    '--head', head,
    '--base', contribution.defaultBranch,
    '--title', options.title,
    '--body', body || options.title,
  ]
  if (options.draft) args.push('--draft')
  const created = await gh(args)
  if (!created.ok) return `Could not open the pull request on ${contribution.slug}: ${created.stderr || created.stdout}`

  const url = created.stdout.trim().split(/\s+/).find((token) => token.startsWith('http')) ?? created.stdout.trim()
  const number = Number.parseInt(url.match(/\/pull\/(\d+)/)?.[1] ?? '', 10)
  saveContribution({ ...contribution, status: 'pr_open', prUrl: url, ...(Number.isFinite(number) ? { prNumber: number } : {}) }, state)
  return [
    `Opened a pull request on ${contribution.slug} from ${head} → ${contribution.defaultBranch}:`,
    url,
    contribution.verified ? '' : 'No verification is recorded for this contribution — pass `verified` with the check you ran, so the record and the request both say how it was tested.',
  ].filter(Boolean).join('\n')
}

/** Refreshes the merged/closed state of recorded pull requests from GitHub. */
export async function refreshContribution(contribution: Contribution, gh: Run, statePathInput?: string): Promise<Contribution> {
  const state = statePath(statePathInput)
  if (contribution.prNumber === undefined) return contribution
  const view = parseJson<{ state?: string; url?: string }>(
    await gh(['pr', 'view', String(contribution.prNumber), '--repo', contribution.slug, '--json', 'state,url']),
  )
  const prState = (view?.state ?? '').toUpperCase()
  if (prState === 'MERGED') return saveContribution({ ...contribution, status: 'merged' }, state)
  if (prState === 'CLOSED') return saveContribution({ ...contribution, status: 'abandoned' }, state)
  return contribution
}

export function renderContributions(rows: readonly Contribution[]): string {
  if (rows.length === 0) {
    return 'No external contributions recorded. Start one with github action "contribute" and the repo or issue (e.g. ref: "pallets/click#3652").'
  }
  const lines: string[] = []
  for (const row of rows) {
    lines.push(`${row.slug}${row.issue !== undefined ? `#${row.issue}` : ''} — ${row.status}`)
    lines.push(`  clone: ${row.dir}${row.branch ? ` · branch ${row.branch}` : ''}`)
    if (row.forkSlug) lines.push(`  fork: ${row.forkSlug} (origin)`)
    if (row.verified) lines.push(`  verified: ${row.verified}`)
    if (row.prUrl) lines.push(`  pull request: ${row.prUrl}`)
    else if (row.status === 'committed' || row.status === 'pushed') lines.push('  no pull request yet — the contribution is not delivered until there is one')
  }
  return lines.join('\n')
}

/**
 * The one line about contributions that belongs in `elia compounding`.
 *
 * A maintainer merging a patch is the strongest check elia's records can hold:
 * an outside party, with no stake in elia looking good, accepted the work. It
 * is reported separately from the six stages rather than folded into one,
 * because it measures capability in the field, not the loop that changes elia.
 */
export function renderContributionEvidence(rows: readonly Contribution[]): string | undefined {
  if (rows.length === 0) return undefined
  const merged = rows.filter((row) => row.status === 'merged')
  const open = rows.filter((row) => row.status === 'pr_open')
  const stalled = rows.filter((row) => row.status === 'cloned' || row.status === 'branched' || row.status === 'committed' || row.status === 'pushed')
  const lines = [
    'Field contributions — work on repositories elia does not own',
    '',
    `  ${rows.length} started · ${merged.length + open.length} proposed upstream · ${merged.length} merged by a maintainer`,
  ]
  for (const row of merged) lines.push(`  ● ${row.slug}#${row.prNumber ?? '?'} merged — ${row.verified ?? 'no verification recorded'}`)
  for (const row of open) lines.push(`  ◐ ${row.slug}#${row.prNumber ?? '?'} open — ${row.prUrl ?? ''}`)
  for (const row of stalled) lines.push(`  ○ ${row.slug} stopped at "${row.status}" — no pull request, so nothing was contributed`)
  return lines.join('\n')
}
