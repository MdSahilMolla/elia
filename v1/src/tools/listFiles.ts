import type { Tool } from './types.ts'
import { isIgnored } from './ignoreDirs.ts'
import { resolvePath } from '../autonomy/context.ts'

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
    const pattern = input.pattern as string
    const cwd = resolvePath((input.cwd as string | undefined) ?? '.')
    const glob = new Bun.Glob(pattern)
    const results: string[] = []
    for await (const path of glob.scan({ cwd, dot: false })) {
      if (isIgnored(path)) continue
      results.push(path)
      if (results.length >= 500) break
    }
    if (results.length === 0) return 'No files matched.'
    return results.join('\n')
  },
}
