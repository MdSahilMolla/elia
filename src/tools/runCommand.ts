import type { Tool } from './types.ts'
import { DEFAULT_SHELL_TIMEOUT_MS, formatShellResult, isLongRunningServerCommand, runShell, shellCommandAlternative, type ShellResult } from '../shell.ts'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { currentAgent, resolveProjectPath } from '../autonomy/context.ts'
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

/**
 * A few shell mismatches, caught *before* spawning so a bad one-liner becomes an
 * immediate corrective instead of a runtime failure and a wasted repair turn.
 * These are the exact shapes seen in the wild on Windows, where the shell is
 * `cmd.exe` but the model reaches for POSIX/PowerShell idioms.
 */
/** POSIX text filters people pipe into; cmd.exe has none of them unless something put them on PATH. */
const POSIX_FILTERS = new Set(['head', 'tail', 'grep', 'wc', 'sed', 'awk', 'cut', 'sort', 'uniq', 'tr', 'xargs', 'tee', 'jq'])

function shellMismatch(raw: string): string | null {
  const command = raw.trim()
  const win = process.platform === 'win32'

  if (/^(?:cd|chdir|pushd|popd)\b/i.test(command)) {
    return 'Do not use cd, chdir, pushd, or popd in run_command. Pass cwd as a separate field and use run_program for the executable and its literal arguments.'
  }

  if (win && /^bash\s+-c\b/i.test(command)) {
    return 'This shell is cmd.exe, and `bash` on Windows is usually just the WSL launcher stub (fails with "no installed distributions"). Run the command directly for cmd.exe, or write a .ps1/.py file with write_file and run that.'
  }
  // The whole POSIX/PowerShell vocabulary, not just `which`. A worker that
  // reaches for `ls`, `pwd`, `cat`, `rm` or `Get-ChildItem` on Windows used to
  // get "<name> is not available in PATH" from the action contract, which reads
  // as a broken machine rather than a wrong command name — and sent at least
  // one run down the fix-the-environment path over a typo in shell dialect.
  if (win) {
    const first = /^([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/.exec(command)?.[1]
    const alternative = first ? shellCommandAlternative(first) : undefined
    if (alternative) return alternative
  }

  // Strip quoted spans so a pipe *inside* `powershell -Command "..."` doesn't
  // count, then look for a PowerShell Verb-Noun cmdlet piped by the parent shell
  // (`powershell -c "..." | Out-String`) — cmd.exe treats it as a missing exe.
  const bare = command.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
  if (/\|\s*[A-Z][a-z]{2,}-[A-Z][a-z]{2,}/.test(bare)) {
    return 'A PowerShell cmdlet (Verb-Noun) is being piped at the shell level, where it is not an executable — this is what makes cmd.exe say "\'Out-String\' is not recognized". Put the whole pipeline inside one quoted argument: powershell -NoProfile -Command "… | Out-String".'
  }

  if (win) {
    // cmd.exe splits a command at `&`, so an unquoted query string runs its
    // second half as a command of its own — run 2026-09-17-1dnk-gzpt got
    // "'longitude' is not recognized" from a curl it believed had worked.
    if (/https?:\/\/[^\s"']*&/i.test(bare)) {
      return 'This URL has a `&` outside quotes, and cmd.exe treats `&` as "run the next command" — the request would be cut short. Put the whole URL in double quotes: curl -s "https://…?a=1&b=2".'
    }
    // Piping into a POSIX filter that cmd.exe cannot find fails only after the
    // left-hand side has run (and, for a network call, after its approval).
    for (const match of bare.matchAll(/\|\s*([A-Za-z][\w-]*)/g)) {
      const filter = match[1]!
      if (POSIX_FILTERS.has(filter.toLowerCase()) && !Bun.which(filter)) {
        return `\`${filter}\` is not available in this cmd.exe shell, so \`| ${filter}\` would fail after the first half ran. Drop the pipe and read the output as it comes back (run_command already returns it, truncated if large), or use findstr instead of grep.`
      }
    }
  }

  // An inline -c/-e one-liner whose payload carries backslash escapes: cmd.exe
  // quoting mangles `\n` / `\"` and Python gets a truncated argument.
  if (win) {
    const inline = /(?:^|\s)(?:python3?|node|deno)\s+-(?:c|e)\s+(["']).*?\1/s.exec(command)
    if (inline && /\\[nrtu"'\\]/.test(inline[0])) {
      return 'An inline -c/-e one-liner with backslash escapes will not survive cmd.exe quoting (you get a SyntaxError from a truncated argument). Write a real .py/.js file with write_file and run that.'
    }
  }

  return null
}

/**
 * The directories a bare `mkdir`/`md` would create, when every one of them is
 * already there — otherwise undefined.
 *
 * cmd.exe's `mkdir` (and POSIX `mkdir` without -p) exits 1 on an existing
 * directory, and that exit code was recorded as a failed action. write_file
 * creates parent directories itself, so the usual sequence is files first,
 * `mkdir` after: session mu0ty0ty-ywj5gf logged two such "failures", each one
 * counted against the turn's clean rate that decides where elia distrusts itself.
 * Nothing needs doing, so nothing is run.
 */
export function alreadyExistingMkdir(command: string, cwd: string): string[] | undefined {
  const match = /^\s*(?:mkdir|md)((?:\s+(?:"[^"]+"|[^\s"&|<>;^%$`]+))+)\s*$/i.exec(command)
  if (!match) return undefined
  const args = [...match[1]!.matchAll(/"([^"]+)"|(\S+)/g)].map((arg) => arg[1] ?? arg[2]!)
  const dirs = args.filter((arg) => arg !== '-p' && arg !== '--parents')
  if (dirs.length === 0 || dirs.some((dir) => dir.startsWith('-'))) return undefined
  const resolved = dirs.map((dir) => resolve(cwd, dir))
  return resolved.every((dir) => isDirectory(dir)) ? resolved : undefined
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `node_modules` exists and holds more than a stray `.package-lock.json`. */
function nodeModulesPopulated(cwd: string): boolean {
  try {
    return readdirSync(join(cwd, 'node_modules')).some((e) => !e.startsWith('.'))
  } catch {
    return false
  }
}

/**
 * Resolves the `cwd` input to a real directory. A bare name like "my-app" is
 * tried first under the scratch workspace (where the model is told to build
 * standalone projects) and then under the repo root, so `run_command
 * cwd:"my-app"` lands in the project it just created rather than elia's own
 * root — the mismatch behind "npm run dev started elia again". The same rule
 * `preview` uses, so the two tools never disagree about where "my-app" is.
 */
export function resolveRunCwd(rawCwd: string, base = currentAgent().cwd ?? process.cwd()): string {
  if (!rawCwd) return base
  return resolveProjectPath(rawCwd, base)
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

/** A directory `cd` can be read as without any doubt about what the shell will do: no quotes, `$`, `~`, globs or spaces. */
const CD_THEN = /^\s*cd\s+([A-Za-z0-9_./-]+)\s*&&\s*(\S[\s\S]*?)\s*$/
const TRAILING_STDERR_REDIRECT = /\s+2>(?:&1|\/dev\/null)\s*$/

/**
 * `cd <dir> && <command>` is how models write "run this in that directory",
 * whatever this tool's description says, and it is exactly this tool's own
 * `cwd`. It is rewritten into that form before anything judges it, so the
 * governor assesses the command that really runs, in the directory it really
 * runs in — where every path check on `cwd` applies — instead of refusing the
 * pair as a composed script, which cost unattended runs a step or two each time.
 * A trailing `2>&1` or `2>/dev/null` only reshapes output this tool already
 * returns separately, and is dropped. Anything else — a directory with quotes,
 * `$` or spaces, a `;`, a pipe — stays in the command, for the governor to
 * judge as the composed command it is.
 */
export function normalizeRunCommandInput(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.command !== 'string') return input
  let command = input.command
  let cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
  for (let hops = 0; hops < 4; hops++) {
    const match = CD_THEN.exec(command)
    if (!match) break
    const dir = match[1]!
    // A composed cwd is normalized to forward slashes whichever platform runs
    // this: cmd.exe and PowerShell both accept `/`, and the tool's inputs —
    // including paths echoed back from `cd` — are otherwise inconsistent between
    // platforms (a `cd workspace/fork && …` input once surfaced a backslash
    // cwd on Windows).
    cwd = isAbsolute(dir) || !cwd ? dir : join(cwd, dir).replace(/\\/g, '/')
    command = match[2]!
  }
  command = command.replace(TRAILING_STDERR_REDIRECT, '')
  if (command === input.command) return input
  return { ...input, command, ...(cwd ? { cwd } : {}) }
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description: `Run a shell command and return its stdout, stderr, and exit code. Defaults to a 60 second timeout, or ${LONG_RUNNING_TIMEOUT_MS / 1000} seconds for a recognized install, build, or test command; pass timeoutMs to set it explicitly.

Pass \`cwd\` (relative to the workspace) to run inside a sub-project you created — e.g. cwd:"my-app" so \`npm install\` and \`npm run build\` use that project's package.json, not elia's own. Commands do NOT persist a directory between calls; always pass \`cwd\` rather than \`cd\`.

Do NOT run dev servers (\`npm run dev\`, \`vite\`, \`next dev\`, …) or any other command that does not exit here — they will time out. Use the \`process\` tool to start one in the background and read its logs, or \`preview\` to build and open a page without a server at all. Inherits the active autonomous cancellation signal.

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
    if (isLongRunningServerCommand(input.command)) {
      throw new Error(
        `"${input.command.trim().split(/\s+/).slice(0, 3).join(' ')}" starts a server that never exits — running it here just times out. Use the preview tool to serve and open the project (it stays live-reloaded), or start it yourself outside elia.`,
      )
    }
    const mismatch = shellMismatch(input.command)
    if (mismatch) throw new Error(mismatch)
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : defaultTimeoutForCommand(input.command)
    const cwd = resolveRunCwd(typeof input.cwd === 'string' ? input.cwd.trim() : '')
    const existing = alreadyExistingMkdir(input.command, cwd)
    if (existing) {
      const stdout = `${existing.length === 1 ? 'Directory already exists' : 'These directories already exist'}, nothing to do: ${existing.join(', ')}`
      return formatShellResult({ command: input.command, exitCode: 0, stdout, stderr: '', elapsedMs: 0, timedOut: false })
    }
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
        if (pre.exitCode !== 0) {
          // Install failed, but that is no reason to hide the command's own
          // output — run it anyway and say plainly that the install flopped.
          const attempted = await runShell(input.command, timeoutMs, cwd, signal, env)
          return [
            `[sub-project dependencies could not be auto-installed: ${installCmd}]`,
            formatShellResult(pre),
            '',
            `original command output:`,
            formatShellResult(attempted),
          ].join('\n')
        }
        const done = await runShell(input.command, timeoutMs, cwd, signal, env)
        return [`[installed sub-project dependencies first: ${installCmd}]`, formatShellResult(done)].join('\n')
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
