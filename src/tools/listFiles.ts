import type { Tool } from './types.ts'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { optionalString } from './args.ts'
import { isIgnored } from './ignoreDirs.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess, isSensitivePath } from '../autonomy/sensitivePaths.ts'

const MAX_GLOB_LENGTH = 2_000

/** Rejects patterns whose scan root lies outside the workspace being searched. */
function patternEscapesWorkspace(pattern: string): boolean {
  if (/^[A-Za-z]:/.test(pattern) || /^[\\/]/.test(pattern) || /^~\//.test(pattern)) return true
  return pattern.split(/[\\/]/).some((segment) => segment === '..')
}

export const listFilesTool: Tool = {
  name: 'list_files',
  description: 'List files matching a glob pattern (e.g. "**/*.ts", "src/**"). Skips node_modules, .git, dist, and build.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match' },
      cwd: { type: 'string', description: 'Directory to search from (default: current directory)' },
    },
    required: ['pattern'],
  },
  async execute(input) {
    if (typeof input.pattern !== 'string' || input.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
    if (input.pattern.length > MAX_GLOB_LENGTH) throw new Error(`pattern exceeds ${MAX_GLOB_LENGTH} characters`)
    if (patternEscapesWorkspace(input.pattern)) throw new Error('pattern must stay within the active workspace')
    const cwdArgument = optionalString(input.cwd, 'cwd')
    const pattern = input.pattern
    const cwd = resolveWorkspacePath(cwdArgument ?? '.')
    assertSafeFileAccess(cwd)
    if (!existsSync(cwd)) throw new Error(`no such directory: ${cwdArgument ?? '.'}`)
    const glob = new Bun.Glob(pattern)
    const root = resolve(cwd)
    const results: string[] = []
    for await (const path of glob.scan({ cwd, dot: false })) {
      // A pattern riding on parent traversal (`../outside/**`) returns paths
      // that resolve outside the workspace the tool is allowed to search.
      const joined = resolve(cwd, path)
      const contained = joined === root || joined.toLowerCase().startsWith(root.toLowerCase() + sep)
      if (!contained || isIgnored(path) || isSensitivePath(path)) continue
      results.push(path)
      if (results.length >= 500) break
    }
    if (results.length === 0) return 'No files matched.'
    return results.join('\n')
  },
}
