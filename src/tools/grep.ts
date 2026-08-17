import type { Tool } from './types.ts'
import { isIgnored } from './ignoreDirs.ts'

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
    const pattern = input.pattern as string
    const dir = (input.path as string | undefined) ?? '.'
    const regex = new RegExp(pattern)

    const glob = new Bun.Glob('**/*')
    const matches: string[] = []

    for await (const relPath of glob.scan({ cwd: dir, dot: false })) {
      if (isIgnored(relPath)) continue

      const fullPath = `${dir}/${relPath}`
      const file = Bun.file(fullPath)
      const stat = await file.exists()
      if (!stat) continue

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

    if (matches.length === 0) return 'No matches found.'
    return matches.join('\n')
  },
}
