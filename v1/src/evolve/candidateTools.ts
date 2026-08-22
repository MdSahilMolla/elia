import { isAbsolute, relative, resolve } from 'node:path'
import { DEFAULT_SHELL_TIMEOUT_MS, formatShellResult, runShell } from '../shell.ts'
import type { Tool } from '../tools/types.ts'

const PATH_FIELDS: Record<string, string> = {
  read_file: 'path',
  write_file: 'path',
  edit_file: 'path',
  grep: 'path',
  list_files: 'cwd',
}

/**
 * Gives an evolution builder real coding tools without giving it a route back
 * into the live installation. Shell access is limited to the two required gates.
 */
export function candidateTools(root: string, available: Tool[]): Tool[] {
  const resolvedRoot = resolve(root)
  const tools: Tool[] = []

  for (const tool of available) {
    if (tool.name === 'run_command') {
      tools.push({
        ...tool,
        description: 'Run "bun test" or "bun run typecheck" inside the candidate sandbox.',
        async execute(input) {
          const command = typeof input.command === 'string' ? input.command.trim() : ''
          if (command !== 'bun test' && command !== 'bun run typecheck') {
            throw new Error('Evolution sandboxes only allow: bun test; bun run typecheck')
          }
          return formatShellResult(await runShell(command, DEFAULT_SHELL_TIMEOUT_MS, resolvedRoot))
        },
      })
      continue
    }

    const field = PATH_FIELDS[tool.name]
    if (!field) continue
    tools.push({
      ...tool,
      async execute(input) {
        const raw = input[field]
        const path = typeof raw === 'string' && raw.length > 0 ? raw : '.'
        const target = resolve(resolvedRoot, path)
        const rel = relative(resolvedRoot, target)
        if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
          throw new Error(`Path escapes the evolution sandbox: ${path}`)
        }
        return tool.execute({ ...input, [field]: target })
      },
    })
  }

  return tools
}
