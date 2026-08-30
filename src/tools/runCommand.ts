import type { Tool } from './types.ts'
import { DEFAULT_SHELL_TIMEOUT_MS, formatShellResult, runShell, type ShellResult } from '../shell.ts'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { currentAgent, resolveWorkspacePath } from '../autonomy/context.ts'
import { paths } from '../config.ts'
import { commandMayReadSensitiveData } from '../autonomy/sensitivePaths.ts'
import { detectMissingPackage, installCommandFor, isInstallCommand } from '../autonomy/autoInstall.ts'
import { activeActionGovernor } from '../autonomy/governor.ts'

const AUTO_INSTALL = process.env.ELIA_NO_AUTO_INSTALL !== '1'

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

/** Starts a server that never exits — the model must not block a turn on one. */
const DEV_SERVER_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)|vite(?:\s|$)|next\s+(?:dev|start)|nodemon|ts-node-dev|concurrently|http-server|flask\s+run|uvicorn|gunicorn|rails\s+s(?:erver)?)\b/i

/**
 * Resolves the `cwd` input to a real directory. A bare name like "my-app" is
 * tried first under the scratch workspace (where the model is told to build
 * standalone projects) and then under the repo root, so `run_command
 * cwd:"my-app"` lands in the project it just created rather than elia's own
 * root — the mismatch behind "npm run dev started elia again".
 */
export function resolveRunCwd(rawCwd: string, base = currentAgent().cwd ?? process.cwd()): string {
  if (!rawCwd) return base
  if (isAbsolute(rawCwd)) return resolveWorkspacePath(rawCwd)
  const underWorkspace = join(paths.workspace, rawCwd)
  if (existsSync(underWorkspace)) return resolveWorkspacePath(underWorkspace)
  return resolveWorkspacePath(rawCwd, base)
}

/** Exported so the default can be unit-tested without spawning a real install. */
export function defaultTimeoutForCommand(command: string): number {
  return LONG_RUNNING_COMMAND.test(command) ? LONG_RUNNING_TIMEOUT_MS : DEFAULT_SHELL_TIMEOUT_MS
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description: `Run a shell command and return its stdout, stderr, and exit code. Defaults to a 60 second timeout, or ${LONG_RUNNING_TIMEOUT_MS / 1000} seconds for a recognized install, build, or test command; pass timeoutMs to set it explicitly.

Pass \`cwd\` (relative to the workspace) to run inside a sub-project you created — e.g. cwd:"my-app" so \`npm install\` and \`npm run build\` use that project's package.json, not elia's own. Commands do NOT persist a directory between calls; always pass \`cwd\` rather than \`cd\`.

Do NOT run dev servers (\`npm run dev\`, \`vite\`, \`next dev\`, …) here — they never exit and will time out. Use the \`preview\` tool to serve and open a project instead. Inherits the active autonomous cancellation signal.`,
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Working directory, relative to the workspace (e.g. "my-app"). Defaults to the workspace root.' },
      timeoutMs: { type: 'number', description: `Timeout in milliseconds, from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}. Raise this for a slow install or a large test suite instead of letting it be killed partway through.` },
    },
    required: ['command'],
  },
  async execute(input) {
    if (typeof input.command !== 'string' || input.command.trim().length === 0) throw new Error('command must be a non-empty string')
    if (input.command.length > MAX_COMMAND_LENGTH) throw new Error(`command exceeds ${MAX_COMMAND_LENGTH} characters`)
    if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs < MIN_TIMEOUT_MS || input.timeoutMs > MAX_TIMEOUT_MS)) throw new Error(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
    if (commandMayReadSensitiveData(input.command)) throw new Error('shell command would read a protected sensitive path; that disclosure is denied')
    if (DEV_SERVER_COMMAND.test(input.command.trim())) {
      throw new Error(
        `"${input.command.trim().split(/\s+/).slice(0, 3).join(' ')}" starts a server that never exits — running it here just times out. Use the preview tool to serve and open the project (it stays live-reloaded), or start it yourself outside elia.`,
      )
    }
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : defaultTimeoutForCommand(input.command)
    const cwd = resolveRunCwd(typeof input.cwd === 'string' ? input.cwd.trim() : '')
    const signal = currentAgent().signal
    const result = await runShell(input.command, timeoutMs, cwd, signal)

    // A command that failed only because a dependency is missing: install it
    // (through the governor, so manual mode still asks) and re-run once. The
    // model shouldn't have to notice "module not found" and drive the fix.
    if (AUTO_INSTALL && result.exitCode !== 0 && !isInstallCommand(input.command)) {
      const missing = detectMissingPackage(`${result.stdout}\n${result.stderr}`)
      if (missing) {
        const installCmd = installCommandFor(missing, cwd ?? process.cwd())
        const gate = await activeActionGovernor().check({ name: 'run_command', input: { command: installCmd } })
        if (gate.allowed) {
          const installResult = await runShell(installCmd, LONG_RUNNING_TIMEOUT_MS, cwd, signal)
          if (installResult.exitCode === 0) {
            const retry = await runShell(input.command, timeoutMs, cwd, signal)
            return [
              `[auto-installed missing dependency: ${installCmd}]`,
              formatShellResult(retry),
            ].join('\n')
          }
          return [
            `[tried to auto-install ${missing.package} but "${installCmd}" failed]`,
            formatShellResult(installResult),
            '',
            `original command output:`,
            formatShellResult(result),
          ].join('\n')
        }
      }
    }

    return formatShellResult(result)
  },
}

/** Test seam. */
export type { ShellResult }
