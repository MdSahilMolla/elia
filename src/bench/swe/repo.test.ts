import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../../autonomy/worktree.ts'
import { applyPatch, checkoutFromLocalGitDir, ensureRepoCached } from './repo.ts'

// Windows git can check files out with CRLF endings depending on core.autocrlf
// even when they were written with plain \n — normalize before comparing
// content, the same way harvest.ts's contentHash already does "so a checkout
// on Windows and one on Linux agree".
function readNormalized(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

let srcRepo: string
let bareRepo: string
let shaV1: string
let shaV2: string
const dirsToClean: string[] = []

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

beforeEach(async () => {
  // A real local repo and a real bare clone of it — the exact shape
  // checkoutInstanceTree uses (shared bare cache, per-instance checkout) —
  // built entirely offline, so this doesn't depend on network access. The
  // real network-clone half (ensureRepoCached's `git clone --bare
  // https://github.com/...`) was verified by hand against a real tiny public
  // repo (octocat/Hello-World) before writing this file, and isn't re-run on
  // every test invocation.
  srcRepo = mkdtempSync(join(tmpdir(), 'elia-swebench-src-'))
  dirsToClean.push(srcRepo)
  await git(['init', '-q'], srcRepo)
  await git(['config', 'user.email', 't@t.com'], srcRepo)
  await git(['config', 'user.name', 't'], srcRepo)
  writeFileSync(join(srcRepo, 'app.py'), "print('v1')\n")
  await git(['add', '-A'], srcRepo)
  await git(['commit', '-q', '-m', 'v1'], srcRepo)
  shaV1 = (await runGit(['rev-parse', 'HEAD'], srcRepo)).stdout.trim()
  writeFileSync(join(srcRepo, 'app.py'), "print('v2')\n")
  await git(['add', '-A'], srcRepo)
  await git(['commit', '-q', '-m', 'v2'], srcRepo)
  shaV2 = (await runGit(['rev-parse', 'HEAD'], srcRepo)).stdout.trim()

  bareRepo = mkdtempSync(join(tmpdir(), 'elia-swebench-bare-')) + '.git'
  dirsToClean.push(bareRepo)
  await git(['clone', '-q', '--bare', srcRepo, bareRepo], tmpdir())
})

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('checkoutFromLocalGitDir writes the exact tree at the given commit', async () => {
  const workV1 = await checkoutFromLocalGitDir(bareRepo, shaV1, 'test-v1')
  dirsToClean.push(workV1)
  expect(readNormalized(join(workV1, 'app.py'))).toBe("print('v1')\n")

  const workV2 = await checkoutFromLocalGitDir(bareRepo, shaV2, 'test-v2')
  dirsToClean.push(workV2)
  expect(readNormalized(join(workV2, 'app.py'))).toBe("print('v2')\n")
})

test('checkoutFromLocalGitDir on an unknown commit throws with a clear message instead of silently producing an empty tree', async () => {
  await expect(checkoutFromLocalGitDir(bareRepo, 'not-a-real-commit-sha', 'test-bad')).rejects.toThrow(/could not check out/)
})

test('applyPatch applies a real unified diff to a checked-out tree with no .git directory present', async () => {
  const work = await checkoutFromLocalGitDir(bareRepo, shaV1, 'test-patch')
  dirsToClean.push(work)
  const patch = ['--- a/app.py', '+++ b/app.py', '@@ -1 +1,2 @@', " print('v1')", "+print('patched')", ''].join('\n')
  await applyPatch(work, patch)
  expect(readNormalized(join(work, 'app.py'))).toBe("print('v1')\nprint('patched')\n")
})

test('applyPatch is a no-op for an empty patch', async () => {
  const work = await checkoutFromLocalGitDir(bareRepo, shaV1, 'test-empty-patch')
  dirsToClean.push(work)
  await expect(applyPatch(work, '')).resolves.toBeUndefined()
  expect(readNormalized(join(work, 'app.py'))).toBe("print('v1')\n")
})

test('applyPatch throws with git\'s own message when the patch does not apply cleanly', async () => {
  const work = await checkoutFromLocalGitDir(bareRepo, shaV1, 'test-bad-patch')
  dirsToClean.push(work)
  const patch = ['--- a/app.py', '+++ b/app.py', '@@ -1 +1,2 @@', ' this context line does not exist in the file', '+print("patched")', ''].join('\n')
  await expect(applyPatch(work, patch)).rejects.toThrow(/did not apply cleanly/)
})

test('ensureRepoCached refuses a repo string that is not "owner/repo", before ever touching the network', async () => {
  await expect(ensureRepoCached('../not-a-repo')).rejects.toThrow(/expected "owner\/repo"/)
  await expect(ensureRepoCached('just-one-segment')).rejects.toThrow(/expected "owner\/repo"/)
  await expect(ensureRepoCached('owner/repo; rm -rf /')).rejects.toThrow(/expected "owner\/repo"/)
})
