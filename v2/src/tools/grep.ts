import type { Tool } from './types.ts'
import { isIgnored } from './ignoreDirs.ts'
import { resolvePath } from '../autonomy/context.ts'

const MAX_PATTERN_LENGTH = 10_000
const MAX_SEARCH_FILE_BYTES = 5_000_000

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search file contents for a regular expression pattern under a directory.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Directory to search under (default: current directory)' },
    },
    required: ['pattern'],
  },
  async execute(input) {
    if (typeof input.pattern !== 'string' || input.pattern.length === 0) throw new Error('pattern must be a non-empty string')
    if (input.pattern.length > MAX_PATTERN_LENGTH) throw new Error(`pattern exceeds ${MAX_PATTERN_LENGTH} characters`)
    if (input.path !== undefined && (typeof input.path !== 'string' || input.path.trim().length === 0)) throw new Error('path must be a non-empty string when provided')
    const pattern = input.pattern
    // Displayed paths stay relative to what the model asked for; only the
    // actual filesystem scan resolves against the ambient worktree root, so a
    // variant's grep results don't leak its internal worktree path.
    const inputDir = (input.path as string | undefined) ?? '.'
    const dir = resolvePath(inputDir)

    const glob = new Bun.Glob('**/*')
    const matches: string[] = []
    let skippedLargeFiles = 0

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error) {
      throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
    }

    for await (const relPath of glob.scan({ cwd: dir, dot: false })) {
      if (isIgnored(relPath)) continue

      const fullPath = `${inputDir}/${relPath}`
      const file = Bun.file(`${dir}/${relPath}`)
      const stat = await file.exists()
      if (!stat) continue
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
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          matches.push(`${fullPath}:${i + 1}:${lines[i]}`)
          if (matches.length >= 200) break
        }
      }
      if (matches.length >= 200) break
    }

    const suffix = skippedLargeFiles > 0 ? `\n\n[skipped ${skippedLargeFiles} file(s) over ${MAX_SEARCH_FILE_BYTES} bytes]` : ''
    if (matches.length === 0) return `No matches found.${suffix}`
    return `${matches.join('\n')}${suffix}`
  },
}
