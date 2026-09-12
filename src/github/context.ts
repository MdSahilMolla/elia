import { execCapture } from './exec.ts'

/**
 * A single read of where a project stands with GitHub: the remote, whether
 * `gh` is installed and logged in, the current branch's relationship to its
 * upstream, and any open PR for it.
 *
 * elia consults this at session start (so the model knows from turn one
 * whether it can push and open PRs), from the `environment` tool, and from the
 * `github` tool's own `status` action. Every probe is defensive — a missing
 * binary, a repo with no remote, a detached HEAD all resolve to a well-formed
 * "not available" rather than an error.
 */

export interface OpenPullRequest {
  number: number
  url: string
  title: string
  state: string
  isDraft: boolean
}

export interface GitHubContext {
  isRepo: boolean
  hasRemote: boolean
  remoteUrl?: string
  owner?: string
  repo?: string
  /** owner/repo */
  slug?: string
  currentBranch?: string
  defaultBranch?: string
  /** Commits the local branch is ahead of / behind its upstream; 0 when there is no upstream. */
  ahead: number
  behind: number
  hasUpstream: boolean
  dirty: boolean
  ghInstalled: boolean
  ghAuthenticated: boolean
  ghUser?: string
  openPr?: OpenPullRequest
  /**
   * `gh auth status` produced output that matched neither the "logged in" nor
   * the "not logged in" pattern — `ghAuthenticated` was left at its default
   * `false` because parsing genuinely couldn't tell, not because it confirmed
   * the user is logged out. A future `gh` wording change is the expected
   * trigger; consumers should present this distinctly rather than as a
   * confirmed "not authenticated".
   */
  ghAuthUnknown?: boolean
  /**
   * The upstream comparison (`git rev-list --left-right`) succeeded but its
   * output didn't match the expected "N\tM" shape, so `ahead`/`behind` were
   * left at 0 without that being a confirmed zero. Consumers should present
   * this distinctly rather than as "0 ahead, 0 behind".
   */
  aheadBehindUnknown?: boolean
}

/** github.com/owner/repo(.git) or git@github.com:owner/repo(.git) → {owner, repo}. */
export function parseRemoteUrl(url: string): { owner: string; repo: string } | undefined {
  const trimmed = url.trim()
  const patterns = [
    /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i,
    /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/i,
  ]
  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    if (match?.[1] && match[2]) return { owner: match[1], repo: match[2].replace(/\.git$/, '') }
  }
  return undefined
}

/**
 * `git rev-list --count --left-right @{upstream}...HEAD` → "3\t5" means 3 behind, 5 ahead.
 *
 * `recognized: false` means the output didn't match the expected shape at all (e.g. a future git wording
 * change) — distinct from a confirmed "0 ahead, 0 behind", which is `recognized: true`. Callers must not treat
 * the two the same, or a parsing regression silently under-reports real ahead/behind state.
 */
export function parseAheadBehind(output: string): { ahead: number; behind: number; recognized: boolean } {
  const match = output.trim().match(/^(\d+)\s+(\d+)$/)
  if (!match) return { ahead: 0, behind: 0, recognized: false }
  return { behind: Number(match[1]), ahead: Number(match[2]), recognized: true }
}

/**
 * `gh auth status` prints "Logged in to github.com account NAME" when authenticated, or a "not logged in"
 * variant (e.g. "You are not logged into any GitHub hosts") when not — both recognized outcomes. Output matching
 * neither pattern (e.g. a future `gh` wording change) returns `recognized: false` with `authenticated: false` as
 * a safe default value, not a confirmed "logged out" — callers must not present the two identically, or a
 * parsing regression silently under-reports real auth state.
 */
export function parseGhAuthStatus(text: string): { authenticated: boolean; user?: string; recognized: boolean } {
  const loggedIn = /Logged in to github\.com/i.test(text)
  if (loggedIn) {
    const user = text.match(/account\s+([A-Za-z0-9-]+)/i)?.[1] ?? text.match(/as\s+([A-Za-z0-9-]+)/i)?.[1]
    return { authenticated: true, user, recognized: true }
  }
  const notLoggedIn = /not logged (?:in|into)|no github hosts|not logged in to any/i.test(text)
  if (notLoggedIn) return { authenticated: false, recognized: true }
  return { authenticated: false, recognized: false }
}

let cache: { cwd: string; at: number; remote: boolean; context: GitHubContext } | undefined
const CACHE_TTL_MS = 15_000

/** Test-only: clears the per-cwd context cache. */
export function resetGitHubContextCache(): void {
  cache = undefined
}

export interface DetectOptions {
  signal?: AbortSignal
  /** Bypass the short-lived cache. */
  force?: boolean
  /**
   * Also fetch the repo default branch and any open PR — these hit the GitHub
   * API. Off by default so the session banner and the read-only `environment`
   * tool stay local; the `github` tool's `status` action turns it on.
   */
  remote?: boolean
}

export async function detectGitHubContext(cwd: string, options: DetectOptions = {}): Promise<GitHubContext> {
  const { signal, force = false, remote = false } = options
  if (!force && cache && cache.cwd === cwd && cache.remote === remote && Date.now() - cache.at < CACHE_TTL_MS) return cache.context

  const base: GitHubContext = {
    isRepo: false, hasRemote: false, ahead: 0, behind: 0, hasUpstream: false,
    dirty: false, ghInstalled: Boolean(Bun.which('gh')), ghAuthenticated: false,
  }

  const insideRepo = await execCapture('git', ['rev-parse', '--is-inside-work-tree'], cwd, signal)
  if (!insideRepo.ok || insideRepo.stdout.trim() !== 'true') {
    cache = { cwd, at: Date.now(), remote, context: base }
    return base
  }
  base.isRepo = true

  const [originUrl, branch, status, upstream] = await Promise.all([
    execCapture('git', ['remote', 'get-url', 'origin'], cwd, signal),
    execCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, signal),
    execCapture('git', ['status', '--porcelain'], cwd, signal),
    execCapture('git', ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'], cwd, signal),
  ])

  if (branch.ok && branch.stdout.trim() && branch.stdout.trim() !== 'HEAD') base.currentBranch = branch.stdout.trim()
  base.dirty = status.ok && status.stdout.trim().length > 0

  if (upstream.ok) {
    base.hasUpstream = true
    const { recognized, ...counts } = parseAheadBehind(upstream.stdout)
    Object.assign(base, counts)
    if (!recognized) base.aheadBehindUnknown = true
  }

  if (originUrl.ok && originUrl.stdout.trim()) {
    base.hasRemote = true
    base.remoteUrl = originUrl.stdout.trim()
    const parsed = parseRemoteUrl(originUrl.stdout)
    if (parsed) {
      base.owner = parsed.owner
      base.repo = parsed.repo
      base.slug = `${parsed.owner}/${parsed.repo}`
    }
  }

  if (base.ghInstalled) {
    const auth = await execCapture('gh', ['auth', 'status'], cwd, signal)
    const parsedAuth = parseGhAuthStatus(`${auth.stdout}\n${auth.stderr}`)
    base.ghAuthenticated = parsedAuth.authenticated
    base.ghUser = parsedAuth.user
    if (!parsedAuth.recognized) base.ghAuthUnknown = true

    if (remote && base.ghAuthenticated) {
      const [defaultBranch, pr] = await Promise.all([
        execCapture('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], cwd, signal),
        execCapture('gh', ['pr', 'view', '--json', 'number,url,title,state,isDraft'], cwd, signal),
      ])
      if (defaultBranch.ok && defaultBranch.stdout.trim()) base.defaultBranch = defaultBranch.stdout.trim()
      if (pr.ok && pr.stdout.trim().startsWith('{')) {
        try {
          const data = JSON.parse(pr.stdout) as OpenPullRequest
          if (typeof data.number === 'number') base.openPr = data
        } catch {
          // no open PR, or unexpected shape — leave undefined
        }
      }
    }
  }

  cache = { cwd, at: Date.now(), remote, context: base }
  return base
}

/** A one-line summary for the session banner. Empty string when this is not a GitHub repo. */
export function renderGitHubBanner(context: GitHubContext): string {
  if (!context.isRepo || !context.hasRemote || !context.slug) return ''
  const parts = [`GitHub: ${context.slug}`]
  if (!context.ghInstalled) parts.push('gh CLI not installed — install it for autonomous PRs')
  else if (context.ghAuthUnknown) parts.push('gh auth status unrecognized — run "gh auth status" to check')
  else if (!context.ghAuthenticated) parts.push('gh not authenticated — run "gh auth login"')
  else parts.push(`gh ✓${context.ghUser ? ` ${context.ghUser}` : ''}`)
  if (context.currentBranch) {
    let branchPart = `branch ${context.currentBranch}`
    if (context.aheadBehindUnknown) branchPart += ' (ahead/behind unknown — unrecognized git output)'
    else if (context.ahead || context.behind) branchPart += ` (${context.ahead}↑ ${context.behind}↓)`
    parts.push(branchPart)
  }
  if (context.openPr) parts.push(`PR #${context.openPr.number} open`)
  return parts.join(' · ')
}
