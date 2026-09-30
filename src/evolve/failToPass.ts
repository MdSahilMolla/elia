import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ShellResult } from '../shell.ts'

/**
 * A test that could have failed.
 *
 * A candidate that ships a test for its change has shown it cares; a candidate
 * whose new test also passes on the code it replaced has shown nothing, because
 * that test does not depend on the change. This is the standard the field uses
 * for a fix (the test fails before, passes after), applied to the one edit to
 * the suite a candidate may make.
 *
 * The candidate's new test files are laid over a fresh copy of the *live* tree
 * and run there. At least one has to fail — including by not loading, which is
 * what a test for a function that does not exist yet does. That the same files
 * pass in the candidate is already known: the gate ran the whole suite there.
 *
 * Nothing here is allowed to reject on its own inability to run: if the copy or
 * the run cannot happen, the answer is "not checked", which the caller reports
 * and does not count against the candidate.
 *
 * Immutable to the loop (sandbox.ts).
 */

/** What is copied from the live tree: enough for `bun test` to mean what it means there. */
const COPIED = ['src', 'package.json', 'tsconfig.json', 'bunfig.toml', 'scripts', 'values']

export interface FailToPass {
  /** False when the check could not be carried out. */
  checked: boolean
  /** True when at least one new test fails without the change. */
  proves: boolean
  detail: string
}

export interface FailToPassOptions {
  liveRoot: string
  candidateRoot: string
  /** Repo-relative new test files. */
  testFiles: readonly string[]
  /** Runs a command in a directory: the same gate runner the candidate's own tests used, boxed when configured. */
  run: (command: string, cwd: string) => Promise<Pick<ShellResult, 'exitCode' | 'stdout' | 'stderr'>>
  /** Where the scratch copy goes. Inside the live root so `node_modules` resolves by walking up, as it does for sandboxes. */
  scratchParent?: string
}

const quote = (file: string) => `'${file.replace(/'/g, `'\\''`)}'`

export async function failToPass(options: FailToPassOptions): Promise<FailToPass> {
  if (options.testFiles.length === 0) return { checked: false, proves: false, detail: 'no new test files to check' }
  const parent = options.scratchParent ?? join(options.liveRoot, '.evolution')
  let scratch: string | undefined
  try {
    mkdirSync(parent, { recursive: true })
    scratch = mkdtempSync(join(parent, 'f2p-'))
    for (const entry of COPIED) {
      const from = join(options.liveRoot, entry)
      if (existsSync(from)) cpSync(from, join(scratch, entry), { recursive: true })
    }
    for (const file of options.testFiles) {
      const to = join(scratch, file)
      mkdirSync(dirname(to), { recursive: true })
      cpSync(join(options.candidateRoot, file), to)
    }
    const result = await options.run(`bun test ${options.testFiles.map(quote).join(' ')}`, scratch)
    if (result.exitCode === 0) {
      return { checked: true, proves: false, detail: `every new test also passes without the change (${options.testFiles.join(', ')}) — they do not depend on it` }
    }
    const firstFailure = `${result.stdout}\n${result.stderr}`.split('\n').find((line) => /\(fail\)|error:/i.test(line))?.trim()
    return { checked: true, proves: true, detail: `fails without the change${firstFailure ? `: ${firstFailure.slice(0, 160)}` : ''}` }
  } catch (error) {
    return { checked: false, proves: false, detail: `could not run the check: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}
