import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execCapture } from '../github/exec.ts'
import { ELIA_ROOT } from '../statePaths.ts'
import { initOwnRepository, provisionTaskWorkspace } from './taskWorkspace.ts'

const created: string[] = []

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

function isolated(runId: string) {
  const workspace = provisionTaskWorkspace({ runId, goal: 'build a guitar shop', launchedFrom: ELIA_ROOT })
  created.push(workspace.root)
  return workspace
}

test('a run launched from the elia checkout gets a workspace that is its own git repository', async () => {
  const workspace = isolated(`test-${Date.now()}-own-repo`)
  expect(workspace.kind).toBe('isolated')
  // Checked first so a failure names what `git init` answered, not just that
  // there is no `.git` — this failed in a sibling session's full runs with no
  // other clue.
  expect(workspace.repositoryWarning).toBeUndefined()
  expect(existsSync(join(workspace.root, '.git'))).toBe(true)

  // Before this, git resolved every call made from here to elia's checkout —
  // the review diff, the rewind snapshot, the "already dirty" list.
  const toplevel = await execCapture('git', ['rev-parse', '--show-toplevel'], workspace.root)
  expect(realpathSync(toplevel.stdout)).toBe(realpathSync(workspace.root))
})

test('a .git left without a HEAD — an init killed part-way — is initialised again, not trusted', () => {
  const runId = `test-${Date.now()}-torn-init`
  const first = isolated(runId)
  rmSync(join(first.root, '.git'), { recursive: true, force: true })
  mkdirSync(join(first.root, '.git'))

  const again = isolated(runId)
  expect(again.repositoryWarning).toBeUndefined()
  expect(existsSync(join(again.root, '.git', 'HEAD'))).toBe(true)
})

test('a git init that cannot run is reported with its reason, not swallowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-init-fails-'))
  created.push(dir)
  const warning = initOwnRepository(dir, 'elia-no-such-git-binary')
  expect(warning).toContain('could not give this workspace a repository of its own')
  expect(warning).toContain('ENOENT')
  expect(existsSync(join(dir, '.git'))).toBe(false)
})

test('provisioning the same run again keeps the history it already has', async () => {
  const runId = `test-${Date.now()}-resume`
  const first = isolated(runId)
  // Refuse to go on unless the workspace really is its own repository. Without
  // this guard, a regression would make the `git add -A` + `git commit` below
  // resolve to the elia checkout the test runs in and commit whatever is
  // uncommitted there — which is exactly what this test did once, against the
  // pre-fix code.
  const toplevel = await execCapture('git', ['rev-parse', '--show-toplevel'], first.root)
  expect(toplevel.ok && realpathSync(toplevel.stdout) === realpathSync(first.root)).toBe(true)
  writeFileSync(join(first.root, 'index.html'), '<h1>kept</h1>')
  await execCapture('git', ['add', '-A'], first.root)
  const commit = await execCapture('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-q', '-m', 'wave 1'], first.root)
  expect(commit.ok).toBe(true)

  const again = isolated(runId)
  expect(again.root).toBe(first.root)
  const log = await execCapture('git', ['log', '--format=%s'], again.root)
  expect(log.stdout).toBe('wave 1')
})
