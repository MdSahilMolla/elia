import type { Tool } from './types.ts'
import { DEFAULT_SHELL_TIMEOUT_MS, formatShellResult, runShell } from '../shell.ts'
import { currentAgent } from '../autonomy/context.ts'
import { commandMayReadSensitiveData } from '../autonomy/sensitivePaths.ts'

const MAX_COMMAND_LENGTH = 100_000

export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Run a shell command and return its stdout, stderr, and exit code. Times out after 60 seconds and inherits the active autonomous cancellation signal.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
    required: ['command'],
  },
  async execute(input) {
    if (typeof input.command !== 'string' || input.command.trim().length === 0) throw new Error('command must be a non-empty string')
    if (input.command.length > MAX_COMMAND_LENGTH) throw new Error(`command exceeds ${MAX_COMMAND_LENGTH} characters`)
    if (commandMayReadSensitiveData(input.command)) throw new Error('shell command would read a protected sensitive path; that disclosure is denied')
    return formatShellResult(await runShell(input.command, DEFAULT_SHELL_TIMEOUT_MS, currentAgent().cwd, currentAgent().signal))
  },
}
