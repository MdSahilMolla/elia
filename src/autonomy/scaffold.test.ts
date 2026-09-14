import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execCapture } from '../github/exec.ts'
import { commitAll, ensureRepository, renderProjectDocs, scaffoldProject, stageUntrackedForReview } from './scaffold.ts'
import type { Proposal } from './types.ts'

let dir: string

const proposal: Proposal = {
  goal: 'An expense tracker API with per-user isolation',
  understanding: 'Empty directory. Bun is available; there is no package.json yet.',
  assumptions: ['Passwords will be hashed with bcryptjs', 'SQLite via bun:sqlite is sufficient'],
  steps: [
    { id: 's1', title: 'Create the manifest', role: 'builder', instructions: 'Write package.json.\nSecond line.', files: ['package.json'], dependsOn: [] },
    { id: 's2', title: 'Database schema', role: 'backend', instructions: 'Create tables.', files: ['src/db.ts'], dependsOn: ['s1'] },
    { id: 's3', title: 'Auth helpers', role: 'backend', instructions: 'Hash and verify.', files: ['src/auth.ts'], dependsOn: ['s1'] },
    { id: 's4', title: 'Test suite', role: 'tester', instructions: 'Cover isolation.', files: ['src/api.test.ts'], dependsOn: ['s2', 's3'] },
  ],
  risks: ['SQLite file permissions on Windows'],
  verification: ['bun run typecheck', 'bun test'],
  outOfScope: ['Deployment', 'A frontend'],
  acceptanceCriteria: ['One user cannot read another user’s expenses', 'bun test passes'],
  sideEffects: ['Creates expenses.db in the project root'],
  recovery: ['Re-run bun install if a dependency is missing'],
}

async function git(...args: string[]) {
  return execCapture('git', args, dir)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-scaffold-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// --- documents ---

test('the PRD carries the acceptance criteria, scope, assumptions and risks that were approved', () => {
  const docs = renderProjectDocs('build me an expense tracker', proposal)
  const prd = docs.find((doc) => doc.path === 'docs/PRD.md')!.content

  expect(prd).toContain('build me an expense tracker')
  expect(prd).toContain('One user cannot read another user')
  expect(prd).toContain('Deployment')
  expect(prd).toContain('bcryptjs')
  expect(prd).toContain('SQLite file permissions on Windows')
})

test('the architecture doc groups steps into dependency stages, not a flat list', () => {
  const architecture = renderProjectDocs('goal', proposal).find((doc) => doc.path === 'docs/ARCHITECTURE.md')!.content

  // s1 alone, then s2+s3 together (both depend only on s1), then s4.
  expect(architecture).toContain('### Stage 1')
  expect(architecture).toContain('### Stage 2 — 2 pieces, independent of each other')
  expect(architecture).toContain('### Stage 3')
  expect(architecture).toContain('`bun test`')
})

test('the ADR records what was decided and what was knowingly accepted', () => {
  const adr = renderProjectDocs('goal', proposal).find((doc) => doc.path === 'docs/adr/0001-initial-approach.md')!.content

  expect(adr).toContain('Status:** accepted')
  expect(adr).toContain('Build it in 4 step(s)')
  expect(adr).toContain('SQLite file permissions on Windows')
})

test('a plan with no acceptance criteria says so instead of rendering an empty section', () => {
  const prd = renderProjectDocs('goal', { ...proposal, acceptanceCriteria: [] }).find((doc) => doc.path === 'docs/PRD.md')!.content
  expect(prd).toContain('"done" is undefined')
})

// --- repository ---

test('a directory that is not a repository becomes one, and an existing repository is left alone', async () => {
  expect((await ensureRepository(dir)).initialized).toBe(true)
  expect(existsSync(join(dir, '.git'))).toBe(true)
  expect((await ensureRepository(dir)).initialized).toBe(false)
})

// --- commits ---

test('a file holding secrets is kept out of the commit even when it was staged', async () => {
  await ensureRepository(dir)
  writeFileSync(join(dir, 'index.ts'), 'export const x = 1')
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-live-do-not-commit')

  const result = await commitAll(dir, 'first')
  expect(result.committed).toBe(true)
  expect(result.excluded).toEqual(['.env'])

  const tracked = (await git('ls-files')).stdout
  expect(tracked).toContain('index.ts')
  expect(tracked).not.toContain('.env')
})

test('a commit with nothing but secrets in it is not made at all', async () => {
  await ensureRepository(dir)
  writeFileSync(join(dir, '.env'), 'SECRET=1')

  const result = await commitAll(dir, 'nope')
  expect(result.committed).toBe(false)
  expect(result.excluded).toEqual(['.env'])
})

test('pre-existing uncommitted work is protected — committed on disk, not swept into the run commit', async () => {
  await ensureRepository(dir)
  writeFileSync(join(dir, 'existing.ts'), 'export const wip = true')
  writeFileSync(join(dir, 'scaffolded.ts'), 'export const fresh = true')

  const result = await commitAll(dir, 'run commit', undefined, ['existing.ts'])
  expect(result.committed).toBe(true)

  const tracked = (await git('ls-files')).stdout
  expect(tracked).toContain('scaffolded.ts')
  expect(tracked).not.toContain('existing.ts')
  // The protected file is untouched on disk and still visible as a change.
  expect(readFileSync(join(dir, 'existing.ts'), 'utf8')).toBe('export const wip = true')
  expect((await git('status', '--porcelain')).stdout).toContain('existing.ts')
})

// --- review staging ---

test('stageUntrackedForReview makes a new file visible to `git diff HEAD` without staging it for commit', async () => {
  await ensureRepository(dir)
  writeFileSync(join(dir, 'README.md'), '# seed')
  await commitAll(dir, 'seed')

  writeFileSync(join(dir, 'index.html'), '<html></html>')
  expect((await git('diff', 'HEAD', '--', 'index.html')).stdout.trim()).toBe('')

  await stageUntrackedForReview(dir)

  const diff = await git('diff', 'HEAD', '--', 'index.html')
  expect(diff.stdout).toContain('index.html')
  expect(diff.stdout).toContain('new file mode')
  // Visible to a diff, but not actually staged for a real commit.
  expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('')
})

test('stageUntrackedForReview never surfaces a protected pre-existing file or a secret-looking one', async () => {
  await ensureRepository(dir)
  writeFileSync(join(dir, 'README.md'), '# seed')
  await commitAll(dir, 'seed')

  writeFileSync(join(dir, 'existing-untracked.ts'), 'export const wip = true')
  writeFileSync(join(dir, '.env'), 'SECRET=1')
  writeFileSync(join(dir, 'index.html'), '<html></html>')

  await stageUntrackedForReview(dir, undefined, ['existing-untracked.ts'])

  const diff = (await git('diff', 'HEAD', '--numstat')).stdout
  expect(diff).toContain('index.html')
  expect(diff).not.toContain('existing-untracked.ts')
  expect(diff).not.toContain('.env')
})

test('a scoped commit never sweeps concurrent changes outside the worker-owned files', async () => {
  await ensureRepository(dir)
  writeFileSync(join(dir, 'owned.ts'), 'export const owned = 0')
  writeFileSync(join(dir, 'other.ts'), 'export const other = 0')
  await commitAll(dir, 'seed')

  writeFileSync(join(dir, 'owned.ts'), 'export const owned = 1')
  writeFileSync(join(dir, 'other.ts'), 'export const other = 1')
  const result = await commitAll(dir, 'worker change', undefined, [], ['owned.ts'])

  expect(result.committed).toBe(true)
  expect(result.warning).toContain('other.ts')
  const committed = (await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).stdout
  expect(committed).toContain('owned.ts')
  expect(committed).not.toContain('other.ts')
  expect((await git('status', '--porcelain')).stdout).toContain('other.ts')
})

test('an empty include list commits nothing, and leaves every change in the tree', async () => {
  // This used to assert the opposite: an empty allowlist meant "no scope
  // restriction", so a wave whose steps declared no files committed everything
  // staged — which is how another session's in-flight work was swept into a
  // commit for an unrelated goal, twice. An empty allowlist is a caller that
  // owns nothing, and the only safe commit for it is none.
  await ensureRepository(dir)
  writeFileSync(join(dir, 'seed.ts'), 'export const seed = 0')
  await commitAll(dir, 'seed')
  const before = (await git('rev-parse', 'HEAD')).stdout.trim()

  writeFileSync(join(dir, 'a.ts'), 'export const a = 0')
  writeFileSync(join(dir, 'b.ts'), 'export const b = 0')

  const result = await commitAll(dir, 'wave commit', undefined, [], [])

  expect(result.committed).toBe(false)
  expect(result.warning).toContain('owns no files')
  expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(before)
  // Nothing lost: both changes are still sitting in the tree, unstaged.
  const status = (await git('status', '--porcelain')).stdout
  expect(status).toContain('a.ts')
  expect(status).toContain('b.ts')
  expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('')
})

test('no allowlist at all still commits everything — the freshly initialised repo case', async () => {
  // `undefined` and `[]` must not be confused again: a brand-new repository has
  // nothing pre-existing to protect, so its first commit takes what is there.
  await ensureRepository(dir)
  writeFileSync(join(dir, 'a.ts'), 'export const a = 0')
  const result = await commitAll(dir, 'initial')
  expect(result.committed).toBe(true)
  // `ls-tree`, not `diff-tree`: this is the root commit, and diff-tree shows a
  // parentless commit as empty unless told `--root`.
  expect((await git('ls-tree', '-r', '--name-only', 'HEAD')).stdout).toContain('a.ts')
})

test('scaffoldProject in a dirty repo leaves the operator’s changes alone', async () => {
  await ensureRepository(dir)
  writeFileSync(join(dir, 'seed.ts'), 'export const seed = 1')
  await git('add', '-A')
  await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed')
  writeFileSync(join(dir, 'seed.ts'), 'export const seed = 2 // my uncommitted edit')

  const result = await scaffoldProject({ cwd: dir, goal: 'goal', proposal, protect: ['seed.ts'] })
  expect(result.warnings.join(' ')).not.toContain('git commit failed')

  expect((await git('show', 'HEAD:seed.ts')).stdout.trim()).toBe('export const seed = 1')
  expect(readFileSync(join(dir, 'seed.ts'), 'utf8')).toContain('my uncommitted edit')
})

// --- the whole scaffold ---

test('scaffolding an empty directory leaves a repository, ignore rules, documents, and one commit', async () => {
  const result = await scaffoldProject({ cwd: dir, goal: 'build me an expense tracker', proposal })

  expect(result.initialized).toBe(true)
  expect(result.documents).toContain('.gitignore')
  expect(result.documents).toContain('docs/PRD.md')
  expect(result.commits).toHaveLength(1)
  expect(result.warnings).toEqual([])

  const log = (await git('log', '--oneline')).stdout
  expect(log).toContain('Initial commit')
  const tracked = (await git('ls-files')).stdout
  expect(tracked).toContain('docs/PRD.md')
  expect(tracked).toContain('docs/adr/0001-initial-approach.md')
})

test('the generated ignore rules keep dependencies, databases and secrets out of the first commit', async () => {
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-live')
  mkdirp(join(dir, 'node_modules', 'left-pad'))
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1')
  writeFileSync(join(dir, 'app.db'), 'sqlite')
  writeFileSync(join(dir, 'src.ts'), 'export const x = 1')

  await scaffoldProject({ cwd: dir, goal: 'goal', proposal })

  const tracked = (await git('ls-files')).stdout
  expect(tracked).toContain('src.ts')
  expect(tracked).not.toContain('node_modules')
  expect(tracked).not.toContain('app.db')
  expect(tracked).not.toContain('.env')
})

test("documents the project already has are never overwritten by the run's plan", async () => {
  mkdirp(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'PRD.md'), '# Our own PRD, written by a person')

  const result = await scaffoldProject({ cwd: dir, goal: 'goal', proposal })

  expect(result.documents).not.toContain('docs/PRD.md')
  expect(readFileSync(join(dir, 'docs', 'PRD.md'), 'utf8')).toBe('# Our own PRD, written by a person')
})

test('an existing repository keeps its history and just gains the documents', async () => {
  await ensureRepository(dir)
  writeFileSync(join(dir, 'existing.ts'), 'export const x = 1')
  await commitAll(dir, 'existing work')

  const result = await scaffoldProject({ cwd: dir, goal: 'goal', proposal })

  expect(result.initialized).toBe(false)
  const log = (await git('log', '--oneline')).stdout.split('\n')
  expect(log).toHaveLength(2)
  expect(log[0]).toContain('Add project documents')
})

function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true })
}

test('scaffoldProject does not commit work that appeared after the run started', async () => {
  // The incident this guards against, reproduced: `protect` is a snapshot taken
  // when the run began, so it is blind to files created while the run is in
  // flight — another agent in the same checkout, or the operator still working.
  // A scaffold for an unrelated goal swept ~28 files of a concurrent session's
  // work into a commit titled "Add project documents for: <a dashboard>".
  await git('init', '-b', 'main')
  writeFileSync(join(dir, 'seed.ts'), 'export const seed = 1\n')
  await git('add', '-A')
  await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed')

  // Nothing dirty when the run starts, so `protect` is legitimately empty.
  const protect: string[] = []

  // A concurrent session writes files *after* that snapshot.
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/someone-elses-work.ts'), 'export const wip = true\n')
  writeFileSync(join(dir, 'unrelated.md'), '# not mine\n')

  const result = await scaffoldProject({ cwd: dir, goal: 'goal', proposal, protect })
  expect(result.commits.length).toBe(1)

  const committed = (await git('show', '--stat', '--name-only', '--format=', 'HEAD')).stdout
  expect(committed).not.toContain('someone-elses-work.ts')
  expect(committed).not.toContain('unrelated.md')
  // And the concurrent work is still sitting in the tree, untouched.
  expect(existsSync(join(dir, 'src/someone-elses-work.ts'))).toBe(true)
  // `--untracked-files=all`: plain porcelain collapses an untracked directory
  // to `?? src/` and would hide which file survived.
  expect((await git('status', '--porcelain', '--untracked-files=all')).stdout).toContain('someone-elses-work.ts')
})

test('scaffoldProject commits nothing rather than everything when it wrote no documents', async () => {
  // `commitAll` reads an empty allowlist as "no allowlist", so a scaffold that
  // wrote nothing would otherwise commit the whole tree.
  await git('init', '-b', 'main')
  writeFileSync(join(dir, 'seed.ts'), 'export const seed = 1\n')
  await git('add', '-A')
  await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed')

  // Everything the scaffold would write already exists, so it writes nothing.
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  for (const document of renderProjectDocs('goal', proposal)) {
    const target = join(dir, document.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, 'already here\n')
  }
  writeFileSync(join(dir, 'concurrent.ts'), 'export const wip = true\n')

  const result = await scaffoldProject({ cwd: dir, goal: 'goal', proposal, protect: [] })
  expect(result.commits).toEqual([])
  expect((await git('status', '--porcelain')).stdout).toContain('concurrent.ts')
})
