import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureTreeSnapshot, isGitRepo, restoreTreeSnapshot } from './treeSnapshot.ts'
import { runGit } from './worktree.ts'

let repo: string
let store: string

async function git(...args: string[]) {
  const r = await runGit(args, repo)
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'elia-snap-'))
  store = mkdtempSync(join(tmpdir(), 'elia-snap-store-'))
  await git('init', '-q')
  await git('config', 'user.email', 't@t.t')
  await git('config', 'user.name', 't')
  await git('config', 'core.autocrlf', 'false') // keep LF on checkout so byte assertions hold on Windows
  writeFileSync(join(repo, 'a.txt'), 'committed A\n')
  writeFileSync(join(repo, 'b.txt'), 'committed B\n')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'init')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
})

test('isGitRepo is true inside a repo and false outside', async () => {
  expect(await isGitRepo(repo)).toBe(true)
  expect(await isGitRepo(store)).toBe(false)
})

test('captureTreeSnapshot returns undefined outside a git repo', async () => {
  expect(await captureTreeSnapshot(store, store)).toBeUndefined()
})

test('restore puts a good checkpoint back and discards every edit made after it', async () => {
  // Green checkpoint: a.txt edited, new file c.txt added.
  writeFileSync(join(repo, 'a.txt'), 'good edit to A\n')
  writeFileSync(join(repo, 'c.txt'), 'new file at checkpoint\n')
  const snapshot = (await captureTreeSnapshot(repo, store))!
  expect(snapshot.clean).toBe(false)

  // The failed repair phase: mangles a.txt, deletes c.txt, adds junk, breaks b.txt.
  writeFileSync(join(repo, 'a.txt'), 'BROKEN\n')
  rmSync(join(repo, 'c.txt'))
  writeFileSync(join(repo, 'b.txt'), 'also broken\n')
  writeFileSync(join(repo, 'junk.txt'), 'garbage from the failed attempt\n')

  const { warnings } = await restoreTreeSnapshot(snapshot)
  expect(warnings).toEqual([])

  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('good edit to A\n')
  expect(readFileSync(join(repo, 'c.txt'), 'utf8')).toBe('new file at checkpoint\n')
  expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('committed B\n') // never part of the good checkpoint → back to HEAD
  expect(existsSync(join(repo, 'junk.txt'))).toBe(false)
})

test('a clean checkpoint (nothing dirty) restores the tree to pristine HEAD', async () => {
  const snapshot = (await captureTreeSnapshot(repo, store))!
  expect(snapshot.clean).toBe(true)

  writeFileSync(join(repo, 'a.txt'), 'changed after a clean snapshot\n')
  writeFileSync(join(repo, 'extra.txt'), 'added after a clean snapshot\n')

  await restoreTreeSnapshot(snapshot)
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('committed A\n')
  expect(existsSync(join(repo, 'extra.txt'))).toBe(false)
})

test('a file deleted at checkpoint time stays deleted after restore', async () => {
  rmSync(join(repo, 'b.txt'))
  const snapshot = (await captureTreeSnapshot(repo, store))!

  // Failed repair brings it back with wrong content.
  writeFileSync(join(repo, 'b.txt'), 'resurrected wrongly\n')

  await restoreTreeSnapshot(snapshot)
  expect(existsSync(join(repo, 'b.txt'))).toBe(false)
})
