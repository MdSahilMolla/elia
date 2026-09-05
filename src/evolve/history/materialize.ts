import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ELIA_ROOT } from '../../statePaths.ts'
import { runGit } from '../../autonomy/worktree.ts'

/**
 * Builds the starting repository for a history task: elia's own tree at some
 * past commit, with a later commit's tests laid over it.
 *
 * Shared by the harvester (which uses it to prove a task is real) and the suite
 * (which uses it to set up a run), so a task is always graded in exactly the
 * environment it was validated in.
 */

/**
 * Writes the full tree of `sha` into `dir`.
 *
 * `git checkout <sha> -- .` rather than `git archive | tar`, because it needs no
 * external tar and no pipe: with `--work-tree` pointed at the destination and
 * `GIT_INDEX_FILE` pointed at a throwaway index, git writes the tree out without
 * touching the real repository's index or working tree at all.
 */
export async function checkoutTree(sha: string, dir: string, repoRoot = ELIA_ROOT): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const indexFile = join(dir, '.elia-bench-index')
  const result = await runGit(['--work-tree', dir, 'checkout', sha, '--', '.'], repoRoot, {
    GIT_INDEX_FILE: indexFile,
  })
  rmSync(indexFile, { force: true })
  if (result.exitCode !== 0) {
    throw new Error(`could not check out ${sha} into ${dir}: ${result.stderr || result.stdout}`)
  }
}

/** Reads one path's contents at one commit. */
export async function fileAtCommit(sha: string, path: string, repoRoot = ELIA_ROOT): Promise<string> {
  const result = await runGit(['show', `${sha}:${path}`], repoRoot)
  if (result.exitCode !== 0) throw new Error(`could not read ${path} at ${sha}: ${result.stderr}`)
  return result.stdout
}

/**
 * Points the task repo at elia's real `node_modules`.
 *
 * The tests being run are elia's own, so they need elia's own dependencies —
 * `ink`, `react`, the LSP client. Installing them per task would dominate the
 * benchmark's runtime and make it need a network. A directory link costs
 * nothing and resolves identically: Bun walks up from the importing file and
 * finds the link. `junction` is the Windows form that works without developer
 * mode or elevation.
 */
export function linkDependencies(dir: string, repoRoot = ELIA_ROOT): void {
  const target = join(repoRoot, 'node_modules')
  if (!existsSync(target)) throw new Error(`no node_modules at ${target}; run \`bun install\` first`)
  const link = join(dir, 'node_modules')
  if (existsSync(link)) return
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

export function writeFileInDir(dir: string, relativePath: string, content: string): void {
  const target = join(dir, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

/** Normalises line endings before hashing, so a checkout on Windows and one on Linux agree. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
}

export interface MaterializeOptions {
  parent: string
  sha: string
  testFiles: string[]
  dir: string
  repoRoot?: string
}

/**
 * The starting state for a task: the parent tree, plus the commit's tests, plus
 * linked dependencies. Returns the expected hash of each test file so `check`
 * can prove the agent did not edit the specification to make it pass.
 */
export async function materializeTask(options: MaterializeOptions): Promise<Map<string, string>> {
  const repoRoot = options.repoRoot ?? ELIA_ROOT
  await checkoutTree(options.parent, options.dir, repoRoot)
  linkDependencies(options.dir, repoRoot)

  const hashes = new Map<string, string>()
  for (const testFile of options.testFiles) {
    const content = await fileAtCommit(options.sha, testFile, repoRoot)
    writeFileInDir(options.dir, testFile, content)
    hashes.set(testFile, contentHash(content))
  }
  return hashes
}

/** A throwaway directory for one task run. */
export function makeTaskDir(id: string): string {
  return mkdtempSync(join(tmpdir(), `elia-hist-${id}-`))
}
