import type { Tool } from './types.ts'
import { currentAgent, resolveProjectPath } from '../autonomy/context.ts'
import { execCapture, type ExecResult } from '../github/exec.ts'
import { detectGitHubContext, renderGitHubBanner } from '../github/context.ts'
import { isSensitivePath } from '../autonomy/sensitivePaths.ts'
import {
  contributionForDir,
  openContributionPr,
  openContributions,
  readContributions,
  refreshContribution,
  renderContributions,
  saveContribution,
  startContribution,
  sweepBlockedBy,
} from '../github/contribute.ts'
import { clampOutput } from '../shell.ts'
import { signCommitMessage } from '../provenance.ts'

/**
 * elia's hands on GitHub: branch, commit, push, open and inspect pull
 * requests, comment, merge — one tool instead of a pile of raw `git`/`gh`
 * lines in run_command.
 *
 * Why a dedicated tool and not just run_command:
 * - The multi-step flows (stage → commit, push → open PR) are single actions
 *   here, so the model can't half-finish one.
 * - It runs `git`/`gh` argv-directly (github/exec.ts), so a commit message or
 *   PR body full of shell metacharacters is just text, never a second command.
 * - The governor gives each action its own risk contract (autonomy/governor.ts):
 *   status/inspection is free, branch/commit/push-a-feature-branch is review,
 *   force-push, PR comments, and merges are critical.
 */

type Action =
  | 'status' | 'branch' | 'commit' | 'push' | 'contribute' | 'contribute_status' | 'sync'
  | 'pr_create' | 'pr_view' | 'pr_list' | 'pr_checks' | 'pr_checks_log' | 'pr_reviews' | 'pr_unresolved_reviews' | 'pr_comment' | 'pr_merge'
  | 'issue_list' | 'issue_view' | 'issue_create'

// Git ref-name-safe charset (letters, digits, `.`, `_`, `/`, `-`), first
// character alphanumeric so a leading `-` can never be read as a flag by
// git's argv-based parser, plus a ban on `..` (git's own path-traversal /
// range-syntax escape). Deliberately conservative vs. the full
// `git check-ref-format` grammar — anything a real branch name needs still
// passes; anything that looks like a flag or an escape does not.
const REF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * Validates a user-supplied git ref/branch name before it is placed in an
 * argv array built for direct (non-shell) exec. `exec.ts` spawns argv
 * directly, so this isn't shell injection — but since these actions are
 * auto-approved by the governor with no human review, an unvalidated value
 * like `--orphan` or `-x` would be interpreted as a git flag instead of a
 * ref name, silently changing what the command does. Fails loud rather than
 * silently stripping/sanitizing, so a legitimate need surfaces instead of a
 * mutated ref being created quietly.
 */
function validateRefName(value: string, label: string): string {
  if (value.startsWith('-')) {
    throw new Error(`invalid ${label}: must not start with '-' (would be interpreted as a flag)`)
  }
  if (!REF_NAME_PATTERN.test(value) || value.includes('..')) {
    throw new Error(`invalid ${label}: must not start with '-' and may only contain letters, digits, and ./_- characters (no '..')`)
  }
  return value
}

/**
 * Takes back out of the index the two kinds of file a commit must never carry,
 * and says which they were.
 *
 * Secrets, because a commit is one push away from permanent and public, and a
 * working directory with a live `.env` in it is what a working directory looks
 * like. The autonomous loop has refused these since scaffold.ts was written;
 * this tool did not, and it is the one a person drives.
 *
 * Nested git repositories, because `git add -A` turns a clone sitting inside
 * the tree into a gitlink — a one-line commit entry pointing at a commit hash
 * in a repository nobody else has, with no .gitmodules to resolve it. Anyone
 * cloning afterwards gets an empty directory git refuses to fill. That is
 * exactly what happened to a clone of pallets/click on 2026-09-20, and unlike a
 * misjudged file it is never intentional: a real submodule has a .gitmodules
 * entry, and this only unstages links that do not.
 */
async function unstageWhatMustNotBeCommitted(git: (args: string[]) => Promise<ExecResult>): Promise<string[]> {
  const raw = await git(['diff', '--cached', '--raw'])
  if (!raw.ok) return []
  const declared = await git(['config', '--file', '.gitmodules', '--get-regexp', 'path'])
  const submodulePaths = new Set(
    declared.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).slice(1).join(' ').trim())
      .filter(Boolean),
  )

  const notes: string[] = []
  for (const line of raw.stdout.split(/\r?\n/)) {
    // :<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>
    const match = line.match(/^:(\d{6}) (\d{6}) \S+ \S+ [A-Z]\d*\t(.+)$/)
    if (!match) continue
    const newMode = match[2]!
    const path = match[3]!.replace(/^"|"$/g, '')
    const isGitlink = newMode === '160000' && !submodulePaths.has(path)
    const isSecret = isSensitivePath(path)
    if (!isGitlink && !isSecret) continue
    await git(['reset', '--quiet', '--', path])
    notes.push(
      isSecret
        ? `${path} (looks like it holds secrets)`
        : `${path} (its own git repository, not part of this project — commit inside ${path} instead, with dir:"${path}")`,
    )
  }
  return notes
}

function fail(result: ExecResult): string {
  if (result.missing) return `${result.stderr}. Install and authenticate the GitHub CLI (\`gh auth login\`) to use this action.`
  if (/no pull requests found|no open pull requests/i.test(result.stderr)) return 'No open pull request for the current branch. Open one with action "pr_create".'
  if (/gh auth login|authentication required|not logged in/i.test(result.stderr)) return 'The gh CLI is not authenticated. Ask the user to run `gh auth login`.'
  return `Failed (exit ${result.exitCode}):\n${result.stderr || result.stdout || '(no output)'}`
}

export const githubTool: Tool = {
  name: 'github',
  description:
    `Work with git and GitHub: branch, commit, push, and manage pull requests. Prefer this over raw git/gh in run_command — it handles the multi-step flows and is safe with arbitrary commit/PR text.

Every action takes an optional { dir } naming which checkout to act on — a path, or the short name of a project under the workspace ("click"). Omit it for this project. When you are working on a repository you cloned, you MUST pass dir on every call, or the commit lands in this project instead.

Actions:
- status: where this repo stands with GitHub — remote, gh auth, current branch vs upstream, any open PR. Start here.
- contribute: the whole setup for fixing something in a repository that is not yours — forks it to your account, clones the fork under the workspace, wires upstream read-only, and branches. { ref } where ref is "owner/repo", "owner/repo#123", or any github.com repo/issue/PR URL; optional { name } for the branch. Use this instead of cloning by hand: it is what makes the later push and PR go to the right repositories.
- contribute_status: every external contribution on record and where it stands (clone, branch, commit, push, PR, merged).
- branch: create and switch to a branch. { name, from?, dir? }
- commit: stage and commit. { message, paths?, all?, verified? } — prefer paths: ["src/a.ts"] so the commit contains only what you changed; all:true sweeps the entire working tree and is refused while an external contribution is open elsewhere. Files that look like secrets, and nested clones, are never staged. In a contribution clone, pass verified with the check you ran.
- push: push the current branch. In a contribution clone this goes to your fork, never upstream. { force?, dir? } — force needs approval.
- sync: fetch the upstream repository and report how far behind the branch is; { rebase: true } rebases onto it. Use before opening a PR on a repo that moves fast.
- pr_create: open a pull request. For your own project: { title, body?, base?, draft? }. For a contribution: pass { repo: "owner/repo", dir } and it opens the PR on that upstream repo from your fork's branch, with "Fixes #N" when the work started from an issue.
- pr_view: show a PR (defaults to the current branch's). { number? }
- pr_list: list open pull requests. { limit? }
- pr_checks: CI / status-check results for a PR. { number? }
- pr_checks_log: like pr_checks, but for any check that is currently failing, also fetches that run's actual failing-step log — use this instead of pr_checks when a check has failed and you need to see why, not just that it did. { number? }
- pr_reviews: review comments and discussion on a PR (for addressing feedback). { number? }
- pr_unresolved_reviews: only the review-comment threads that are still unresolved — use this instead of pr_reviews when the goal is to work through outstanding feedback one thread at a time. { number? }
- pr_comment: add a comment to a PR. { number, body } — needs approval.
- pr_merge: merge a PR. { number, method? one of merge|squash|rebase } — needs approval.
- issue_list: list open issues (intake for autonomous work). { limit?, label?, repo? } — repo:"owner/repo" reads another project's issues without cloning it.
- issue_view: show one issue. { number, repo? }
- issue_create: open an issue. { title, body? } — needs review approval.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'status', 'branch', 'commit', 'push', 'contribute', 'contribute_status', 'sync',
          'pr_create', 'pr_view', 'pr_list', 'pr_checks', 'pr_checks_log', 'pr_reviews', 'pr_unresolved_reviews', 'pr_comment', 'pr_merge',
          'issue_list', 'issue_view', 'issue_create',
        ],
      },
      dir: { type: 'string', description: 'Which checkout to act on: a path, or the short name of a project under the workspace (e.g. "click"). Defaults to this project.' },
      ref: { type: 'string', description: 'contribute: the repository or issue to contribute to — "owner/repo", "owner/repo#123", or a github.com URL' },
      repo: { type: 'string', description: 'pr_create / issue_list / issue_view: act on this "owner/repo" instead of the current checkout\'s remote' },
      name: { type: 'string', description: 'branch: the new branch name. contribute: the branch to work on' },
      from: { type: 'string', description: 'branch: base ref to branch from (default: current HEAD)' },
      message: { type: 'string', description: 'commit: the commit message' },
      paths: { type: 'array', items: { type: 'string' }, description: 'commit: only these files/directories (repo-relative) — the scoped commit to prefer over all:true' },
      verified: { type: 'string', description: 'commit / pr_create in a contribution clone: the check you actually ran and what it said (e.g. "pytest tests/ — 2412 passed, 1 skipped"). Recorded with the contribution and quoted in the pull request.' },
      all: { type: 'boolean', description: 'commit: stage every change in the working tree, including untracked files' },
      rebase: { type: 'boolean', description: 'sync: rebase the current branch onto the upstream default branch' },
      force: { type: 'boolean', description: 'push: force-push (requires approval)' },
      title: { type: 'string', description: 'pr_create / issue_create: title' },
      body: { type: 'string', description: 'pr_create / pr_comment / issue_create: body text' },
      base: { type: 'string', description: 'pr_create: base branch (default: the repo default branch)' },
      draft: { type: 'boolean', description: 'pr_create: open as a draft' },
      number: { type: 'number', description: 'pr_* / issue_view: the PR or issue number' },
      method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'pr_merge: merge strategy (default: merge)' },
      limit: { type: 'number', description: 'pr_list / issue_list: max items (default 20, max 50)' },
      label: { type: 'string', description: 'issue_list: filter by label' },
    },
    required: ['action'],
  },
  async execute(input) {
    const { cwd, signal } = currentAgent()
    const base = cwd ?? process.cwd()
    const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
    // A second repository on disk is the normal case once elia contributes to
    // anything: `dir` is how a commit reaches the clone instead of this
    // project. Resolved the way run_command and preview resolve theirs, so
    // dir:"click" means the same folder to all three — and bounded the same
    // way, because "which repo am I in" must not become "any repo on the disk".
    let dir = base
    if (str('dir')) {
      try {
        dir = resolveProjectPath(str('dir'), base)
      } catch {
        return `Cannot act on "${str('dir')}": it is outside the directory elia is working in (${base}). Clone the repository under the workspace — github action "contribute" does that — and name it from there.`
      }
    }
    const action = input.action as Action
    const git = (args: string[], at: string = dir, timeoutMs?: number) => execCapture('git', args, at, signal, timeoutMs)
    const gh = (args: string[], at: string = dir, timeoutMs?: number) => execCapture('gh', args, at, signal, timeoutMs)
    const strings = (key: string): string[] =>
      Array.isArray(input[key]) ? (input[key] as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []
    /** `--repo owner/repo` when the model named one, so a read or a PR can target another project. */
    const repoArgs = (): string[] => (str('repo') ? ['--repo', str('repo')] : [])

    if (action === 'status') {
      const context = await detectGitHubContext(dir, { signal, force: true, remote: true })
      if (!context.isRepo) return 'Not a git repository.'
      const lines = [renderGitHubBanner(context) || `local git repo${context.hasRemote ? '' : ' with no origin remote'}`]
      const aheadBehind = context.aheadBehindUnknown ? 'ahead/behind unrecognized (unexpected git output)' : `${context.ahead} ahead, ${context.behind} behind upstream`
      lines.push(`  branch: ${context.currentBranch ?? '(detached)'}${context.hasUpstream ? ` · ${aheadBehind}` : ' · no upstream set'}`)
      lines.push(`  working tree: ${context.dirty ? 'has uncommitted changes' : 'clean'}`)
      if (context.slug) lines.push(`  remote: ${context.slug}${context.defaultBranch ? ` (default branch ${context.defaultBranch})` : ''}`)
      lines.push(`  gh CLI: ${!context.ghInstalled ? 'not installed' : context.ghAuthUnknown ? 'auth status unrecognized (run `gh auth status` manually)' : context.ghAuthenticated ? `authenticated${context.ghUser ? ` as ${context.ghUser}` : ''}` : 'installed but not authenticated (run: gh auth login)'}`)
      if (context.openPr) lines.push(`  open PR: #${context.openPr.number} ${context.openPr.isDraft ? '(draft) ' : ''}${context.openPr.title} — ${context.openPr.url}`)
      return lines.join('\n')
    }

    if (action === 'branch') {
      const name = str('name')
      if (!name) return 'branch needs "name".'
      validateRefName(name, 'name')
      const args = ['checkout', '-b', name]
      if (str('from')) args.push(validateRefName(str('from'), 'from'))
      const result = await git(args)
      return result.ok ? `Created and switched to branch "${name}".` : fail(result)
    }

    if (action === 'commit') {
      const message = str('message')
      if (!message) return 'commit needs "message".'
      const scope = strings('paths')
      for (const path of scope) {
        if (path.startsWith('-')) return `invalid path "${path}": must not start with '-'.`
      }

      // The one sweep that has never been correct. On 2026-09-20 a commit like
      // this one, run in elia's own checkout while the actual work was in a
      // clone of pallets/click, produced a commit whose message described the
      // click fix and whose contents were another session's uncommitted work.
      // Naming `paths`, or committing inside the clone, both still work.
      if (scope.length === 0 && input.all === true) {
        const blocked = sweepBlockedBy(dir, openContributions())
        if (blocked) {
          return [
            `Refusing to commit everything in ${dir}: an external contribution to ${blocked.slug} is open in ${blocked.dir}, and this is a different repository.`,
            `If the change belongs to that contribution, commit it there: github commit dir:"${blocked.dir}" message:"..." paths:[...]`,
            'If it really belongs to this project, name what you changed with paths:[...] instead of all:true.',
          ].join('\n')
        }
      }

      const stage = scope.length > 0 ? await git(['add', '--', ...scope]) : await git(input.all === true ? ['add', '-A'] : ['add', '-u'])
      if (!stage.ok) return fail(stage)

      const excluded = await unstageWhatMustNotBeCommitted(git)
      const staged = await git(['diff', '--cached', '--name-only'])
      if (!staged.stdout.trim()) {
        const why = excluded.length > 0 ? ` Everything staged was left out: ${excluded.join('; ')}.` : ''
        return `Nothing staged to commit (working tree clean, or only untracked files — pass all:true, or name them in paths).${why}`
      }
      // Signed with the run that wrote it (provenance.ts). Unsigned outside a
      // run, so a commit made by hand through this tool stays plain.
      const result = await git(['commit', '-m', signCommitMessage(message)])
      if (!result.ok) return fail(result)
      const head = await git(['log', '-1', '--pretty=%h %s'])
      const stat = await git(['show', '--stat', '--oneline', 'HEAD'])
      const contribution = contributionForDir(dir)
      if (contribution) saveContribution({ ...contribution, status: 'committed', ...(str('verified') ? { verified: str('verified') } : {}) })
      return [
        `Committed ${head.stdout || '(unknown)'}${contribution ? ` in ${contribution.slug}` : ''}`,
        stat.stdout.split('\n').slice(1).join('\n'),
        excluded.length > 0 ? `Left out of the commit: ${excluded.join('; ')}.` : '',
        scope.length === 0 && input.all === true ? 'This committed the whole working tree. Pass paths:[...] to commit only the files you changed.' : '',
        contribution && !contribution.prUrl ? `Not contributed yet: push to your fork and open the pull request on ${contribution.slug}.` : '',
      ].filter(Boolean).join('\n')
    }

    if (action === 'contribute') {
      const ref = str('ref') || str('repo')
      if (!ref) return 'contribute needs "ref" — the repository or issue to contribute to, e.g. ref:"pallets/click#3652".'
      const { report } = await startContribution({
        ref,
        git,
        gh,
        cwd: dir,
        ...(str('name') ? { branch: str('name') } : {}),
      })
      return report
    }

    if (action === 'contribute_status') {
      const rows = readContributions()
      // Refresh only what has a pull request: the merged/closed verdict is the
      // one fact that changes without elia doing anything.
      const refreshed = await Promise.all(rows.map((row) => (row.prNumber === undefined ? Promise.resolve(row) : refreshContribution(row, gh))))
      return renderContributions(refreshed)
    }

    if (action === 'sync') {
      const contribution = contributionForDir(dir)
      const remote = contribution?.forkSlug ? 'upstream' : 'origin'
      const defaultBranch = contribution?.defaultBranch ?? (await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).stdout.trim().split('/').pop() ?? 'main'
      const fetched = await git(['fetch', '--', remote, defaultBranch], dir, 120_000)
      if (!fetched.ok) return fail(fetched)
      const target = `${remote}/${defaultBranch}`
      const behind = (await git(['rev-list', '--count', `HEAD..${target}`])).stdout.trim()
      if (input.rebase !== true) {
        return behind === '0'
          ? `Up to date with ${target}.`
          : `${behind} commit(s) behind ${target}. Pass rebase:true to rebase this branch onto it.`
      }
      const rebase = await git(['rebase', target])
      if (!rebase.ok) {
        await git(['rebase', '--abort'])
        return `Rebase onto ${target} failed and was aborted, so the branch is untouched:\n${rebase.stderr || rebase.stdout}`
      }
      return `Rebased onto ${target} (was ${behind} behind).`
    }

    if (action === 'push') {
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
      if (!branch || branch === 'HEAD') return 'Cannot push: HEAD is detached. Create a branch first.'
      const contribution = contributionForDir(dir)
      const args = ['push']
      if (input.force === true) args.push('--force-with-lease')
      args.push('-u', 'origin', '--', branch)
      const result = await git(args)
      if (!result.ok) return fail(result)
      // In a contribution clone `origin` is the fork by construction, so this
      // says which account the branch actually landed in rather than leaving
      // "pushed to origin" to be read as the upstream project.
      const where = contribution?.forkSlug ? `your fork ${contribution.forkSlug}` : 'origin'
      if (contribution) saveContribution({ ...contribution, status: 'pushed' })
      return [
        `Pushed "${branch}" to ${where}.`,
        (result.stderr || result.stdout).trim(),
        contribution && !contribution.prUrl
          ? `Nothing is contributed yet — ${contribution.slug} has not seen this. Open the pull request: github pr_create dir:"${contribution.dir}" repo:"${contribution.slug}" title:"..."`
          : '',
      ].filter(Boolean).join('\n')
    }

    if (action === 'pr_create') {
      const title = str('title')
      if (!title) return 'pr_create needs "title".'

      const contribution = contributionForDir(dir)
      if (contribution) {
        // Inside a fork, a bare `gh pr create` opens the PR against the fork's
        // own default branch: it succeeds, prints a URL, and no maintainer of
        // the real project ever sees it. Naming the upstream repo explicitly is
        // also what puts the target in front of the person approving the act.
        if (!str('repo')) {
          return [
            `${dir} is a clone of ${contribution.slug}, which is not this project. Say which repository the pull request is for:`,
            `  github pr_create dir:"${contribution.dir}" repo:"${contribution.slug}" title:"${title}" body:"..."`,
            'Without repo, the pull request would be opened against your own fork and nobody upstream would see it.',
          ].join('\n')
        }
        if (str('repo').toLowerCase() !== contribution.slug.toLowerCase()) {
          return `This clone belongs to ${contribution.slug}, but repo says "${str('repo')}". Fix one of the two rather than opening a pull request on a repository this branch was not built against.`
        }
        return openContributionPr({
          contribution: str('verified') ? saveContribution({ ...contribution, verified: str('verified') }) : contribution,
          title,
          ...(str('body') ? { body: str('body') } : {}),
          ...(input.draft === true ? { draft: true } : {}),
          gh,
          git,
        })
      }

      const args = ['pr', 'create', ...repoArgs(), '--title', title, '--body', str('body') || title]
      if (str('base')) args.push('--base', validateRefName(str('base'), 'base'))
      if (input.draft === true) args.push('--draft')

      // `gh pr create` refuses a branch with no upstream — GitHub needs the
      // commits to exist on the remote before it can open a PR. The tool
      // describes pr_create as "pushes it first if needed", so make that true
      // and do it explicitly (a plain `--head` push is implicit and ambiguous
      // about which remote the push went to).
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
      const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      if (!upstream.ok) {
        if (!branch || branch === 'HEAD') return 'Cannot create a PR: HEAD is detached. Create a branch first.'
        const push = await git(['push', '-u', 'origin', '--', branch])
        if (!push.ok) return fail(push)
      }

      const result = await gh(args)
      return result.ok ? `Opened PR: ${result.stdout}` : fail(result)
    }

    if (action === 'pr_view') {
      const args = ['pr', 'view']
      if (typeof input.number === 'number') args.push(String(input.number))
      args.push('--json', 'number,title,state,isDraft,url,headRefName,baseRefName,mergeable,reviewDecision,body', '--jq',
        '"#\\(.number) \\(.title)\\nstate: \\(.state)\\(if .isDraft then " (draft)" else "" end) · \\(.headRefName) → \\(.baseRefName) · mergeable: \\(.mergeable) · review: \\(.reviewDecision // "none")\\n\\(.url)\\n\\n\\(.body // "")"')
      const result = await gh(args)
      return result.ok ? result.stdout : fail(result)
    }

    if (action === 'pr_list') {
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(50, Math.floor(input.limit)) : 20
      const result = await gh([
        'pr', 'list', '--limit', String(limit),
        '--json', 'number,title,isDraft,headRefName,author,url,updatedAt',
        '--jq', '.[] | "#\\(.number) \\(if .isDraft then "[draft] " else "" end)\\(.title)\\n  \\(.headRefName) · @\\(.author.login) · \\(.url)"',
      ])
      if (!result.ok) return fail(result)
      return result.stdout.trim() || 'No open pull requests.'
    }

    if (action === 'pr_reviews') {
      const args = ['pr', 'view']
      if (typeof input.number === 'number') args.push(String(input.number))
      args.push(
        '--json', 'number,title,url,reviews,comments,reviewDecision',
        '--jq',
        '"#\\(.number) \\(.title)\\nreview: \\(.reviewDecision // "none")\\n\\(.url)\\n\\n## Reviews\\n\\(.reviews // [] | map("- \\(.author.login): \\(.state)\\n  \\(.body // "")") | join("\\n"))\\n\\n## Comments\\n\\(.comments // [] | map("- \\(.author.login): \\(.body)") | join("\\n"))"',
      )
      const result = await gh(args)
      return result.ok ? result.stdout : fail(result)
    }

    if (action === 'pr_unresolved_reviews') {
      const context = await detectGitHubContext(dir, { signal, force: true, remote: true })
      if (!context.slug) return 'Could not determine the GitHub owner/repo for this checkout (no origin remote?).'
      const [owner, repo] = context.slug.split('/')

      let number = typeof input.number === 'number' ? input.number : undefined
      if (number === undefined) {
        const current = await gh(['pr', 'view', '--json', 'number', '--jq', '.number'])
        if (!current.ok) return fail(current)
        const parsed = Number.parseInt(current.stdout.trim(), 10)
        if (!Number.isFinite(parsed)) return "Could not determine the current branch's PR number."
        number = parsed
      }

      // Resolved/unresolved is per review *thread*, not per comment, and is
      // only exposed over the GraphQL API — `gh pr view --json` has no field
      // for it (confirmed against `gh pr view --help`'s JSON FIELDS list).
      const query =
        'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:50){nodes{isResolved isOutdated path line comments(first:10){nodes{author{login} body}}}}}}}'
      const result = await gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `number=${number}`])
      if (!result.ok) return fail(result)

      interface ThreadNode {
        isResolved: boolean
        isOutdated: boolean
        path: string | null
        line: number | null
        comments: { nodes: { author: { login: string } | null; body: string }[] }
      }
      let parsed: { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: ThreadNode[] } } } } }
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        return `Could not parse GitHub's response.\n${clampOutput(result.stdout || result.stderr, 2_000)}`
      }
      const threads = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
      if (threads.length === 0) return 'No review comment threads on this PR.'
      const unresolved = threads.filter((t) => !t.isResolved)
      if (unresolved.length === 0) return `All ${threads.length} review comment thread(s) are resolved — nothing outstanding.`

      const lines = unresolved.map((thread, index) => {
        const location = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ''}` : '(no file location)'
        const comments = thread.comments.nodes.map((c) => `  - ${c.author?.login ?? 'unknown'}: ${c.body}`).join('\n')
        return `${index + 1}. ${location}${thread.isOutdated ? ' (diff position outdated by later commits)' : ''}\n${comments}`
      })
      return `${unresolved.length} of ${threads.length} review comment thread(s) still unresolved:\n\n${clampOutput(lines.join('\n\n'), 8_000)}`
    }

    if (action === 'pr_checks') {
      const args = ['pr', 'checks']
      if (typeof input.number === 'number') args.push(String(input.number))
      const result = await gh(args)
      // `gh pr checks` exits non-zero when checks are failing or pending — that is data, not an error.
      return result.stdout || result.stderr || (result.ok ? 'All checks passed.' : fail(result))
    }

    if (action === 'pr_checks_log') {
      const jsonArgs = ['pr', 'checks']
      if (typeof input.number === 'number') jsonArgs.push(String(input.number))
      jsonArgs.push('--json', 'name,state,bucket,link')
      const jsonResult = await gh(jsonArgs)
      // Same as pr_checks: a non-zero exit here means "failing or pending", not
      // a transport failure — the --json payload still lands on stdout either way.
      let checks: { name: string; state: string; bucket: string; link: string }[]
      try {
        checks = JSON.parse(jsonResult.stdout) as typeof checks
      } catch {
        return jsonResult.ok ? jsonResult.stdout || 'No checks configured for this PR yet.' : fail(jsonResult)
      }
      if (checks.length === 0) return 'No checks configured for this PR yet.'

      const summary = checks.map((c) => `${c.bucket === 'pass' ? '✓' : c.bucket === 'fail' ? '✗' : c.bucket === 'pending' ? '…' : c.bucket} ${c.name} (${c.state})`).join('\n')
      const failing = checks.filter((c) => c.bucket === 'fail')
      if (failing.length === 0) return `${summary}\n\nNo failing checks (some may still be pending).`

      // A GitHub Actions check's link is .../actions/runs/<runId>/job/<jobId> —
      // several failing check names can point at jobs within the same run, so
      // fetch each distinct run's failed-step log only once.
      const runIds = [...new Set(failing.map((c) => c.link.match(/\/actions\/runs\/(\d+)/)?.[1]).filter((id): id is string => Boolean(id)))].slice(0, 3)
      if (runIds.length === 0) {
        return `${summary}\n\n${failing.length} check(s) failing, but no GitHub Actions run could be identified from their links (an external/third-party status check does not have a fetchable log here — open its link directly).`
      }

      const logs = await Promise.all(
        runIds.map(async (runId) => {
          const logResult = await gh(['run', 'view', runId, '--log-failed'])
          const body = logResult.stdout.trim() || logResult.stderr.trim() || '(no failed-step output captured)'
          return `--- run ${runId} failed steps ---\n${clampOutput(body, 6_000)}`
        }),
      )
      return `${summary}\n\n${logs.join('\n\n')}`
    }

    if (action === 'pr_comment') {
      if (typeof input.number !== 'number') return 'pr_comment needs "number".'
      const body = str('body')
      if (!body) return 'pr_comment needs "body".'
      const result = await gh(['pr', 'comment', String(input.number), '--body', body])
      return result.ok ? `Commented on PR #${input.number}: ${result.stdout}` : fail(result)
    }

    if (action === 'pr_merge') {
      if (typeof input.number !== 'number') return 'pr_merge needs "number".'
      const method = input.method === 'squash' || input.method === 'rebase' ? input.method : 'merge'
      const result = await gh(['pr', 'merge', String(input.number), `--${method}`])
      return result.ok ? `Merged PR #${input.number} (${method}).\n${result.stdout}` : fail(result)
    }

    if (action === 'issue_list') {
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(50, Math.floor(input.limit)) : 20
      const args = [
        'issue', 'list', ...repoArgs(), '--limit', String(limit),
        '--json', 'number,title,labels,author,url,updatedAt',
        '--jq', '.[] | "#\\(.number) \\(.title)\\n  labels: \\([.labels[].name] | join(", ")) · @\\(.author.login) · \\(.url)"',
      ]
      if (str('label')) args.splice(3, 0, '--label', str('label'))
      const result = await gh(args)
      if (!result.ok) return fail(result)
      return result.stdout.trim() || 'No open issues.'
    }

    if (action === 'issue_view') {
      if (typeof input.number !== 'number') return 'issue_view needs "number".'
      const result = await gh([
        'issue', 'view', String(input.number), ...repoArgs(),
        '--json', 'number,title,state,author,labels,body,url,comments',
        '--jq',
        '"#\\(.number) \\(.title)\\nstate: \\(.state) · @\\(.author.login)\\nlabels: \\([.labels[].name] | join(", "))\\n\\(.url)\\n\\n\\(.body // "")\\n\\n## Comments\\n\\(.comments // [] | map("- \\(.author.login): \\(.body)") | join("\\n"))"',
      ])
      return result.ok ? result.stdout : fail(result)
    }

    if (action === 'issue_create') {
      const title = str('title')
      if (!title) return 'issue_create needs "title".'
      const args = ['issue', 'create', '--title', title]
      if (str('body')) args.push('--body', str('body'))
      const result = await gh(args)
      return result.ok ? `Opened issue: ${result.stdout}` : fail(result)
    }

    return `Unknown github action "${String(action)}".`
  },
}
