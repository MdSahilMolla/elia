import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { FileSnapshot } from '../checkpoint.ts'

/**
 * Dependency trees, build output, lockfiles and minified bundles: machine-made,
 * never what a reviewer is being asked to judge, and by far the largest thing
 * in a fresh project's tree.
 */
const GENERATED_PATH =
  /(?:^|[\\/])(?:node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|target|coverage|\.git|\.elia|__pycache__|\.venv)(?:[\\/]|$)|(?:^|[\\/])(?:bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|uv\.lock)$|\.min\.(?:js|css)$|\.map$/i

export interface TurnDiff {
  /** A unified diff of every reviewable file the turn changed; empty when there is none. */
  text: string
  /** Display paths of the files in `text`, relative to the root. */
  files: string[]
  /**
   * Absolute paths of the same files. Reviewers read the changed files by path,
   * and given only root-relative ones they guessed the base: session
   * mu0ty0ty-ywj5gf's critic and bughunter spent eight read_file calls on
   * `src/App.tsx` and `D:\elia\workspace\src\App.tsx` before one found
   * `workspace/laptop-suggestor/src/App.tsx`.
   */
  absolute: string[]
  /** Display paths left out as generated or binary. */
  skipped: string[]
}

/**
 * The diff of one interactive turn, built from the before-images the turn's
 * file tracker already captured — no git required.
 *
 * The weak-area self-review used to tell the model to "run `git diff`". In a
 * freshly scaffolded project that is not a repository, so the model ran
 * `git init` and `git add .` with no .gitignore, staged node_modules and dist,
 * and `git diff --cached` returned 205 KB — twice — which overflowed the
 * context window and killed the session (mu0t6bvd-urf6i6, 2026-09-14). elia
 * knows exactly which files the turn touched and what they held before; it can
 * produce the diff itself, scoped to what the turn actually wrote.
 */
export function buildTurnDiff(snapshot: FileSnapshot, root = process.cwd()): TurnDiff {
  const parts: string[] = []
  const files: string[] = []
  const absolute: string[] = []
  const skipped: string[] = []
  for (const [path, before] of Object.entries(snapshot)) {
    const label = displayPath(path, root)
    if (GENERATED_PATH.test(label)) {
      skipped.push(label)
      continue
    }
    let after = ''
    try {
      after = existsSync(path) ? readFileSync(path, 'utf8') : ''
    } catch {
      skipped.push(label)
      continue
    }
    const previous = before ?? ''
    if (previous === after) continue
    if (after.includes('\0') || previous.includes('\0')) {
      skipped.push(label)
      continue
    }
    parts.push(createTwoFilesPatch(before === null ? '/dev/null' : `a/${label}`, after === '' && !existsSync(path) ? '/dev/null' : `b/${label}`, previous, after, '', '', { context: 3 }))
    files.push(label)
    absolute.push(resolve(root, path))
  }
  return { text: parts.join('\n'), files, absolute, skipped }
}

function displayPath(path: string, root: string): string {
  const rel = relative(root, path)
  const shown = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
  return shown.replaceAll('\\', '/')
}
