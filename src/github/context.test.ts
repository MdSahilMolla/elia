import { afterEach, expect, test } from 'bun:test'
import { parseAheadBehind, parseGhAuthStatus, parseRemoteUrl, renderGitHubBanner, detectGitHubContext, resetGitHubContextCache } from './context.ts'
import { setExecForTests, type ExecFn, type ExecResult } from './exec.ts'

afterEach(() => {
  setExecForTests()
  resetGitHubContextCache()
})

const ok = (stdout: string): ExecResult => ({ ok: true, exitCode: 0, stdout, stderr: '', missing: false })
const err = (stderr = 'fail', exitCode = 1): ExecResult => ({ ok: false, exitCode, stdout: '', stderr, missing: false })

test('parseRemoteUrl handles https and ssh forms', () => {
  expect(parseRemoteUrl('https://github.com/MdSahilMolla/elia.git')).toEqual({ owner: 'MdSahilMolla', repo: 'elia' })
  expect(parseRemoteUrl('git@github.com:MdSahilMolla/elia.git')).toEqual({ owner: 'MdSahilMolla', repo: 'elia' })
  expect(parseRemoteUrl('https://github.com/acme/some.repo')).toEqual({ owner: 'acme', repo: 'some.repo' })
  expect(parseRemoteUrl('https://gitlab.com/acme/thing.git')).toBeUndefined()
})

test('parseAheadBehind reads the left-right count', () => {
  expect(parseAheadBehind('3\t5')).toEqual({ behind: 3, ahead: 5 })
  expect(parseAheadBehind('0\t0')).toEqual({ behind: 0, ahead: 0 })
  expect(parseAheadBehind('garbage')).toEqual({ behind: 0, ahead: 0 })
})

test('parseGhAuthStatus detects login and account name', () => {
  expect(parseGhAuthStatus('✓ Logged in to github.com account octocat (keyring)')).toEqual({ authenticated: true, user: 'octocat' })
  expect(parseGhAuthStatus('You are not logged into any GitHub hosts.')).toEqual({ authenticated: false })
})

function stubExec(routes: Record<string, ExecResult>): void {
  const fn: ExecFn = async (bin, args) => {
    const key = `${bin} ${args.join(' ')}`
    for (const [prefix, result] of Object.entries(routes)) {
      if (key.startsWith(prefix)) return result
    }
    return err(`no stub for: ${key}`)
  }
  setExecForTests(fn)
}

test('detectGitHubContext assembles a full picture from git + gh', async () => {
  stubExec({
    'git rev-parse --is-inside-work-tree': ok('true'),
    'git remote get-url origin': ok('git@github.com:MdSahilMolla/elia.git'),
    'git rev-parse --abbrev-ref HEAD': ok('feature/x'),
    'git status --porcelain': ok(' M src/a.ts'),
    'git rev-list --count --left-right': ok('0\t2'),
    'gh auth status': ok('Logged in to github.com account sahil'),
    'gh repo view': ok('main'),
    'gh pr view': ok('{"number":42,"url":"https://github.com/MdSahilMolla/elia/pull/42","title":"Add X","state":"OPEN","isDraft":false}'),
  })

  const context = await detectGitHubContext('/repo', { force: true, remote: true })
  expect(context.isRepo).toBe(true)
  expect(context.slug).toBe('MdSahilMolla/elia')
  expect(context.currentBranch).toBe('feature/x')
  expect(context.defaultBranch).toBe('main')
  expect(context).toMatchObject({ ahead: 2, behind: 0, dirty: true, ghAuthenticated: true, ghUser: 'sahil' })
  expect(context.openPr?.number).toBe(42)
})

test('detectGitHubContext degrades cleanly outside a repo', async () => {
  stubExec({ 'git rev-parse --is-inside-work-tree': err('not a git repository', 128) })
  const context = await detectGitHubContext('/tmp', { force: true, remote: true })
  expect(context.isRepo).toBe(false)
  expect(context.hasRemote).toBe(false)
})

test('detectGitHubContext handles a repo with a remote but no gh auth', async () => {
  stubExec({
    'git rev-parse --is-inside-work-tree': ok('true'),
    'git remote get-url origin': ok('https://github.com/acme/widgets.git'),
    'git rev-parse --abbrev-ref HEAD': ok('main'),
    'git status --porcelain': ok(''),
    'git rev-list --count --left-right': err('no upstream'),
    'gh auth status': err('not logged in'),
    'gh repo view': err('auth required'),
    'gh pr view': err('no pr'),
  })
  const context = await detectGitHubContext('/repo2', { force: true, remote: true })
  expect(context).toMatchObject({ isRepo: true, hasRemote: true, slug: 'acme/widgets', hasUpstream: false, ghAuthenticated: false, dirty: false })
})

test('renderGitHubBanner summarises, and is empty without a remote', () => {
  expect(renderGitHubBanner({ isRepo: true, hasRemote: false, ahead: 0, behind: 0, hasUpstream: false, dirty: false, ghInstalled: true, ghAuthenticated: false })).toBe('')
  const line = renderGitHubBanner({
    isRepo: true, hasRemote: true, slug: 'acme/widgets', currentBranch: 'feature/y', ahead: 1, behind: 0,
    hasUpstream: true, dirty: false, ghInstalled: true, ghAuthenticated: true, ghUser: 'sahil',
  })
  expect(line).toContain('acme/widgets')
  expect(line).toContain('gh ✓ sahil')
  expect(line).toContain('feature/y')
})

test('renderGitHubBanner flags a missing gh auth', () => {
  const line = renderGitHubBanner({ isRepo: true, hasRemote: true, slug: 'a/b', ahead: 0, behind: 0, hasUpstream: false, dirty: false, ghInstalled: true, ghAuthenticated: false })
  expect(line).toContain('gh not authenticated')
})
