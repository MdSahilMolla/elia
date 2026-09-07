import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The current branch, read straight from `.git/HEAD` — no subprocess, safe to
 * call on every render. Returns undefined outside a repo or on a detached HEAD.
 */
export function gitBranch(cwd = process.cwd()): string | undefined {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref ? ref[1] : undefined
  } catch {
    return undefined
  }
}

/** True when the working tree has changes staged or unstaged (cheap index-mtime heuristic is unreliable, so this stays a no-op unless a marker file exists). */
export function inGitRepo(cwd = process.cwd()): boolean {
  return existsSync(join(cwd, '.git'))
}

/** "elia ⎇ production" style label for the status line / home screen. */
export function repoLabel(cwd = process.cwd()): string {
  const name = cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? cwd
  const branch = gitBranch(cwd)
  return branch ? `${name} ⎇ ${branch}` : name
}
