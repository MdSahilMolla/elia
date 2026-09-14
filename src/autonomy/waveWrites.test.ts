import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEvent } from '../agentLoop.ts'
import { execCapture } from '../github/exec.ts'
import { changedFilesFromResult, listChangedFiles } from '../tools/lspRefactor.ts'
import { commitAll, ensureRepository } from './scaffold.ts'
import { filesWrittenBy } from './waveWrites.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'elia-wave-writes-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function event(name: string, input: Record<string, unknown>, result = 'ok', isError = false): ToolEvent {
  return { name, input, result, isError, durationMs: 1, cached: false }
}

test('write_file and edit_file report the file they wrote, relative to the workspace', () => {
  expect(filesWrittenBy(event('write_file', { path: 'src/app.ts' }), root)).toEqual(['src/app.ts'])
  expect(filesWrittenBy(event('edit_file', { path: join(root, 'src', 'lib.ts') }), root)).toEqual(['src/lib.ts'])
})

test('a failed write changed nothing, so it attributes nothing', () => {
  expect(filesWrittenBy(event('edit_file', { path: 'src/app.ts' }, 'old_string not found', true), root)).toEqual([])
})

test('tools that do not write files attribute nothing', () => {
  expect(filesWrittenBy(event('read_file', { path: 'src/app.ts' }), root)).toEqual([])
  // A shell command can write anything; its output cannot say what, so it is
  // not attributed and those files stay in the tree uncommitted.
  expect(filesWrittenBy(event('run_command', { command: 'npm install' }), root)).toEqual([])
})

test('a path outside the workspace is never attributed to a wave', () => {
  expect(filesWrittenBy(event('write_file', { path: '../elsewhere/secret.ts' }), root)).toEqual([])
  expect(filesWrittenBy(event('write_file', { path: join(tmpdir(), 'not-this-project.ts') }), root)).toEqual([])
})

test('a rename attributes every file it changed, not just the one in its input', () => {
  // Committing only the input path would leave a checkpoint that does not compile.
  const result = `Renamed to "fetchUser": 7 edit(s) across 3 file(s):${listChangedFiles([
    join(root, 'src', 'api.ts'),
    join(root, 'src', 'routes', 'users.ts'),
    join(root, 'test', 'api.test.ts'),
  ])}`
  expect(filesWrittenBy(event('lsp_refactor', { action: 'rename', path: 'src/api.ts' }, result), root))
    .toEqual(['src/api.ts', 'src/routes/users.ts', 'test/api.test.ts'])
})

test('lsp_refactor results that changed nothing attribute nothing', () => {
  for (const result of [
    '1. Extract to function [refactor.extract]\n2. Inline variable [refactor.inline]',
    'No language server is configured/available for src/app.ts — lsp_refactor cannot follow references for this file type.',
    '"Organize imports" has no directly-applicable edit — nothing was changed.',
  ]) {
    expect(filesWrittenBy(event('lsp_refactor', { action: 'code_actions', path: 'src/app.ts' }, result), root)).toEqual([])
  }
})

test("lsp_refactor's changed-file list round-trips through its own writer", () => {
  // The reader lives beside the writer so that rewording the result breaks this
  // test rather than silently shrinking what the wave commit takes.
  const files = ['/work/a.ts', '/work/b c.ts', '/work/nested/d.ts']
  expect(changedFilesFromResult(`Applied "Fix all": 3 file(s) changed:${listChangedFiles(files)}`)).toEqual(files)
  expect(changedFilesFromResult(`Renamed to "x": 4 edit(s) across 3 file(s):${listChangedFiles(files)}`)).toEqual(files)
})

// --- The incident itself ------------------------------------------------------

async function git(...args: string[]) {
  return execCapture('git', args, root)
}

test('a wave commit takes what the wave wrote, and never the work that appeared beside it', async () => {
  // The recorded failure: a run's commit swept another session's in-flight
  // files in with its own, under a message about an unrelated goal. Here the
  // wave writes one file while a concurrent session writes another, mid-run,
  // after any snapshot could have been taken.
  await ensureRepository(root)
  writeFileSync(join(root, 'seed.ts'), 'export const seed = 0\n')
  await commitAll(root, 'seed')

  writeFileSync(join(root, 'feature.ts'), 'export const feature = 1\n')
  writeFileSync(join(root, 'someone-elses-wip.ts'), 'export const notMine = true\n')

  const written = new Set<string>()
  for (const file of filesWrittenBy(event('write_file', { path: 'feature.ts' }), root)) written.add(file)

  const commit = await commitAll(root, 'Wave 1: add feature', undefined, [], [...written])
  expect(commit.committed).toBe(true)

  const committed = (await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).stdout
  expect(committed).toContain('feature.ts')
  expect(committed).not.toContain('someone-elses-wip.ts')
  // And the other session's work is still sitting in the tree, untouched.
  expect((await git('status', '--porcelain')).stdout).toContain('someone-elses-wip.ts')
})

test('a wave that wrote nothing attributable commits nothing rather than everything', async () => {
  await ensureRepository(root)
  writeFileSync(join(root, 'seed.ts'), 'export const seed = 0\n')
  await commitAll(root, 'seed')
  const before = (await git('rev-parse', 'HEAD')).stdout.trim()

  // The wave only ran a shell command; a concurrent session wrote a file.
  writeFileSync(join(root, 'someone-elses-wip.ts'), 'export const notMine = true\n')
  const written = filesWrittenBy(event('run_command', { command: 'npm test' }), root)

  const commit = await commitAll(root, 'Wave 1', undefined, [], written)
  expect(commit.committed).toBe(false)
  expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(before)
  expect((await git('status', '--porcelain')).stdout).toContain('someone-elses-wip.ts')
})
