import type { Tool } from './types.ts'
import { isIgnored } from './ignoreDirs.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess, isSensitivePath } from '../autonomy/sensitivePaths.ts'

const MAX_GLOB_LENGTH = 2_000

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
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.trim().length === 0)) throw new Error('cwd must be a non-empty string when provided')
    const pattern = input.pattern
    const cwd = resolveWorkspacePath((input.cwd as string | undefined) ?? '.')
    assertSafeFileAccess(cwd)
    const glob = new Bun.Glob(pattern)
    const results: string[] = []
    for await (const path of glob.scan({ cwd, dot: false })) {
      if (isIgnored(path) || isSensitivePath(path)) continue
      results.push(path)
      if (results.length >= 500) break
    }
    if (results.length === 0) return 'No files matched.'
    return results.join('\n')
  },
}
