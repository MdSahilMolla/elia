import type { Tool } from './types.ts'
import { DEFAULT_SHELL_TIMEOUT_MS, formatShellResult, runShell, type ShellResult } from '../shell.ts'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative } from 'node:path'
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
const LONG_RUNNING_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|update|upgrade|run\s+(?:build|test)|build|test)\b|\bpip3?\s+install\b|\bpoetry\s+(?:install|update)\b|\bcargo\s+(?:build|install|test)\b|\bgo\s+(?:build|install|mod\s+(?:download|tidy))\b|\bcomposer\s+install\b|\bbundle\s+install\b|\bdocker\s+build\b|\bmake\b|\bmvn\b|\bgradle(?:w)?(?:\.bat)?\b|\bcmake\b/i

/** Commands that resolve a package binary and therefore need the project's own
 * `node_modules` present — `npx prisma …`, `npm run build`, a bare local bin. */
const NEEDS_NODE_MODULES = /^\s*(?:npx|pnpm\s+dlx|yarn\s+dlx|bunx)\s+\S|\b(?:npm|pnpm|yarn|bun)\s+(?:run|exec)\b/i

/** `node_modules` exists and holds more than a stray `.package-lock.json`. */
function nodeModulesPopulated(cwd: string): boolean {
  try {
    return readdirSync(join(cwd, 'node_modules')).some((e) => !e.startsWith('.'))
  } catch {
    return false
  }
}

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

/**
 * A command running inside a scaffolded sub-project must resolve `node`, `npx`,
 * and package binaries against *its own* `node_modules`, not elia's. Node walks
 * the directory tree upward, so from `workspace/my-app` it otherwise finds
 * `D:\elia\node_modules\.bin\prisma` — which is `@prisma/composer`'s CLI, not
 * Prisma ORM — and `npx prisma generate` fails with `CLI.UNKNOWN_COMMAND`.
 *
 * When `cwd` is a sub-directory of the workspace, return an environment that
 * puts the sub-project's `.bin` first on `PATH` and drops any `NODE_PATH`
 * inherited from elia. Returns `undefined` for the workspace root itself and for
 * anything outside it (no scoping needed / wanted). This is a backstop — the
 * durable fix is installing the sub-project's own deps before its bins run.
 */
export function workspaceScopedEnv(cwd: string): Record<string, string> | undefined {
  const rel = relative(paths.workspace, cwd)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  delete base.NODE_PATH
  const binDir = join(cwd, 'node_modules', '.bin')
  // Windows env vars are case-insensitive but the object here is not — normalise
  // onto PATH so the prepend can't be shadowed by a stale `Path`.
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === 'PATH')
  const currentPath = pathKey ? base[pathKey]! : ''
  if (pathKey && pathKey !== 'PATH') delete base[pathKey]
  base.PATH = currentPath ? `${binDir}${delimiter}${currentPath}` : binDir
  return base
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description: `Run a shell command and return its stdout, stderr, and exit code. Defaults to a 60 second timeout, or ${LONG_RUNNING_TIMEOUT_MS / 1000} seconds for a recognized install, build, or test command; pass timeoutMs to set it explicitly.

Pass \`cwd\` (relative to the workspace) to run inside a sub-project you created — e.g. cwd:"my-app" so \`npm install\` and \`npm run build\` use that project's package.json, not elia's own. Commands do NOT persist a directory between calls; always pass \`cwd\` rather than \`cd\`.

Do NOT run dev servers (\`npm run dev\`, \`vite\`, \`next dev\`, …) here — they never exit and will time out. Use the \`preview\` tool to serve and open a project instead. Inherits the active autonomous cancellation signal.

Shell: on Windows the command runs through \`cmd.exe\`; on macOS/Linux through \`sh\`. Write for that shell, not bash:
- Probe for a tool with \`where <tool>\` on Windows / \`command -v <tool>\` on POSIX — not \`which\` (absent on Windows) and not \`bash -c …\` (bash is often just a WSL stub).
- To run PowerShell, put the WHOLE pipeline inside one quoted argument: \`powershell -NoProfile -Command "Get-ChildItem x | Measure-Object"\`. Do not append \`| Out-String\`, \`2>&1\`, or other PowerShell/POSIX operators outside the quotes — cmd.exe can't parse them.
- For anything with nested quotes, escapes, or a multi-statement script (Python \`-c\`, Node \`-e\`), write a real \`.py\`/\`.js\`/\`.ps1\` file with write_file and run that file. One-liners with \`'\\n'.join(...)\`-style escaping do not survive the shell layer.`,
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
    const env = workspaceScopedEnv(cwd)

    // A scaffolded sub-project's bins can't run before its deps are installed —
    // and if elia runs `npx prisma` from `workspace/app` with an empty
    // `node_modules`, Node walks up and finds elia's own (`@prisma/composer`'s
    // `prisma` shim → `CLI.UNKNOWN_COMMAND`). Install first, once, through the
    // governor, when the command clearly needs the local tree.
    if (
      AUTO_INSTALL &&
      env && // only inside the workspace
      NEEDS_NODE_MODULES.test(input.command) &&
      existsSync(join(cwd, 'package.json')) &&
      !nodeModulesPopulated(cwd) &&
      !isInstallCommand(input.command)
    ) {
      const installCmd = existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))
        ? 'bun install'
        : existsSync(join(cwd, 'pnpm-lock.yaml'))
          ? 'pnpm install'
          : existsSync(join(cwd, 'yarn.lock'))
            ? 'yarn install'
            : 'npm install'
      const gate = await activeActionGovernor().check({ name: 'run_command', input: { command: installCmd } })
      if (gate.allowed) {
        const pre = await runShell(installCmd, LONG_RUNNING_TIMEOUT_MS, cwd, signal, env)
        if (pre.exitCode === 0) {
          const done = await runShell(input.command, timeoutMs, cwd, signal, env)
          return [`[installed sub-project dependencies first: ${installCmd}]`, formatShellResult(done)].join('\n')
        }
      }
    }

    const result = await runShell(input.command, timeoutMs, cwd, signal, env)

    // A command that failed only because a dependency is missing: install it
    // (through the governor, so manual mode still asks) and re-run once. The
    // model shouldn't have to notice "module not found" and drive the fix.
    if (AUTO_INSTALL && result.exitCode !== 0 && !isInstallCommand(input.command)) {
      const missing = detectMissingPackage(`${result.stdout}\n${result.stderr}`)
      if (missing) {
        const installCmd = installCommandFor(missing, cwd ?? process.cwd())
        const gate = await activeActionGovernor().check({ name: 'run_command', input: { command: installCmd } })
        if (gate.allowed) {
          const installResult = await runShell(installCmd, LONG_RUNNING_TIMEOUT_MS, cwd, signal, env)
          if (installResult.exitCode === 0) {
            const retry = await runShell(input.command, timeoutMs, cwd, signal, env)
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
