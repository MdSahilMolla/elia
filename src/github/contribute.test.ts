import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  contributionDirFor,
  contributionForDir,
  openContributionPr,
  openContributions,
  parseRepoRef,
  readContributions,
  renderContributionEvidence,
  saveContribution,
  setContributionsPathForTests,
  startContribution,
  sweepBlockedBy,
  type Contribution,
} from './contribute.ts'
import type { ExecResult } from './exec.ts'

const temporaries: string[] = []

function scratch(): string {
  // realpath, because Windows hands back an 8.3 short path ("RUNNER~1") that
  // never string-compares equal to the long one these functions resolve to.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'elia-contrib-')))
  temporaries.push(dir)
  return dir
}

afterEach(() => {
  setContributionsPathForTests()
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ok = (stdout = ''): ExecResult => ({ ok: true, exitCode: 0, stdout, stderr: '', missing: false })
const err = (stderr = 'boom'): ExecResult => ({ ok: false, exitCode: 1, stdout: '', stderr, missing: false })

/** Records every argv it is handed, answering from a prefix table. */
function recorder(routes: Record<string, ExecResult>, fallback = ok()) {
  const calls: string[] = []
  const run = async (args: string[]): Promise<ExecResult> => {
    const key = args.join(' ')
    calls.push(key)
    for (const [prefix, result] of Object.entries(routes)) if (key.startsWith(prefix)) return result
    return fallback
  }
  return { run, calls }
}

test('parseRepoRef reads every way a repo or issue gets named', () => {
  expect(parseRepoRef('pallets/click')).toEqual({ slug: 'pallets/click', owner: 'pallets', repo: 'click' })
  expect(parseRepoRef('pallets/click#3652')).toEqual({ slug: 'pallets/click', owner: 'pallets', repo: 'click', issue: 3652 })
  expect(parseRepoRef('https://github.com/pallets/click/issues/3652')).toEqual({ slug: 'pallets/click', owner: 'pallets', repo: 'click', issue: 3652 })
  expect(parseRepoRef('https://github.com/pallets/click/pull/12')).toEqual({ slug: 'pallets/click', owner: 'pallets', repo: 'click', issue: 12 })
  expect(parseRepoRef('github.com/pallets/click.git')).toEqual({ slug: 'pallets/click', owner: 'pallets', repo: 'click' })
  expect(parseRepoRef('git@github.com:pallets/click.git')).toEqual({ slug: 'pallets/click', owner: 'pallets', repo: 'click' })
})

test('parseRepoRef refuses what it cannot read rather than guessing', () => {
  expect(parseRepoRef('')).toBeUndefined()
  expect(parseRepoRef('click')).toBeUndefined()
  expect(parseRepoRef('https://gitlab.com/a/b')).toBeUndefined()
  // A leading dash would be read as a flag by the argv-level git/gh calls.
  expect(parseRepoRef('-x/click')).toBeUndefined()
  expect(parseRepoRef('pallets/--upload-pack')).toBeUndefined()
})

test('a clone goes under the workspace, and a same-named repo from another owner gets its own folder', () => {
  const root = scratch()
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const first = contributionDirFor({ slug: 'pallets/click', owner: 'pallets', repo: 'click' }, { cwd: root, workspace })
  expect(first).toBe(join(workspace, 'click'))

  const second = contributionDirFor({ slug: 'other/click', owner: 'other', repo: 'click' }, { cwd: root, workspace, taken: [first] })
  expect(second).toBe(join(workspace, 'other-click'))
})

test('an isolated task root never reaches up into the shared workspace', () => {
  const outside = scratch()
  const taskRoot = scratch()
  const dir = contributionDirFor({ slug: 'pallets/click', owner: 'pallets', repo: 'click' }, { cwd: taskRoot, workspace: join(outside, 'workspace') })
  expect(dir).toBe(join(taskRoot, 'click'))
})

test('the record round-trips and only open contributions are listed as open', () => {
  const state = join(scratch(), 'contributions.json')
  setContributionsPathForTests(state)
  const base: Contribution = { slug: 'a/b', dir: join(dirname(state), 'x', 'b'), defaultBranch: 'main', status: 'branched', startedAt: 1, updatedAt: 1 }
  saveContribution(base)
  saveContribution({ ...base, slug: 'c/d', dir: join(dirname(state), 'x', 'd'), status: 'merged' })
  expect(readContributions().map((row) => row.slug)).toEqual(['a/b', 'c/d'])
  expect(openContributions().map((row) => row.slug)).toEqual(['a/b'])

  // Same repo and directory: an update, not a second row.
  saveContribution({ ...base, status: 'pushed' })
  expect(readContributions()).toHaveLength(2)
  expect(readContributions()[0]!.status).toBe('pushed')
})

test('contributionForDir finds the contribution a path sits inside', () => {
  const state = join(scratch(), 'contributions.json')
  setContributionsPathForTests(state)
  const clone = join(scratch(), 'workspace', 'click')
  saveContribution({ slug: 'pallets/click', dir: clone, defaultBranch: 'main', status: 'branched', startedAt: 1, updatedAt: 1 })
  expect(contributionForDir(clone)?.slug).toBe('pallets/click')
  expect(contributionForDir(join(clone, 'src', 'click'))?.slug).toBe('pallets/click')
  expect(contributionForDir(join(clone, '..', 'elsewhere'))).toBeUndefined()
})

test('sweepBlockedBy names the contribution a sweeping commit would be happening outside of', () => {
  const clone = join(scratch(), 'workspace', 'click')
  const now = Date.now()
  const rows: Contribution[] = [{ slug: 'pallets/click', dir: clone, defaultBranch: 'main', status: 'branched', startedAt: now, updatedAt: now }]
  expect(sweepBlockedBy(join(clone, '..', '..'), rows)?.slug).toBe('pallets/click')
  expect(sweepBlockedBy(clone, rows)).toBeUndefined()
  expect(sweepBlockedBy(join(clone, 'src'), rows)).toBeUndefined()
})

test('sweepBlockedBy ignores a delivered contribution and a stale one, so it cannot block this project forever', () => {
  const clone = join(scratch(), 'workspace', 'click')
  const now = Date.now()
  const elsewhere = join(clone, '..', '..')
  const base: Contribution = { slug: 'pallets/click', dir: clone, defaultBranch: 'main', status: 'pushed', startedAt: now, updatedAt: now }

  // Already proposed upstream: this commit is not that work.
  expect(sweepBlockedBy(elsewhere, [{ ...base, prUrl: 'https://example.invalid/pull/1' }], { now })).toBeUndefined()
  // A leftover record from a month ago is not evidence about what is happening now.
  expect(sweepBlockedBy(elsewhere, [{ ...base, updatedAt: now - 30 * 24 * 60 * 60 * 1000 }], { now })).toBeUndefined()
  // Still open and recent: refused.
  expect(sweepBlockedBy(elsewhere, [base], { now })?.slug).toBe('pallets/click')
})

test('startContribution forks, clones the fork, pins upstream read-only, and branches', async () => {
  const root = scratch()
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const state = join(root, 'contributions.json')

  const gh = recorder({
    'repo view pallets/click': ok(JSON.stringify({ nameWithOwner: 'pallets/click', defaultBranchRef: { name: 'main' }, viewerPermission: 'READ' })),
    'api user': ok('octocat'),
    'repo fork pallets/click': ok('octocat/click'),
    'repo view octocat/click': ok(JSON.stringify({ nameWithOwner: 'octocat/click' })),
  })
  const git = recorder({ 'remote\n': ok(''), 'rev-parse --verify': err('not a ref') }, ok(''))

  const { contribution, report } = await startContribution({
    ref: 'https://github.com/pallets/click/issues/3652',
    git: git.run,
    gh: gh.run,
    cwd: root,
    workspace,
    statePath: state,
  })

  expect(contribution).toBeDefined()
  expect(contribution!.slug).toBe('pallets/click')
  expect(contribution!.forkSlug).toBe('octocat/click')
  expect(contribution!.dir).toBe(join(workspace, 'click'))
  expect(contribution!.branch).toBe('fix/issue-3652')
  expect(contribution!.issue).toBe(3652)

  // The fork is what gets cloned; upstream is added and its push URL disabled.
  expect(git.calls.some((call) => call === `clone https://github.com/octocat/click.git ${join(workspace, 'click')}`)).toBe(true)
  expect(git.calls.some((call) => call.startsWith('remote add upstream https://github.com/pallets/click.git'))).toBe(true)
  expect(git.calls.some((call) => call.startsWith('remote set-url --push upstream DISABLED'))).toBe(true)
  expect(git.calls.some((call) => call === 'checkout -b fix/issue-3652')).toBe(true)
  // Nothing ever pushes to the source repository.
  expect(git.calls.some((call) => call.startsWith('push upstream'))).toBe(false)

  expect(report).toContain('octocat/click')
  expect(report).toContain(join(workspace, 'click'))
  expect(report).toContain('repo: "pallets/click"')
  expect(readContributions(state)).toHaveLength(1)
})

test('startContribution skips the fork when the account can already push to the repo', async () => {
  const root = scratch()
  const state = join(root, 'contributions.json')
  const gh = recorder({
    'repo view mine/thing': ok(JSON.stringify({ nameWithOwner: 'mine/thing', defaultBranchRef: { name: 'trunk' }, viewerPermission: 'WRITE' })),
  })
  const git = recorder({ 'rev-parse --verify': err('no ref') }, ok(''))
  const { contribution, report } = await startContribution({ ref: 'mine/thing', git: git.run, gh: gh.run, cwd: root, workspace: join(root, 'workspace'), statePath: state })
  expect(contribution!.forkSlug).toBeUndefined()
  expect(gh.calls.some((call) => call.startsWith('repo fork'))).toBe(false)
  expect(git.calls.some((call) => call.startsWith('clone https://github.com/mine/thing.git'))).toBe(true)
  expect(report).toContain('no fork was made')
})

test('startContribution stops on an archived repository instead of forking it', async () => {
  const root = scratch()
  const gh = recorder({ 'repo view old/thing': ok(JSON.stringify({ nameWithOwner: 'old/thing', isArchived: true })) })
  const git = recorder({})
  const { contribution, report } = await startContribution({ ref: 'old/thing', git: git.run, gh: gh.run, cwd: root, statePath: join(root, 'contributions.json') })
  expect(contribution).toBeUndefined()
  expect(report).toContain('archived')
  expect(git.calls).toHaveLength(0)
})

test('startContribution says what it could not read instead of cloning a guess', async () => {
  const root = scratch()
  const git = recorder({})
  const { report } = await startContribution({ ref: 'not a repo', git: git.run, gh: recorder({}).run, cwd: root, statePath: join(root, 'contributions.json') })
  expect(report).toContain('Could not read')
  expect(git.calls).toHaveLength(0)
})

test('startContribution reuses an existing clone rather than making a second one', async () => {
  const root = scratch()
  const workspace = join(root, 'workspace')
  const clone = join(workspace, 'click')
  mkdirSync(join(clone, '.git'), { recursive: true })
  writeFileSync(join(clone, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const state = join(root, 'contributions.json')
  setContributionsPathForTests(state)
  saveContribution({ slug: 'pallets/click', forkSlug: 'octocat/click', dir: clone, defaultBranch: 'main', status: 'branched', startedAt: 1, updatedAt: 1 })

  const gh = recorder({
    'repo view pallets/click': ok(JSON.stringify({ nameWithOwner: 'pallets/click', defaultBranchRef: { name: 'main' }, viewerPermission: 'READ' })),
    'api user': ok('octocat'),
    'repo view octocat/click': ok(JSON.stringify({ nameWithOwner: 'octocat/click' })),
  })
  const git = recorder({ 'rev-parse --verify': ok('abc') }, ok(''))
  const { report } = await startContribution({ ref: 'pallets/click', git: git.run, gh: gh.run, cwd: root, workspace, statePath: state })
  expect(git.calls.some((call) => call.startsWith('clone'))).toBe(false)
  expect(report).toContain('already there')
  expect(readContributions(state)).toHaveLength(1)
})

test('the clone is added to the host repository’s local excludes, so no later `git add -A` can sweep it', async () => {
  const root = scratch()
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const realGit = (args: string[], cwd?: string) => spawnSync('git', args, { cwd: cwd ?? root, encoding: 'utf8', windowsHide: true })
  realGit(['init', '-q', '-b', 'main', '.'])

  const gh = recorder({
    'repo view pallets/click': ok(JSON.stringify({ nameWithOwner: 'pallets/click', defaultBranchRef: { name: 'main' }, viewerPermission: 'READ' })),
    'api user': ok('octocat'),
    'repo fork pallets/click': ok(''),
    'repo view octocat/click': ok(JSON.stringify({ nameWithOwner: 'octocat/click' })),
  })
  // Real git for everything except the network clone, which is replaced by an
  // empty local repository at the same path.
  const git = async (args: string[], cwd?: string): Promise<ExecResult> => {
    if (args[0] === 'clone') {
      mkdirSync(args[2]!, { recursive: true })
      spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: args[2]!, windowsHide: true })
      return ok()
    }
    const r = realGit(args, cwd)
    return { ok: r.status === 0, exitCode: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), missing: false }
  }

  // The record lives outside the host repo, so the status assertion below is
  // about the clone and nothing else.
  const { contribution } = await startContribution({ ref: 'pallets/click', git, gh: gh.run, cwd: root, workspace, statePath: join(scratch(), 'c.json') })
  expect(contribution!.dir).toBe(join(workspace, 'click'))

  const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
  expect(exclude).toContain('/workspace/click/')
  // git itself agrees, which is the only test that matters.
  expect(realGit(['check-ignore', '-q', 'workspace/click']).status).toBe(0)
  expect(realGit(['status', '--porcelain']).stdout.trim()).toBe('')
})

test('openContributionPr targets the upstream repo from the fork branch, and links the issue', async () => {
  const state = join(scratch(), 'contributions.json')
  const contribution: Contribution = {
    slug: 'pallets/click',
    forkSlug: 'octocat/click',
    dir: join(dirname(state), 'w', 'click'),
    defaultBranch: 'main',
    branch: 'fix/issue-3652',
    issue: 3652,
    status: 'committed',
    startedAt: 1,
    updatedAt: 1,
  }
  const gh = recorder({ 'pr create': ok('https://github.com/pallets/click/pull/9001') })
  const git = recorder({ 'rev-list --count': ok('2') }, ok(''))

  const out = await openContributionPr({ contribution, title: 'Add ellipsis for multiple=True options', body: 'The metavar did not say the option repeats.', gh: gh.run, git: git.run, statePath: state })
  const created = gh.calls.find((call) => call.startsWith('pr create'))!
  expect(created).toContain('--repo pallets/click')
  expect(created).toContain('--head octocat:fix/issue-3652')
  expect(created).toContain('--base main')
  expect(created).toContain('Fixes #3652')
  expect(git.calls).toContain('push -u origin -- fix/issue-3652')
  expect(out).toContain('https://github.com/pallets/click/pull/9001')

  const saved = readContributions(state)[0]!
  expect(saved.status).toBe('pr_open')
  expect(saved.prNumber).toBe(9001)
})

test('the recorded verification travels with the pull request, and its absence is said out loud', async () => {
  const contribution: Contribution = {
    slug: 'a/b',
    forkSlug: 'me/b',
    dir: 'w',
    defaultBranch: 'main',
    branch: 'fix/x',
    status: 'committed',
    verified: 'pytest tests/ — 2412 passed, 1 skipped',
    startedAt: 1,
    updatedAt: 1,
  }
  const withCheck = recorder({ 'pr create': ok('https://example.invalid/pull/1') })
  await openContributionPr({ contribution, title: 'Fix it', gh: withCheck.run, git: recorder({ 'rev-list --count': ok('1') }, ok()).run, statePath: join(scratch(), 'c.json') })
  expect(withCheck.calls.find((call) => call.startsWith('pr create'))).toContain('Verified with: pytest tests/ — 2412 passed, 1 skipped')

  const without = recorder({ 'pr create': ok('https://example.invalid/pull/2') })
  const { verified, ...unverified } = contribution
  void verified
  const out = await openContributionPr({ contribution: unverified, title: 'Fix it', gh: without.run, git: recorder({ 'rev-list --count': ok('1') }, ok()).run, statePath: join(scratch(), 'c.json') })
  expect(out).toContain('No verification is recorded')
})

test('openContributionPr refuses a branch with nothing on it', async () => {
  const contribution: Contribution = { slug: 'a/b', forkSlug: 'me/b', dir: 'w', defaultBranch: 'main', branch: 'fix/x', status: 'branched', startedAt: 1, updatedAt: 1 }
  const gh = recorder({})
  const git = recorder({ 'rev-list --count': ok('0') })
  const out = await openContributionPr({ contribution, title: 'nothing', gh: gh.run, git: git.run, statePath: join(scratch(), 'c.json') })
  expect(out).toContain('nothing to propose')
  expect(gh.calls).toHaveLength(0)
  expect(git.calls.some((call) => call.startsWith('push'))).toBe(false)
})

test('the compounding line separates what was merged upstream from what stopped short', () => {
  const rows: Contribution[] = [
    { slug: 'pallets/click', dir: 'a', defaultBranch: 'main', status: 'merged', prNumber: 9001, verified: 'pytest tests/ — 2412 passed', startedAt: 1, updatedAt: 2 },
    { slug: 'vercel/next.js', dir: 'b', defaultBranch: 'main', status: 'pr_open', prNumber: 12, prUrl: 'https://example.invalid/12', startedAt: 1, updatedAt: 2 },
    { slug: 'some/lib', dir: 'c', defaultBranch: 'main', status: 'committed', startedAt: 1, updatedAt: 2 },
  ]
  const rendered = renderContributionEvidence(rows)!
  expect(rendered).toContain('3 started · 2 proposed upstream · 1 merged by a maintainer')
  expect(rendered).toContain('pallets/click#9001 merged')
  expect(rendered).toContain('some/lib stopped at "committed" — no pull request, so nothing was contributed')
  expect(renderContributionEvidence([])).toBeUndefined()
})

test('a hand-edited record with a flag-shaped branch, a foreign dir or a bad PR number is dropped on read', () => {
  const root = scratch()
  const state = join(root, 'contributions.json')
  setContributionsPathForTests(state)
  const good: Contribution = { slug: 'a/b', dir: join(root, 'workspace', 'b'), defaultBranch: 'main', branch: 'fix/x', status: 'branched', prNumber: 4, startedAt: 1, updatedAt: 1 }
  const rows: unknown[] = [
    good,
    { ...good, slug: 'c/d', branch: '--upload-pack=touch /tmp/pwned' },
    { ...good, slug: 'e/f', defaultBranch: '-x' },
    { ...good, slug: 'g/h', dir: '/etc' },
    { ...good, slug: 'i/j', dir: 'relative/clone' },
    { ...good, slug: '--flag/x' },
    { ...good, slug: 'k/l', prNumber: '1; rm -rf' },
    { ...good, slug: 'm/n', status: 'weird' },
  ]
  writeFileSync(state, JSON.stringify({ version: 1, contributions: rows }))
  expect(readContributions().map((row) => row.slug)).toEqual(['a/b'])
})
