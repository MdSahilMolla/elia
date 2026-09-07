import { afterEach, expect, test } from 'bun:test'
import { setExecForTests, type ExecResult } from '../github/exec.ts'
import { createActionGovernor } from './governor.ts'
import { publishProject, repositoryName } from './publish.ts'
import type { Proposal } from './types.ts'

const proposal: Proposal = {
  goal: 'An expense tracker API',
  understanding: '',
  assumptions: [],
  steps: [
    { id: 's1', title: 'Manifest', role: 'builder', instructions: 'Write package.json.', files: ['package.json'], dependsOn: [] },
    { id: 's2', title: 'Database', role: 'backend', instructions: 'Create tables.', files: ['src/db.ts'], dependsOn: ['s1'] },
    { id: 's3', title: 'Auth', role: 'backend', instructions: 'Hash passwords.', files: ['src/auth.ts'], dependsOn: ['s1'] },
  ],
  risks: [],
  verification: ['bun test'],
  outOfScope: [],
}

const ok = (stdout = ''): ExecResult => ({ ok: true, exitCode: 0, stdout, stderr: '', missing: false })
const fail = (stderr: string, missing = false): ExecResult => ({ ok: false, exitCode: 1, stdout: '', stderr, missing })

/** Records every git/gh invocation and answers from a table of matchers. */
function stubExec(answers: { match: RegExp; result: ExecResult }[]) {
  const calls: string[] = []
  setExecForTests(async (bin, args) => {
    const line = `${bin} ${args.join(' ')}`
    calls.push(line)
    const answer = answers.find((entry) => entry.match.test(line))
    return answer ? answer.result : ok()
  })
  return calls
}

afterEach(() => {
  setExecForTests()
})

test('a repository name is slugged from the directory, not the goal prose', () => {
  expect(repositoryName('/tmp/My Expense Tracker', proposal)).toBe('my-expense-tracker')
  expect(repositoryName('/tmp/.', proposal)).toBe('an-expense-tracker-api')
})

test('nothing is published when the GitHub CLI is missing, and the reason says so', async () => {
  stubExec([{ match: /^gh auth status/, result: fail('gh is not installed or not on PATH', true) }])

  const result = await publishProject({ cwd: '/tmp/project', proposal, governor: createActionGovernor({ mode: 'unattended' }) })

  expect(result.status).toBe('skipped')
  expect(result.reason).toContain('not installed')
})

test('nothing is published when gh is installed but not logged in', async () => {
  stubExec([{ match: /^gh auth status/, result: fail('You are not logged into any GitHub hosts') }])

  const result = await publishProject({ cwd: '/tmp/project', proposal, governor: createActionGovernor({ mode: 'unattended' }) })

  expect(result.status).toBe('skipped')
  expect(result.reason).toContain('gh auth login')
})

test('an unattended run with nobody to ask keeps the project local instead of publishing on a guess', async () => {
  const calls = stubExec([{ match: /^git remote get-url/, result: fail('no such remote') }])

  // No approval callback: there is no terminal, so the governor refuses.
  const result = await publishProject({ cwd: '/tmp/project', proposal, governor: createActionGovernor({ mode: 'unattended' }) })

  expect(result.status).toBe('skipped')
  expect(result.reason).toContain('unattended policy')
  expect(calls.some((call) => call.startsWith('gh repo create'))).toBe(false)
})

test('one approval creates a private repository, pushes it, and files the plan as issues under milestones', async () => {
  const calls = stubExec([
    { match: /^git remote get-url/, result: fail('no such remote') },
    { match: /^gh repo view/, result: ok('https://github.com/someone/project') },
  ])
  let asked = 0
  const governor = createActionGovernor({
    mode: 'unattended',
    approve: async () => {
      asked += 1
      return true
    },
  })

  const result = await publishProject({ cwd: '/tmp/project', proposal, governor })

  expect(asked).toBe(1)
  expect(result.status).toBe('created')
  expect(result.url).toBe('https://github.com/someone/project')
  // Two stages: s1, then s2 and s3 together.
  expect(result.milestones).toBe(2)
  expect(result.issues).toBe(3)

  const create = calls.find((call) => call.startsWith('gh repo create'))!
  expect(create).toContain('--private')
  expect(create).toContain('--push')
  // Milestones must exist before the issues that join them.
  expect(calls.findIndex((call) => call.includes('milestones'))).toBeLessThan(calls.findIndex((call) => call.startsWith('gh issue create')))
  expect(calls.filter((call) => call.startsWith('gh issue create')).every((call) => call.includes('--milestone'))).toBe(true)
})

test('an existing remote is pushed to rather than a second repository being created', async () => {
  const calls = stubExec([
    { match: /^git remote get-url/, result: ok('git@github.com:someone/project.git') },
    { match: /^git rev-parse --abbrev-ref/, result: ok('main') },
    { match: /^gh repo view/, result: ok('https://github.com/someone/project') },
  ])

  const result = await publishProject({ cwd: '/tmp/project', proposal, governor: createActionGovernor({ mode: 'unattended' }) })

  expect(result.status).toBe('pushed')
  expect(calls.some((call) => call.startsWith('gh repo create'))).toBe(false)
  expect(calls).toContain('git push --set-upstream origin main')
})

test('a failed push is reported rather than being reported as a successful publish', async () => {
  stubExec([
    { match: /^git remote get-url/, result: ok('git@github.com:someone/project.git') },
    { match: /^git push/, result: fail('rejected: non-fast-forward') },
  ])

  const result = await publishProject({ cwd: '/tmp/project', proposal, governor: createActionGovernor({ mode: 'unattended' }) })

  expect(result.status).toBe('skipped')
  expect(result.warnings.join(' ')).toContain('non-fast-forward')
})

test('a milestone that already exists is reused instead of being reported as a failure', async () => {
  stubExec([
    { match: /^git remote get-url/, result: ok('git@github.com:someone/project.git') },
    { match: /milestones/, result: fail('HTTP 422: Validation Failed (already_exists)') },
  ])

  const result = await publishProject({ cwd: '/tmp/project', proposal, governor: createActionGovernor({ mode: 'unattended' }) })

  expect(result.milestones).toBe(0)
  expect(result.issues).toBe(3)
  expect(result.warnings.filter((warning) => warning.includes('milestone'))).toEqual([])
})
