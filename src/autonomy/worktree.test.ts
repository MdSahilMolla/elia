import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// worktree.ts pulls `paths` from config.ts, which resolves a provider on import.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-worktree-test'

const { createWorktree, mergeWorktreeIntoCwd, removeWorktree } = await import('./worktree.ts')

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe', cwd })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

let repoDir: string
let stateDir: string

beforeEach(async () => {
  // A space in the temp dir name specifically exercises the cmd.exe /c
  // re-lexing bug this module was built to route around (see worktree.ts's
  // runGit doc comment) — real machines commonly have one in the user's home
  // directory (`C:\Users\Jane Doe\...`), and that's exactly what broke live.
  repoDir = mkdtempSync(join(tmpdir(), 'elia worktree test-'))
  stateDir = join(repoDir, '.elia-test-state')
  await git(['init', '-q'], repoDir)
  await git(['config', 'user.email', 'test@test.com'], repoDir)
  await git(['config', 'user.name', 'Test'], repoDir)
  // Otherwise a machine with core.autocrlf=true (common on Windows) rewrites
  // LF to CRLF on checkout, and every content assertion below would be
  // testing this host's git config instead of createWorktree's own logic.
  await git(['config', 'core.autocrlf', 'false'], repoDir)
  writeFileSync(join(repoDir, 'committed.txt'), 'original\n')
  await git(['add', '-A'], repoDir)
  await git(['commit', '-q', '-m', 'init'], repoDir)
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

test('createWorktree checks out HEAD on a fresh branch at the expected path', async () => {
  const worktree = await createWorktree('runA', 0, repoDir, stateDir)

  expect(worktree.branch).toBe('elia/variant-runA-0')
  expect(worktree.path).toBe(join(stateDir, 'worktrees', 'runA', 'v0'))
  expect(await Bun.file(join(worktree.path, 'committed.txt')).text()).toBe('original\n')

  await removeWorktree(worktree, repoDir)
})

test('createWorktree seeds the new worktree with the source repo\'s uncommitted changes', async () => {
  // Dirty the source repo before creating the worktree: modify a tracked
  // file, add a new untracked one — exactly what a real elia auto run's
  // working tree could look like when --variants kicks in.
  writeFileSync(join(repoDir, 'committed.txt'), 'modified before variant\n')
  writeFileSync(join(repoDir, 'untracked.txt'), 'brand new\n')

  const worktree = await createWorktree('runB', 0, repoDir, stateDir)

  expect(await Bun.file(join(worktree.path, 'committed.txt')).text()).toBe('modified before variant\n')
  expect(await Bun.file(join(worktree.path, 'untracked.txt')).text()).toBe('brand new\n')

  await removeWorktree(worktree, repoDir)
})

test('mergeWorktreeIntoCwd copies added/modified files and deletes removed ones', async () => {
  const worktree = await createWorktree('runC', 0, repoDir, stateDir)

  // Simulate a variant's builders doing work: modify the committed file, add
  // a new one, and delete... nothing yet, that's the next assertion.
  writeFileSync(join(worktree.path, 'committed.txt'), 'changed by variant\n')
  writeFileSync(join(worktree.path, 'new-file.txt'), 'added by variant\n')

  const targetDir = mkdtempSync(join(tmpdir(), 'elia-merge-target-'))
  writeFileSync(join(targetDir, 'committed.txt'), 'original\n')

  try {
    const touched = await mergeWorktreeIntoCwd(worktree, targetDir)

    expect(touched.sort()).toEqual(['committed.txt', 'new-file.txt'])
    expect(await Bun.file(join(targetDir, 'committed.txt')).text()).toBe('changed by variant\n')
    expect(await Bun.file(join(targetDir, 'new-file.txt')).text()).toBe('added by variant\n')
  } finally {
    rmSync(targetDir, { recursive: true, force: true })
    await removeWorktree(worktree, repoDir)
  }
})

test('mergeWorktreeIntoCwd deletes files the variant deleted', async () => {
  const worktree = await createWorktree('runD', 0, repoDir, stateDir)
  await git(['rm', '-q', 'committed.txt'], worktree.path)

  const targetDir = mkdtempSync(join(tmpdir(), 'elia-merge-target-'))
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'committed.txt'), 'still here in target\n')

  try {
    const touched = await mergeWorktreeIntoCwd(worktree, targetDir)

    expect(touched).toEqual(['committed.txt'])
    expect(await Bun.file(join(targetDir, 'committed.txt')).exists()).toBe(false)
  } finally {
    rmSync(targetDir, { recursive: true, force: true })
    await removeWorktree(worktree, repoDir)
  }
})

test('removeWorktree tears down both the worktree and its branch', async () => {
  const worktree = await createWorktree('runE', 0, repoDir, stateDir)

  await removeWorktree(worktree, repoDir)

  const list = await git(['worktree', 'list'], repoDir)
  expect(list.stdout).not.toContain('runE')
  const branches = await git(['branch'], repoDir)
  expect(branches.stdout).not.toContain('elia/variant-runE-0')
})
