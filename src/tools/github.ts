import type { Tool } from './types.ts'
import { currentAgent } from '../autonomy/context.ts'
import { execCapture, type ExecResult } from '../github/exec.ts'
import { detectGitHubContext, renderGitHubBanner } from '../github/context.ts'

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
  | 'status' | 'branch' | 'commit' | 'push'
  | 'pr_create' | 'pr_view' | 'pr_list' | 'pr_checks' | 'pr_reviews' | 'pr_comment' | 'pr_merge'
  | 'issue_list' | 'issue_view' | 'issue_create'

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

Actions:
- status: where this repo stands with GitHub — remote, gh auth, current branch vs upstream, any open PR. Start here.
- branch: create and switch to a branch. { name, from? }
- commit: stage and commit. { message, all? } — all:true stages every change, otherwise only already-tracked files.
- push: push the current branch to origin. { force? } — force needs approval.
- pr_create: open a pull request for the current branch (pushes it first if needed). { title, body?, base?, draft? }
- pr_view: show a PR (defaults to the current branch's). { number? }
- pr_list: list open pull requests. { limit? }
- pr_checks: CI / status-check results for a PR. { number? }
- pr_reviews: review comments and discussion on a PR (for addressing feedback). { number? }
- pr_comment: add a comment to a PR. { number, body } — needs approval.
- pr_merge: merge a PR. { number, method? one of merge|squash|rebase } — needs approval.
- issue_list: list open issues (intake for autonomous work). { limit?, label? }
- issue_view: show one issue. { number }
- issue_create: open an issue. { title, body? } — needs review approval.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'status', 'branch', 'commit', 'push',
          'pr_create', 'pr_view', 'pr_list', 'pr_checks', 'pr_reviews', 'pr_comment', 'pr_merge',
          'issue_list', 'issue_view', 'issue_create',
        ],
      },
      name: { type: 'string', description: 'branch: the new branch name' },
      from: { type: 'string', description: 'branch: base ref to branch from (default: current HEAD)' },
      message: { type: 'string', description: 'commit: the commit message' },
      all: { type: 'boolean', description: 'commit: stage all changes, including untracked files' },
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
    const dir = cwd ?? process.cwd()
    const action = input.action as Action
    const git = (args: string[]) => execCapture('git', args, dir, signal)
    const gh = (args: string[]) => execCapture('gh', args, dir, signal)
    const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')

    if (action === 'status') {
      const context = await detectGitHubContext(dir, { signal, force: true, remote: true })
      if (!context.isRepo) return 'Not a git repository.'
      const lines = [renderGitHubBanner(context) || `local git repo${context.hasRemote ? '' : ' with no origin remote'}`]
      lines.push(`  branch: ${context.currentBranch ?? '(detached)'}${context.hasUpstream ? ` · ${context.ahead} ahead, ${context.behind} behind upstream` : ' · no upstream set'}`)
      lines.push(`  working tree: ${context.dirty ? 'has uncommitted changes' : 'clean'}`)
      if (context.slug) lines.push(`  remote: ${context.slug}${context.defaultBranch ? ` (default branch ${context.defaultBranch})` : ''}`)
      lines.push(`  gh CLI: ${!context.ghInstalled ? 'not installed' : context.ghAuthenticated ? `authenticated${context.ghUser ? ` as ${context.ghUser}` : ''}` : 'installed but not authenticated (run: gh auth login)'}`)
      if (context.openPr) lines.push(`  open PR: #${context.openPr.number} ${context.openPr.isDraft ? '(draft) ' : ''}${context.openPr.title} — ${context.openPr.url}`)
      return lines.join('\n')
    }

    if (action === 'branch') {
      const name = str('name')
      if (!name) return 'branch needs "name".'
      const args = ['checkout', '-b', name]
      if (str('from')) args.push(str('from'))
      const result = await git(args)
      return result.ok ? `Created and switched to branch "${name}".` : fail(result)
    }

    if (action === 'commit') {
      const message = str('message')
      if (!message) return 'commit needs "message".'
      const stage = await git(input.all === true ? ['add', '-A'] : ['add', '-u'])
      if (!stage.ok) return fail(stage)
      const staged = await git(['diff', '--cached', '--name-only'])
      if (!staged.stdout.trim()) return 'Nothing staged to commit (working tree clean, or only untracked files — pass all:true to include them).'
      const result = await git(['commit', '-m', message])
      if (!result.ok) return fail(result)
      const head = await git(['log', '-1', '--pretty=%h %s'])
      const stat = await git(['show', '--stat', '--oneline', 'HEAD'])
      return `Committed ${head.stdout || '(unknown)'}\n${stat.stdout.split('\n').slice(1).join('\n')}`
    }

    if (action === 'push') {
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
      if (!branch || branch === 'HEAD') return 'Cannot push: HEAD is detached. Create a branch first.'
      const args = ['push']
      if (input.force === true) args.push('--force-with-lease')
      args.push('-u', 'origin', branch)
      const result = await git(args)
      return result.ok ? `Pushed "${branch}" to origin.\n${result.stderr || result.stdout}`.trim() : fail(result)
    }

    if (action === 'pr_create') {
      const title = str('title')
      if (!title) return 'pr_create needs "title".'
      const args = ['pr', 'create', '--title', title, '--body', str('body') || title]
      if (str('base')) args.push('--base', str('base'))
      if (input.draft === true) args.push('--draft')
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

    if (action === 'pr_checks') {
      const args = ['pr', 'checks']
      if (typeof input.number === 'number') args.push(String(input.number))
      const result = await gh(args)
      // `gh pr checks` exits non-zero when checks are failing or pending — that is data, not an error.
      return result.stdout || result.stderr || (result.ok ? 'All checks passed.' : fail(result))
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
        'issue', 'list', '--limit', String(limit),
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
        'issue', 'view', String(input.number),
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
