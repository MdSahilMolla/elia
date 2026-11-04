import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { githubTool } from './github.ts'
import { readContributions, saveContribution, setContributionsPathForTests } from '../github/contribute.ts'
import { assessAction } from '../autonomy/governor.ts'
import { withAgentIdentity } from '../autonomy/context.ts'
import { setExecForTests, type ExecFn, type ExecResult } from '../github/exec.ts'
import { resetGitHubContextCache } from '../github/context.ts'

afterEach(() => {
  setExecForTests()
  resetGitHubContextCache()
  // Left set, the next test's commit would be refused because the tool believes
  // an external contribution is open — and worse, a real run would write into
  // this checkout's own .elia record.
  setContributionsPathForTests()
})

const ok = (stdout = ''): ExecResult => ({ ok: true, exitCode: 0, stdout, stderr: '', missing: false })
const err = (stderr = 'boom', exitCode = 1): ExecResult => ({ ok: false, exitCode, stdout: '', stderr, missing: false })
const gone = (): ExecResult => ({ ok: false, exitCode: 127, stdout: '', stderr: 'gh is not installed or not on PATH', missing: true })

function route(routes: Record<string, ExecResult>, fallback: ExecResult = err('no stub')): void {
  const fn: ExecFn = async (bin, args) => {
    const key = `${bin} ${args.join(' ')}`
    for (const [prefix, result] of Object.entries(routes)) if (key.startsWith(prefix)) return result
    return fallback
  }
  setExecForTests(fn)
}

test('branch creates and switches', async () => {
  route({ 'git checkout -b feature/z': ok() })
  expect(await githubTool.execute({ action: 'branch', name: 'feature/z' })).toContain('switched to branch "feature/z"')
})

test('branch rejects a "from" that looks like a git flag', async () => {
  route({ 'git checkout -b feature/z': ok() })
  await expect(githubTool.execute({ action: 'branch', name: 'feature/z', from: '--orphan' })).rejects.toThrow(/invalid from/i)
  await expect(githubTool.execute({ action: 'branch', name: 'feature/z', from: '-x' })).rejects.toThrow(/invalid from/i)
})

test('branch rejects a "name" that looks like a git flag', async () => {
  await expect(githubTool.execute({ action: 'branch', name: '--orphan' })).rejects.toThrow(/invalid name/i)
})

test('branch accepts a normal branch name as "from"', async () => {
  let seen: string[] = []
  setExecForTests(async (bin, args) => {
    if (bin === 'git') seen = args
    return ok()
  })
  const out = await githubTool.execute({ action: 'branch', name: 'feat/my-branch', from: 'main' })
  expect(out).toContain('switched to branch "feat/my-branch"')
  expect(seen).toEqual(['checkout', '-b', 'feat/my-branch', 'main'])
})

test('commit stages, checks for staged content, and commits', async () => {
  route({
    'git add -u': ok(),
    'git diff --cached --name-only': ok('src/a.ts'),
    'git commit -m': ok(),
    'git log -1': ok('abc123 Fix the thing'),
    'git show --stat': ok('abc123 Fix the thing\n src/a.ts | 2 +-'),
  })
  const out = await githubTool.execute({ action: 'commit', message: 'Fix the thing' })
  expect(out).toContain('Committed abc123 Fix the thing')
})

test('commit refuses when nothing is staged', async () => {
  route({ 'git add -u': ok(), 'git diff --cached --name-only': ok('') })
  expect(await githubTool.execute({ action: 'commit', message: 'x' })).toContain('Nothing staged')
})

test('commit needs a message', async () => {
  expect(await githubTool.execute({ action: 'commit' })).toContain('needs "message"')
})

test('push targets the current branch and sets upstream', async () => {
  const calls: string[] = []
  const fn: ExecFn = async (bin, args) => {
    calls.push(`${bin} ${args.join(' ')}`)
    if (args.includes('--abbrev-ref')) return ok('feature/z')
    return ok('branch pushed')
  }
  setExecForTests(fn)
  const out = await githubTool.execute({ action: 'push' })
  expect(out).toContain('Pushed "feature/z"')
  expect(calls.some((c) => c === 'git push -u origin -- feature/z')).toBe(true)
})

test('pr_create passes title and body through argv (not a shell)', async () => {
  let seen: string[] = []
  setExecForTests(async (bin, args) => {
    if (bin === 'gh') seen = args
    return ok('https://github.com/acme/x/pull/7')
  })
  const nastyTitle = 'fix; rm -rf / && echo pwned'
  const out = await githubTool.execute({ action: 'pr_create', title: nastyTitle })
  expect(out).toContain('Opened PR')
  expect(seen).toContain(nastyTitle) // the whole string arrives as one argv element
})

test('a missing gh CLI produces a helpful message', async () => {
  route({}, gone())
  expect(await githubTool.execute({ action: 'pr_view' })).toContain('gh auth login')
})

test('pr_comment and pr_merge validate their number', async () => {
  expect(await githubTool.execute({ action: 'pr_comment', body: 'hi' })).toContain('needs "number"')
  expect(await githubTool.execute({ action: 'pr_merge' })).toContain('needs "number"')
})

test('pr_list and issue_list are read-only and format results', async () => {
  route({
    'gh pr list': ok('#7 Fix auth\n  feature/auth · @alice · https://example/pull/7'),
    'gh issue list': ok('#3 Flaky test\n  labels: bug · @bob · https://example/issues/3'),
  })
  expect(await githubTool.execute({ action: 'pr_list' })).toContain('#7 Fix auth')
  expect(await githubTool.execute({ action: 'issue_list' })).toContain('#3 Flaky test')
  expect(assessAction({ name: 'github', input: { action: 'pr_list' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'pr_reviews' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'issue_list' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'issue_view' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'issue_create' } }).risk).toBe('review')
})

test('pr_reviews and issue_view need readable payloads', async () => {
  route({
    'gh pr view': ok('#7 reviews'),
    'gh issue view': ok('#3 body'),
  })
  expect(await githubTool.execute({ action: 'pr_reviews', number: 7 })).toContain('#7')
  expect(await githubTool.execute({ action: 'issue_view' })).toContain('needs "number"')
  expect(await githubTool.execute({ action: 'issue_view', number: 3 })).toContain('#3')
})

test('pr_checks_log reports a clean summary with no log fetch when every check passes', async () => {
  route({
    'gh pr checks --json name,state,bucket,link': ok(
      JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/acme/widgets/actions/runs/1/job/2' }]),
    ),
  })
  const out = await githubTool.execute({ action: 'pr_checks_log' })
  expect(out).toContain('✓ build')
  expect(out).toContain('No failing checks')
  expect(out).not.toContain('failed steps')
})

test('pr_checks_log fetches the failed-step log for a failing Actions check, deduped by run id', async () => {
  let runViewCalls = 0
  setExecForTests(async (bin, args) => {
    const key = `${bin} ${args.join(' ')}`
    if (key === 'gh pr checks --json name,state,bucket,link') {
      return ok(
        JSON.stringify([
          { name: 'unit-tests', state: 'FAILURE', bucket: 'fail', link: 'https://github.com/acme/widgets/actions/runs/555/job/1' },
          { name: 'lint', state: 'FAILURE', bucket: 'fail', link: 'https://github.com/acme/widgets/actions/runs/555/job/2' },
        ]),
      )
    }
    if (key === 'gh run view 555 --log-failed') {
      runViewCalls += 1
      return ok('unit-tests\tFAIL\tTypeError: x is not a function')
    }
    return err('no stub')
  })
  const out = await githubTool.execute({ action: 'pr_checks_log' })
  expect(out).toContain('✗ unit-tests')
  expect(out).toContain('✗ lint')
  expect(out).toContain('run 555 failed steps')
  expect(out).toContain('TypeError: x is not a function')
  expect(runViewCalls).toBe(1)
})

test('pr_checks_log reports failing external checks with no fetchable Actions run instead of silently omitting them', async () => {
  route({
    'gh pr checks --json name,state,bucket,link': ok(
      JSON.stringify([{ name: 'vendor-scan', state: 'FAILURE', bucket: 'fail', link: 'https://vendor.example.com/scans/abc' }]),
    ),
  })
  const out = await githubTool.execute({ action: 'pr_checks_log' })
  expect(out).toContain('vendor-scan')
  expect(out).toContain('no GitHub Actions run could be identified')
})

test('pr_checks_log falls back gracefully when gh does not return parsable JSON', async () => {
  route({ 'gh pr checks --json name,state,bucket,link': err('no pull requests found') })
  const out = await githubTool.execute({ action: 'pr_checks_log' })
  expect(out).toContain('No open pull request')
})

// --- pr_unresolved_reviews ---

const CONTEXT_ROUTES: Record<string, ExecResult> = {
  'git rev-parse --is-inside-work-tree': ok('true'),
  'git remote get-url origin': ok('git@github.com:acme/widgets.git'),
  'git rev-parse --abbrev-ref HEAD': ok('feature/x'),
  'git status --porcelain': ok(''),
  'git rev-list --count --left-right': ok('0\t0'),
  'gh auth status': ok('Logged in to github.com account sahil'),
  'gh repo view': ok('main'),
}

function exactRoute(routes: Record<string, ExecResult>, fallback: ExecResult = err('no stub')): void {
  setExecForTests(async (bin, args) => routes[`${bin} ${args.join(' ')}`] ?? fallback)
}

test('pr_unresolved_reviews lists only unresolved threads, with location and comments', async () => {
  const graphql = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              { isResolved: false, isOutdated: false, path: 'src/a.ts', line: 12, comments: { nodes: [{ author: { login: 'reviewer1' }, body: 'This looks wrong' }] } },
              { isResolved: true, isOutdated: false, path: 'src/b.ts', line: 4, comments: { nodes: [{ author: { login: 'reviewer1' }, body: 'Fixed, thanks' }] } },
            ],
          },
        },
      },
    },
  }
  exactRoute({
    ...CONTEXT_ROUTES,
    'gh pr view --json number --jq .number': ok('42'),
    [`gh api graphql -f query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:50){nodes{isResolved isOutdated path line comments(first:10){nodes{author{login} body}}}}}}} -F owner=acme -F repo=widgets -F number=42`]: ok(
      JSON.stringify(graphql),
    ),
  })
  const out = await githubTool.execute({ action: 'pr_unresolved_reviews' })
  expect(out).toContain('1 of 2 review comment thread(s) still unresolved')
  expect(out).toContain('src/a.ts:12')
  expect(out).toContain('reviewer1: This looks wrong')
  expect(out).not.toContain('Fixed, thanks')
})

test('pr_unresolved_reviews reports everything resolved distinctly from nothing to review at all', async () => {
  const allResolved = { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true, isOutdated: false, path: 'x.ts', line: 1, comments: { nodes: [] } }] } } } } }
  exactRoute({
    ...CONTEXT_ROUTES,
    'gh pr view --json number --jq .number': ok('7'),
    [`gh api graphql -f query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:50){nodes{isResolved isOutdated path line comments(first:10){nodes{author{login} body}}}}}}} -F owner=acme -F repo=widgets -F number=7`]: ok(
      JSON.stringify(allResolved),
    ),
  })
  expect(await githubTool.execute({ action: 'pr_unresolved_reviews' })).toContain('All 1 review comment thread(s) are resolved')

  const none = { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }
  exactRoute({
    ...CONTEXT_ROUTES,
    'gh pr view --json number --jq .number': ok('7'),
    [`gh api graphql -f query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:50){nodes{isResolved isOutdated path line comments(first:10){nodes{author{login} body}}}}}}} -F owner=acme -F repo=widgets -F number=7`]: ok(
      JSON.stringify(none),
    ),
  })
  expect(await githubTool.execute({ action: 'pr_unresolved_reviews' })).toBe('No review comment threads on this PR.')
})

test('pr_unresolved_reviews fails clearly with no origin remote, and uses the explicit "number" without a pr view lookup', async () => {
  exactRoute({ 'git rev-parse --is-inside-work-tree': ok('true'), 'git remote get-url origin': err('no such remote') })
  expect(await githubTool.execute({ action: 'pr_unresolved_reviews' })).toContain('Could not determine the GitHub owner/repo')

  // An explicit "number" must skip the "current PR" lookup entirely.
  let sawPrViewLookup = false
  setExecForTests(async (bin, args) => {
    const key = `${bin} ${args.join(' ')}`
    if (key === 'gh pr view --json number --jq .number') {
      sawPrViewLookup = true
      return ok('999')
    }
    if (key.startsWith('git ') || key.startsWith('gh auth') || key.startsWith('gh repo view')) return CONTEXT_ROUTES[key] ?? err('no stub')
    if (key.startsWith('gh api graphql')) return ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }))
    return err('no stub')
  })
  await githubTool.execute({ action: 'pr_unresolved_reviews', number: 42 })
  expect(sawPrViewLookup).toBe(false)
})

// --- governor contract ---

test('governor: read-only github actions are allowed, writes are governed', () => {
  expect(assessAction({ name: 'github', input: { action: 'status' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'pr_checks' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'pr_checks_log' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'pr_unresolved_reviews' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'branch' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'commit' } }).decision).toBe('allow')

  expect(assessAction({ name: 'github', input: { action: 'push' } }).risk).toBe('review')
  expect(assessAction({ name: 'github', input: { action: 'push', force: true } }).risk).toBe('critical')
  expect(assessAction({ name: 'github', input: { action: 'pr_create' } }).risk).toBe('review')
  expect(assessAction({ name: 'github', input: { action: 'pr_comment' } }).risk).toBe('critical')
  expect(assessAction({ name: 'github', input: { action: 'pr_merge' } }).risk).toBe('critical')
})

// --- working on a repository that is not this project ---

function contributionState(): string {
  // realpath: Windows hands back an 8.3 short path that never compares equal to
  // the long one the tool resolves to.
  return join(realpathSync.native(mkdtempSync(join(tmpdir(), 'elia-gh-'))), 'contributions.json')
}

test('commit with paths stages only those files', async () => {
  const seen: string[][] = []
  setExecForTests(async (bin, args) => {
    seen.push(args)
    const key = `${bin} ${args.join(' ')}`
    if (key.startsWith('git diff --cached --name-only')) return ok('src/a.ts')
    if (key.startsWith('git diff --cached --raw')) return ok(':100644 100644 aaa bbb M\tsrc/a.ts')
    if (key.startsWith('git log -1')) return ok('abc123 Fix')
    if (key.startsWith('git show --stat')) return ok('abc123 Fix\n src/a.ts | 2 +-')
    return ok()
  })
  const out = await githubTool.execute({ action: 'commit', message: 'Fix', paths: ['src/a.ts'] })
  expect(seen.some((args) => args.join(' ') === 'add -- src/a.ts')).toBe(true)
  expect(seen.some((args) => args.join(' ') === 'add -A')).toBe(false)
  expect(out).toContain('Committed abc123 Fix')
})

test('commit unstages a nested clone instead of committing it as a stray gitlink', async () => {
  const resets: string[] = []
  setExecForTests(async (bin, args) => {
    const key = `${bin} ${args.join(' ')}`
    if (key.startsWith('git reset')) {
      resets.push(args.at(-1)!)
      return ok()
    }
    // A gitlink for `click` beside a normal edit, and no .gitmodules to declare it.
    if (key.startsWith('git diff --cached --raw')) return ok(':100644 100644 aaa bbb M\tsrc/a.ts\n:000000 160000 0000000 6aabf09 A\tclick')
    if (key.startsWith('git config --file .gitmodules')) return err('no such file')
    if (key.startsWith('git diff --cached --name-only')) return ok('src/a.ts')
    if (key.startsWith('git log -1')) return ok('abc123 Fix')
    if (key.startsWith('git show --stat')) return ok('abc123 Fix\n src/a.ts | 2 +-')
    return ok()
  })
  const out = await githubTool.execute({ action: 'commit', message: 'Fix', all: true })
  expect(resets).toEqual(['click'])
  expect(out).toContain('its own git repository, not part of this project')
})

test('commit keeps a declared submodule, which is part of the project', async () => {
  const resets: string[] = []
  setExecForTests(async (bin, args) => {
    const key = `${bin} ${args.join(' ')}`
    if (key.startsWith('git reset')) {
      resets.push(args.at(-1)!)
      return ok()
    }
    if (key.startsWith('git diff --cached --raw')) return ok(':000000 160000 0000000 6aabf09 A\tvendor/lib')
    if (key.startsWith('git config --file .gitmodules')) return ok('submodule.vendor/lib.path vendor/lib')
    if (key.startsWith('git diff --cached --name-only')) return ok('vendor/lib')
    if (key.startsWith('git log -1')) return ok('abc123 Bump')
    if (key.startsWith('git show --stat')) return ok('abc123 Bump')
    return ok()
  })
  await githubTool.execute({ action: 'commit', message: 'Bump', all: true })
  expect(resets).toEqual([])
})

test('commit refuses to sweep a whole tree while a contribution is open in another repo', async () => {
  const state = contributionState()
  setContributionsPathForTests(state)
  saveContribution({ slug: 'pallets/click', forkSlug: 'octocat/click', dir: join(realpathSync.native(tmpdir()), 'elia-clone', 'click'), defaultBranch: 'main', branch: 'fix/issue-3652', status: 'branched', startedAt: 1, updatedAt: 1 })
  let staged = false
  setExecForTests(async (_bin, args) => {
    if (args[0] === 'add') staged = true
    return ok()
  })
  const out = await githubTool.execute({ action: 'commit', message: 'Fix issue #3652', all: true })
  expect(out).toContain('Refusing to commit everything')
  expect(out).toContain('pallets/click')
  expect(out).toContain('paths:[...]')
  // Nothing was staged, so the index is exactly as it was found.
  expect(staged).toBe(false)
})

test('a scoped commit in that same situation still works', async () => {
  setContributionsPathForTests(contributionState())
  saveContribution({ slug: 'pallets/click', dir: join(realpathSync.native(tmpdir()), 'elia-clone2', 'click'), defaultBranch: 'main', status: 'branched', startedAt: 1, updatedAt: 1 })
  setExecForTests(async (bin, args) => {
    const key = `${bin} ${args.join(' ')}`
    if (key.startsWith('git diff --cached --name-only')) return ok('src/a.ts')
    if (key.startsWith('git diff --cached --raw')) return ok(':100644 100644 aaa bbb M\tsrc/a.ts')
    if (key.startsWith('git log -1')) return ok('abc123 Fix elia')
    if (key.startsWith('git show --stat')) return ok('abc123 Fix elia\n src/a.ts | 1 +')
    return ok()
  })
  expect(await githubTool.execute({ action: 'commit', message: 'Fix elia', paths: ['src/a.ts'] })).toContain('Committed abc123 Fix elia')
})

test('dir routes every git call into that checkout, and push reports the fork', async () => {
  const state = contributionState()
  const root = dirname(state)
  mkdirSync(join(root, 'workspace', 'click'), { recursive: true })
  const clone = realpathSync.native(join(root, 'workspace', 'click'))
  setContributionsPathForTests(state)
  saveContribution({ slug: 'pallets/click', forkSlug: 'octocat/click', dir: clone, defaultBranch: 'main', branch: 'fix/issue-3652', status: 'committed', startedAt: 1, updatedAt: 1 })

  const cwds: (string | undefined)[] = []
  setExecForTests(async (_bin, args, cwd) => {
    cwds.push(cwd)
    if (args.join(' ').startsWith('rev-parse --abbrev-ref HEAD')) return ok('fix/issue-3652')
    return ok('branch pushed')
  })
  // The agent's root is the temp project here, the way it is elia's checkout in
  // real use: `dir` names a clone inside it, never an arbitrary path on disk.
  const out = await withAgentIdentity({ name: 'lead', role: 'lead', cwd: root }, () => githubTool.execute({ action: 'push', dir: clone }))
  expect(cwds.every((dir) => dir === clone)).toBe(true)
  expect(out).toContain('your fork octocat/click')
  expect(out).toContain('github pr_create')
  expect(readContributions(state)[0]!.status).toBe('pushed')
})

test('dir outside the directory elia is working in is refused, not followed', async () => {
  setExecForTests(async () => ok())
  const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'elia-outside-')))
  const out = await githubTool.execute({ action: 'push', dir: elsewhere })
  expect(out).toContain('outside the directory elia is working in')
})

test('pr_create inside a fork refuses to open one until the upstream repo is named', async () => {
  const state = contributionState()
  const root = dirname(state)
  mkdirSync(join(root, 'workspace', 'click'), { recursive: true })
  const clone = realpathSync.native(join(root, 'workspace', 'click'))
  setContributionsPathForTests(state)
  saveContribution({ slug: 'pallets/click', forkSlug: 'octocat/click', dir: clone, defaultBranch: 'main', branch: 'fix/issue-3652', status: 'pushed', startedAt: 1, updatedAt: 1 })

  let created = false
  setExecForTests(async (bin, args) => {
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'create') created = true
    return ok()
  })
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'lead', role: 'lead', cwd: root }, () => githubTool.execute(input))
  const out = await run({ action: 'pr_create', dir: clone, title: 'Add ellipsis' })
  expect(created).toBe(false)
  expect(out).toContain('repo:"pallets/click"')
  expect(out).toContain('nobody upstream would see it')

  const mismatch = await run({ action: 'pr_create', dir: clone, title: 'Add ellipsis', repo: 'someone/else' })
  expect(created).toBe(false)
  expect(mismatch).toContain('belongs to pallets/click')
})

test('governor: contributing and an upstream pull request each need their own yes', () => {
  const contribute = assessAction({ name: 'github', input: { action: 'contribute', ref: 'pallets/click#3652' } })
  expect(contribute.risk).toBe('review')
  expect(contribute.decision).toBe('approve')
  expect(contribute.reason).toContain('pallets/click#3652')

  expect(assessAction({ name: 'github', input: { action: 'contribute_status' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'sync' } }).decision).toBe('allow')

  // A pull request into someone else's project is not the same act as one into your own.
  const upstream = assessAction({ name: 'github', input: { action: 'pr_create', repo: 'pallets/click', title: 'x' } })
  expect(upstream.risk).toBe('critical')
  expect(upstream.intent).toBe('github.pr_create.upstream')
  expect(upstream.reason).toContain('pallets/click')
})
