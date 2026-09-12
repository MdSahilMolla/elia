import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { isIgnored } from './ignoreDirs.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess, isSensitivePath } from '../autonomy/sensitivePaths.ts'
import { symbolIndexSupportedExtensions, symbolLanguageFor, symbolsInFile } from '../goindex/symbolIndex.ts'

/**
 * Structural symbol lookup: function/class/method/struct/interface
 * *definitions*, found by parsing each candidate file with its real grammar
 * (via goindex/symbolIndex.ts) rather than grep's regex-over-text search.
 * "Where is X defined" and "what does this file declare" are exactly the
 * queries grep answers poorly (a match on `function foo` also matches a
 * comment mentioning it, a call site, a string) and this answers directly.
 */

const MAX_NAME_LENGTH = 200
const MAX_GLOB_LENGTH = 500
const MAX_FILES_SCANNED = 2_000
const MAX_FILE_BYTES = 2_000_000
const MAX_RESULTS = 200
const DEADLINE_MS = 15_000

function defaultGlob(): string {
  return `**/*{${symbolIndexSupportedExtensions().join(',')}}`
}

export const findSymbolTool: Tool = {
  name: 'find_symbol',
  description:
    'Find function/class/method/struct/interface definitions by parsing source files with their real language grammar, not by text matching. Use this instead of grep when the question is "where is X defined" or "what does this file/directory declare" — grep also matches call sites, comments, and strings; this only matches actual definitions. Supported languages: TypeScript/JS(X), Python, Go, Rust, Java, C/C++.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Only symbols whose name contains this (case-insensitive). Omit to list every definition found.' },
      path: { type: 'string', description: 'Directory to search under (default: current directory)' },
      glob: { type: 'string', description: 'Restrict which files are scanned, e.g. "src/**/*.ts" (default: every supported source extension)' },
    },
    required: [],
  },
  async execute(input) {
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > MAX_NAME_LENGTH)) {
      throw new Error(`name must be a non-empty string up to ${MAX_NAME_LENGTH} characters when provided`)
    }
    if (input.glob !== undefined && (typeof input.glob !== 'string' || input.glob.length === 0 || input.glob.length > MAX_GLOB_LENGTH)) {
      throw new Error(`glob must be a non-empty string up to ${MAX_GLOB_LENGTH} characters when provided`)
    }
    const nameFilter = (input.name as string | undefined)?.toLowerCase()
    const globPattern = (input.glob as string | undefined) ?? defaultGlob()
    const pathArgument = optionalString(input.path, 'path')
    const inputDir = pathArgument ?? '.'
    const dir = resolveWorkspacePath(inputDir)
    assertSafeFileAccess(dir)

    const deadline = Date.now() + DEADLINE_MS
    const glob = new Bun.Glob(globPattern)
    const results: string[] = []
    let filesScanned = 0
    let filesSkippedNoGrammar = 0

    for await (const relativePath of glob.scan({ cwd: dir, dot: false })) {
      if (Date.now() > deadline || results.length >= MAX_RESULTS || filesScanned >= MAX_FILES_SCANNED) break
      if (isIgnored(relativePath) || isSensitivePath(relativePath)) continue
      if (!symbolLanguageFor(relativePath)) {
        filesSkippedNoGrammar += 1
        continue
      }
      filesScanned += 1

      const file = Bun.file(`${dir}/${relativePath}`)
      if (file.size > MAX_FILE_BYTES) continue
      let content: string
      try {
        content = await file.text()
      } catch {
        continue
      }

      let symbols
      try {
        symbols = await symbolsInFile(relativePath, content)
      } catch {
        // A file that fails to parse (syntax error, encoding issue) is skipped, not fatal to the whole search.
        continue
      }
      if (!symbols) continue

      for (const symbol of symbols) {
        if (nameFilter && !symbol.name.toLowerCase().includes(nameFilter)) continue
        results.push(`${inputDir === '.' ? relativePath : `${inputDir}/${relativePath}`}:${symbol.line}:${symbol.column} ${symbol.kind} ${symbol.name}`)
        if (results.length >= MAX_RESULTS) break
      }
    }

    if (results.length === 0) {
      return filesScanned === 0
        ? `No source files with a supported grammar were found under ${inputDir}${filesSkippedNoGrammar > 0 ? ` (${filesSkippedNoGrammar} file(s) had no configured grammar for their extension)` : ''}.`
        : `No matching symbol definitions found among ${filesScanned} file(s) scanned under ${inputDir}.`
    }
    const truncated = results.length >= MAX_RESULTS ? `\n… stopped at ${MAX_RESULTS} results; narrow with "name" or "glob" for more.` : ''
    return `${results.join('\n')}${truncated}`
  },
}
