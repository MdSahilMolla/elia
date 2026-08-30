import type { Tool } from './types.ts'
import { isIgnored, SKIP_DIRS } from './ignoreDirs.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess, isSensitivePath } from '../autonomy/sensitivePaths.ts'
import { readBoundedOutput, terminateProcessGroup } from '../shell.ts'

const MAX_PATTERN_LENGTH = 10_000
const MAX_GLOB_LENGTH = 500
const MAX_SEARCH_FILE_BYTES = 5_000_000
const MAX_MATCHES = 200
const MAX_CONTEXT_LINES = 20
const GREP_OUTPUT_BYTES = 400_000
const GREP_TIMEOUT_MS = 20_000

// ripgrep prints `path:line:content` for a match and `path-line-content` for a
// context line, with `--` between groups.
const RG_LINE = /^(.+?)([:-])(\d+)[:-]/

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents for a regular expression pattern under a directory. Backed by ripgrep when it is installed, with an equivalent built-in scan as fallback. Use `glob` to restrict which files are searched and `context` to see surrounding lines instead of re-reading the whole file.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Directory to search under (default: current directory)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts" or "**/*.{js,tsx}"' },
      context: { type: 'number', description: `Lines of context to include before and after each match (0-${MAX_CONTEXT_LINES})` },
    },
    required: ['pattern'],
  },
  async execute(input) {
    if (typeof input.pattern !== 'string' || input.pattern.length === 0) throw new Error('pattern must be a non-empty string')
    if (input.pattern.length > MAX_PATTERN_LENGTH) throw new Error(`pattern exceeds ${MAX_PATTERN_LENGTH} characters`)
    if (input.path !== undefined && (typeof input.path !== 'string' || input.path.trim().length === 0)) throw new Error('path must be a non-empty string when provided')
    if (input.glob !== undefined && (typeof input.glob !== 'string' || input.glob.length === 0 || input.glob.length > MAX_GLOB_LENGTH)) throw new Error(`glob must be a non-empty string up to ${MAX_GLOB_LENGTH} characters when provided`)
    if (input.context !== undefined && (typeof input.context !== 'number' || !Number.isInteger(input.context) || input.context < 0 || input.context > MAX_CONTEXT_LINES)) throw new Error(`context must be an integer from 0 to ${MAX_CONTEXT_LINES} when provided`)

    const pattern = input.pattern
    const glob = input.glob as string | undefined
    const context = input.context as number | undefined
    // Displayed paths stay relative to what the model asked for; only the
    // actual filesystem scan resolves against the ambient worktree root, so a
    // variant's grep results don't leak its internal worktree path.
    const inputDir = (input.path as string | undefined) ?? '.'
    const dir = resolveWorkspacePath(inputDir)
    assertSafeFileAccess(dir)

    const rg = Bun.which('rg')
    if (rg) return await searchWithRipgrep(rg, pattern, dir, inputDir, glob, context)
    return await searchWithJs(pattern, dir, inputDir, glob, context)
  },
}

async function searchWithRipgrep(rg: string, pattern: string, dir: string, inputDir: string, glob: string | undefined, context: number | undefined): Promise<string> {
  const args = ['--line-number', '--no-heading', '--color=never', `--max-filesize=${MAX_SEARCH_FILE_BYTES}`]
  for (const skip of SKIP_DIRS) args.push('--glob', `!${skip}/**`)
  if (glob) args.push('--glob', glob)
  if (context) args.push('--context', String(context))
  args.push('-e', pattern, '.')

  // PCRE2 first so lookarounds and backreferences work like the JS fallback;
  // a build without PCRE2 support falls back to the default engine.
  let run = await runRipgrep(rg, ['-P', ...args], dir)
  if (run.exitCode === 2 && /pcre2/i.test(run.stderr)) run = await runRipgrep(rg, args, dir)

  if (run.exitCode === 1) return 'No matches found.'
  // Exit code 2 means "something went wrong" — but that includes per-file
  // "Access is denied" on a Windows system directory, where the search still
  // ran fine everywhere it could reach. Only treat it as a bad pattern when the
  // error text actually says so; otherwise keep the results and note the rest.
  const patternError = /regex parse error|error parsing|unclosed group|unrecognized escape|repetition operator|pcre2/i.test(run.stderr)
  if (run.exitCode === 2 && patternError) {
    throw new Error(`invalid regular expression: ${run.stderr.trim() || 'ripgrep rejected the pattern'}`)
  }
  const accessNote = run.exitCode === 2 && !run.stdout.trim()
    ? `\n\n[ripgrep reported errors and no matches: ${run.stderr.split('\n').slice(0, 2).join(' ').slice(0, 200)}]`
    : ''

  const lines: string[] = []
  let matchCount = 0
  let truncated = false
  for (const raw of run.stdout.split(/\r?\n/)) {
    if (raw.length === 0 || raw === '--') continue
    const parsed = RG_LINE.exec(raw)
    if (!parsed) continue
    const [, rawPath, separator, lineNumber] = parsed
    const relPath = rawPath!.replaceAll('\\', '/').replace(/^\.\//, '')
    // ripgrep respects .gitignore but knows nothing about elia's own protected
    // paths, so secrets are filtered here before any of it reaches the model.
    if (isIgnored(relPath) || isSensitivePath(relPath)) continue
    if (matchCount >= MAX_MATCHES) {
      truncated = true
      break
    }
    if (separator === ':') matchCount += 1
    const content = raw.slice(rawPath!.length + 1 + lineNumber!.length + 1)
    lines.push(`${inputDir}/${relPath}${separator}${lineNumber}${separator}${content}`)
  }

  if (lines.length === 0) return `No matches found.${accessNote}`
  return `${lines.join('\n')}${truncated ? `\n\n[stopped after ${MAX_MATCHES} matches]` : ''}${accessNote}`
}

async function runRipgrep(rg: string, args: string[], dir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([rg, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    terminateProcessGroup(proc)
  }, GREP_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedOutput(proc.stdout, GREP_OUTPUT_BYTES),
      readBoundedOutput(proc.stderr, GREP_OUTPUT_BYTES),
      proc.exited,
    ])
    return { stdout, stderr, exitCode: timedOut ? 2 : exitCode }
  } finally {
    clearTimeout(timeout)
  }
}

/** Used when ripgrep is not installed. Slower, but the same contract. */
async function searchWithJs(pattern: string, dir: string, inputDir: string, globPattern: string | undefined, context: number | undefined): Promise<string> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const scan = new Bun.Glob('**/*')
  const fileFilter = globPattern ? new Bun.Glob(globPattern) : undefined
  const matches: string[] = []
  let skippedLargeFiles = 0

  for await (const relPath of scan.scan({ cwd: dir, dot: false })) {
    if (isIgnored(relPath) || isSensitivePath(relPath)) continue
    if (fileFilter && !fileFilter.match(relPath) && !fileFilter.match(relPath.split(/[\\/]/).at(-1) ?? relPath)) continue

    const fullPath = `${inputDir}/${relPath}`
    const file = Bun.file(`${dir}/${relPath}`)
    if (!(await file.exists())) continue
    if (file.size > MAX_SEARCH_FILE_BYTES) {
      skippedLargeFiles += 1
      continue
    }

    let text: string
    try {
      text = await file.text()
    } catch {
      continue // binary or unreadable file
    }

    const lines = text.split('\n')
    const span = context && context > 0 ? context : 0
    let lastEmitted = -1
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue
      if (span > 0) {
        // ripgrep-style: `path-line-content` for context, `path:line:content`
        // for the match, `--` between non-adjacent groups.
        const from = Math.max(0, i - span)
        const to = Math.min(lines.length - 1, i + span)
        if (lastEmitted >= 0 && from > lastEmitted + 1) matches.push('--')
        for (let j = Math.max(from, lastEmitted + 1); j <= to; j++) {
          const sep = j === i ? ':' : '-'
          matches.push(`${fullPath}${sep}${j + 1}${sep}${lines[j]}`)
        }
        lastEmitted = to
      } else {
        matches.push(`${fullPath}:${i + 1}:${lines[i]}`)
      }
      if (matches.length >= MAX_MATCHES) break
    }
    if (matches.length >= MAX_MATCHES) break
  }

  const suffix = skippedLargeFiles > 0 ? `\n\n[skipped ${skippedLargeFiles} file(s) over ${MAX_SEARCH_FILE_BYTES} bytes]` : ''
  if (matches.length === 0) return `No matches found.${suffix}`
  return `${matches.join('\n')}${suffix}`
}
