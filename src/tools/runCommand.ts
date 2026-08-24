import type { Tool } from './types.ts'
import { DEFAULT_SHELL_TIMEOUT_MS, formatShellResult, runShell } from '../shell.ts'
import { currentAgent } from '../autonomy/context.ts'
import { commandMayReadSensitiveData } from '../autonomy/sensitivePaths.ts'

const MAX_COMMAND_LENGTH = 100_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 600_000
const LONG_RUNNING_TIMEOUT_MS = 300_000

/**
 * Package installs, builds, and full test suites routinely run past the 60s
 * default on a cold cache. Killing one midway is worse than waiting: it leaves
 * a half-installed dependency tree, so the build then fails, the tests cannot
 * run, and the agent has no way to verify its own work — a single timeout
 * quietly poisons everything downstream. These get a longer budget by default
 * so the model does not have to remember to ask for one.
 */
const LONG_RUNNING_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|update|upgrade|run\s+(?:build|test)|build|test)\b|\bpip3?\s+install\b|\bpoetry\s+(?:install|update)\b|\bcargo\s+(?:build|install|test)\b|\bgo\s+(?:build|install|mod\s+(?:download|tidy))\b|\bcomposer\s+install\b|\bbundle\s+install\b|\bdocker\s+build\b|\bmake\b/i

/** Exported so the default can be unit-tested without spawning a real install. */
export function defaultTimeoutForCommand(command: string): number {
  return LONG_RUNNING_COMMAND.test(command) ? LONG_RUNNING_TIMEOUT_MS : DEFAULT_SHELL_TIMEOUT_MS
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description: `Run a shell command and return its stdout, stderr, and exit code. Defaults to a 60 second timeout, or ${LONG_RUNNING_TIMEOUT_MS / 1000} seconds for a recognized install, build, or test command; pass timeoutMs to set it explicitly. Inherits the active autonomous cancellation signal.`,
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeoutMs: { type: 'number', description: `Timeout in milliseconds, from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}. Raise this for a slow install or a large test suite instead of letting it be killed partway through.` },
    },
    required: ['command'],
  },
  async execute(input) {
    if (typeof input.command !== 'string' || input.command.trim().length === 0) throw new Error('command must be a non-empty string')
    if (input.command.length > MAX_COMMAND_LENGTH) throw new Error(`command exceeds ${MAX_COMMAND_LENGTH} characters`)
    if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs < MIN_TIMEOUT_MS || input.timeoutMs > MAX_TIMEOUT_MS)) throw new Error(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
    if (commandMayReadSensitiveData(input.command)) throw new Error('shell command would read a protected sensitive path; that disclosure is denied')
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : defaultTimeoutForCommand(input.command)
    return formatShellResult(await runShell(input.command, timeoutMs, currentAgent().cwd, currentAgent().signal))
  },
}
