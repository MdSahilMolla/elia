import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import type { Tool } from '../tools/types.ts'
import { isIgnored } from '../tools/ignoreDirs.ts'
import type { ToolResultCache } from './cache.ts'

/**
 * Predicts which files the model is about to read, and reads them early.
 *
 * The prediction is deliberately heuristic rather than another model call: an
 * extra LLM round-trip to guess at reads would cost more latency than the reads
 * it saves. Instead elia exploits the fact that agents read in extremely
 * predictable chains — you grep, then you open the hits; you open a module, then
 * you open what it imports; a stack trace names the frames you're about to
 * inspect. Following those edges costs microseconds and no tokens.
 */

const CODE_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|css|scss|html|yml|yaml|toml|sh|sql'

/** A path-shaped token: optional leading ./ or ../, slash-separated segments, known code extension. */
const PATH_PATTERN = new RegExp(
  String.raw`(?:^|[\s'"\`(\[<])((?:\.{1,2}[/\\])?(?:[\w.@+-]+[/\\])*[\w.@+-]+\.(?:${CODE_EXTENSIONS}))`,
  'gm',
)

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)['"]([^'"\n]+)['"]/g

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']

/** Per-round and per-loop ceilings, so a huge grep result can't turn into thousands of reads. */
const MAX_PREDICTIONS_PER_ROUND = 10
const MAX_PREDICTIONS_PER_LOOP = 80
/** Reading a very large file speculatively costs more than it can save. */
const MAX_SPECULATIVE_FILE_BYTES = 256 * 1024

export interface ObservedCall {
  name: string
  input: Record<string, unknown>
  result: string
}

export interface Prefetcher {
  /**
   * Feeds a completed round of tool calls in. Any files they point at that the
   * model hasn't seen yet are read in the background, into the cache.
   */
  observe(calls: ObservedCall[]): void
  /** Marks paths as already in the model's context so they're never re-read speculatively. */
  markSeen(paths: string[]): void
}

export interface PrefetcherOptions {
  tools: Tool[]
  cache: ToolResultCache
  cwd?: string
}

export function createPrefetcher({ tools, cache, cwd = process.cwd() }: PrefetcherOptions): Prefetcher {
  const readFile = tools.find((tool) => tool.name === 'read_file')
  const seen = new Set<string>()
  let budget = MAX_PREDICTIONS_PER_LOOP

  function schedule(paths: string[]): void {
    if (!readFile) return
    for (const path of paths) {
      if (budget <= 0) return
      if (seen.has(path)) continue
      seen.add(path)
      budget -= 1
      cache.speculate('read_file', { path }, () => readFile.execute({ path }))
    }
  }

  return {
    markSeen(paths) {
      for (const path of paths) seen.add(path)
    },

    observe(calls) {
      const predictions: string[] = []

      for (const call of calls) {
        // A file the model just read is already in its context; what it reads
        // *next* is usually that file's own dependencies.
        if (call.name === 'read_file') {
          const path = typeof call.input.path === 'string' ? call.input.path : undefined
          if (path) {
            seen.add(normalizePath(path, cwd))
            predictions.push(...resolveImports(call.result, path, cwd))
          }
          continue
        }

        // grep/list_files output is a worklist: the model opens what it found.
        predictions.push(...extractPaths(call.result, cwd))
      }

      schedule(dedupe(predictions).slice(0, MAX_PREDICTIONS_PER_ROUND))
    },
  }
}

/** Pulls readable, existing, non-ignored file paths out of arbitrary tool output. */
export function extractPaths(text: string, cwd: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(PATH_PATTERN)) {
    const candidate = match[1]
    if (!candidate) continue
    const normalized = normalizePath(candidate, cwd)
    if (isSpeculativelyReadable(normalized, cwd)) found.push(normalized)
  }
  return dedupe(found)
}

/** Resolves the relative imports of a just-read file to concrete paths on disk. */
export function resolveImports(content: string, fromPath: string, cwd: string): string[] {
  const baseDir = dirname(normalizePath(fromPath, cwd))
  const found: string[] = []

  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1]
    // Bare specifiers are packages in node_modules — never worth speculating on.
    if (!specifier || !specifier.startsWith('.')) continue

    for (const extension of RESOLVE_EXTENSIONS) {
      const candidate = normalizePath(join(baseDir, specifier + extension), cwd)
      if (isSpeculativelyReadable(candidate, cwd)) {
        found.push(candidate)
        break
      }
    }
  }

  return dedupe(found)
}

function isSpeculativelyReadable(path: string, cwd: string): boolean {
  if (isIgnored(path)) return false
  const absolute = isAbsolute(path) ? path : join(cwd, path)
  try {
    const stat = statSync(absolute)
    return stat.isFile() && stat.size <= MAX_SPECULATIVE_FILE_BYTES
  } catch {
    return false
  }
}

/**
 * Normalizes to the shape the model itself uses in tool inputs — forward slashes,
 * relative to cwd — so a speculative `read_file` key matches the real call's key.
 */
function normalizePath(path: string, cwd: string): string {
  let normalized = normalize(path).replace(/\\/g, '/')
  const cwdPrefix = `${cwd.replace(/\\/g, '/')}/`
  if (normalized.startsWith(cwdPrefix)) normalized = normalized.slice(cwdPrefix.length)
  return normalized.replace(/^\.\//, '')
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)]
}

/** Exported for tests: whether a path exists at all, ignoring size/ignore rules. */
export function pathExists(path: string): boolean {
  return existsSync(path)
}
