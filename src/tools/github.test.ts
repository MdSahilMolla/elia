import { afterEach, expect, test } from 'bun:test'
import { githubTool } from './github.ts'
import { assessAction } from '../autonomy/governor.ts'
import { setExecForTests, type ExecFn, type ExecResult } from '../github/exec.ts'
import { resetGitHubContextCache } from '../github/context.ts'

afterEach(() => {
  setExecForTests()
  resetGitHubContextCache()
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
  expect(calls.some((c) => c === 'git push -u origin feature/z')).toBe(true)
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

// --- governor contract ---

test('governor: read-only github actions are allowed, writes are governed', () => {
  expect(assessAction({ name: 'github', input: { action: 'status' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'pr_checks' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'branch' } }).decision).toBe('allow')
  expect(assessAction({ name: 'github', input: { action: 'commit' } }).decision).toBe('allow')

  expect(assessAction({ name: 'github', input: { action: 'push' } }).risk).toBe('review')
  expect(assessAction({ name: 'github', input: { action: 'push', force: true } }).risk).toBe('critical')
  expect(assessAction({ name: 'github', input: { action: 'pr_create' } }).risk).toBe('review')
  expect(assessAction({ name: 'github', input: { action: 'pr_comment' } }).risk).toBe('critical')
  expect(assessAction({ name: 'github', input: { action: 'pr_merge' } }).risk).toBe('critical')
})
