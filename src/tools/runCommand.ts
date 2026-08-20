import type { Tool } from './types.ts'
import { DEFAULT_SHELL_TIMEOUT_MS, formatShellResult, runShell } from '../shell.ts'
import { currentAgent } from '../autonomy/context.ts'

export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Run a shell command and return its stdout, stderr, and exit code. Times out after 60 seconds.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
    required: ['command'],
  },
  async execute(input) {
    const command = input.command as string
    return formatShellResult(await runShell(command, DEFAULT_SHELL_TIMEOUT_MS, currentAgent().cwd))
  },
}
