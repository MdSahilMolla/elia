/** Shared shell execution. One implementation so the tool, verification, and the evolution gate all behave identically. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonUnavailable, daemonMode, daemonShellExec } from './daemon/index.ts'
import { BoxUnavailable, boxFallbackToHost, boxSandboxRequested, noteBoxFallback, runShellInBox } from './sandbox/box.ts'
import { ContainerUnavailable, containerSandboxRequested, noteContainerFallback, runShellInContainer } from './sandbox/container.ts'

/**
 * The Windows command interpreter, resolved to an absolute path.
 *
 * `Bun.spawn(['cmd', ...])` relies on PATH to find `cmd`, and on a machine
 * where `System32` is missing from PATH (or PATH is otherwise broken) that
 * fails with `ENOENT ... uv_spawn 'cmd'` — which took out *every* shell command,
 * including `mkdir`. `%ComSpec%` is set to cmd.exe's full path on every Windows
 * install; the System32 fallback covers the rare case where even that is unset.
 */
function windowsShell(): string {
  const comSpec = process.env.ComSpec || process.env.COMSPEC
  if (comSpec && existsSync(comSpec)) return comSpec
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidate = join(systemRoot, 'System32', 'cmd.exe')
  return existsSync(candidate) ? candidate : 'cmd.exe'
}

export interface ShellResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  elapsedMs: number
  timedOut: boolean
}

/** A direct process invocation. Arguments are never reparsed by cmd.exe or sh. */
export interface ProcessPlan {
  executable: string
  args?: string[]
  timeoutMs?: number
  cwd?: string
  signal?: AbortSignal
  env?: Record<string, string>
}

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000
export const MAX_SHELL_OUTPUT_LENGTH = 200_000

export async function runShell(
  command: string,
  timeoutMs = DEFAULT_SHELL_TIMEOUT_MS,
  /** Directory to run in. Passed to the spawn rather than prefixed as `cd`, which differs per shell (and per drive on Windows). */
  cwd?: string,
  /** Cooperative cancellation for autonomous runs. */
  signal?: AbortSignal,
  /**
   * Complete environment for the spawned process. When supplied it is used
   * verbatim (the caller is responsible for spreading `process.env`), and the
   * command runs in-process — the resident daemon's warm shell has a fixed
   * environment and cannot honour a per-command override.
   */
  env?: Record<string, string>,
): Promise<ShellResult> {
  // A missing working directory makes `Bun.spawn` fail with `ENOENT` blamed on
  // the shell executable itself (`cmd.exe` / `sh`), which sends anyone debugging
  // it chasing a broken PATH instead of the real cause. Check it up front and
  // return a result that names what is actually wrong.
  if (cwd !== undefined && !existsSync(cwd)) {
    return { command, exitCode: 1, stdout: '', stderr: `working directory does not exist: ${cwd}`, elapsedMs: 0, timedOut: false }
  }

  const startedAt = Date.now()

  // Operator cancellation must win even before the shell is spawned.
  if (signal?.aborted) {
    return { command, exitCode: 1, stdout: '', stderr: 'cancelled by operator', elapsedMs: 0, timedOut: false }
  }

  // elia-box (ELIA_SANDBOX=box) is elia's own sandbox and, unlike the container
  // path, fails closed: when the box cannot run, the command is refused rather
  // than quietly run outside it. Only an explicit ELIA_BOX_FALLBACK=host runs it
  // unsandboxed, and that is recorded once.
  if (boxSandboxRequested()) {
    try {
      return await runShellInBox(command, timeoutMs, cwd, signal, env)
    } catch (err) {
      if (signal?.aborted) {
        return { command, exitCode: 1, stdout: '', stderr: 'cancelled by operator', elapsedMs: Date.now() - startedAt, timedOut: false }
      }
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof BoxUnavailable && boxFallbackToHost()) {
        noteBoxFallback(message)
        // fall through to the daemon/in-process shell below.
      } else {
        const hint = err instanceof BoxUnavailable ? ' Set ELIA_BOX_FALLBACK=host to run unsandboxed instead.' : ''
        return { command, exitCode: 1, stdout: '', stderr: `elia-box did not run this command: ${message}.${hint}`, elapsedMs: Date.now() - startedAt, timedOut: false }
      }
    }
  }

  // Container sandboxing (ELIA_SANDBOX=container) takes precedence over the
  // daemon's warm-shell path below: it's an explicit isolation request, not
  // a performance optimization, so it should never be silently skipped by
  // one. Only a docker-itself transport failure (missing binary, daemon
  // unreachable) falls through to host execution — anything else the
  // sandboxed command produced, including its own failure, is returned as-is
  // rather than silently re-run outside the isolation the caller asked for.
  //
  // An env-scoped command runs in-process only because `runShellInContainer`
  // lacked an env channel at all — silently dropping the sandbox for every
  // workspace-scoped command (the audit finding A2-08). The container runner
  // now forwards env via docker `-e`, so an env override no longer cancels
  // the isolation.
  if (containerSandboxRequested()) {
    try {
      return await runShellInContainer(command, timeoutMs, cwd, signal, env)
    } catch (err) {
      if (signal?.aborted) {
        return { command, exitCode: 1, stdout: '', stderr: 'cancelled by operator', elapsedMs: Date.now() - startedAt, timedOut: false }
      }
      if (!(err instanceof ContainerUnavailable)) throw err
      noteContainerFallback(err.message)
      // fall through to the daemon/in-process shell below.
    }
  }

  // When the resident daemon is enabled it runs the command in a warm shell,
  // skipping the per-command process spawn (20–80ms on Windows). Any transport
  // problem falls through to the in-process path below; `ELIA_DAEMON=require`
  // surfaces the failure instead, for benchmarking the intended path.
  const mode = daemonMode()
  if (mode !== 'off' && !env) {
    try {
      const r = await daemonShellExec({
        command,
        cwd: cwd ?? process.cwd(),
        timeoutMs: Math.max(1, timeoutMs),
        signal,
      })
      return {
        command,
        exitCode: r.exit_code,
        stdout: clampOutput(r.stdout, MAX_SHELL_OUTPUT_LENGTH),
        stderr: clampOutput(r.stderr, MAX_SHELL_OUTPUT_LENGTH),
        elapsedMs: r.elapsed_ms,
        timedOut: r.timed_out,
      }
    } catch (err) {
      // An abort while the daemon was running the command surfaces here as a
      // rejection. Don't fall through and re-run it in-process — honour the stop.
      if (signal?.aborted) {
        return { command, exitCode: 1, stdout: '', stderr: 'cancelled by operator', elapsedMs: Date.now() - startedAt, timedOut: false }
      }
      if (mode === 'require' || !(err instanceof DaemonUnavailable)) throw err
      // auto: fall through to the in-process shell.
    }
  }

  const shell = shellInvocation(command)
  return runSpawned(command, shell.argv, timeoutMs, cwd, signal, env, shell.verbatim)
}

/**
 * The argv (and whether it must be passed verbatim) that runs `command` through
 * the platform shell exactly as written.
 *
 * On Windows the command used to go to `Bun.spawn` as one ordinary argv element,
 * which the spawner quotes by the MSVCRT rules — every `"` inside it became
 * `\"`. cmd.exe has no backslash escapes, so it ran those backslashes literally,
 * and every command containing a double quote broke: `dir "C:\a b\"` failed with
 * "The filename, directory name, or volume label syntax is incorrect",
 * `powershell -NoProfile -Command "…"` printed its own script back instead of
 * running it, and `cmd /c "…"` was "not recognized". That includes the
 * PowerShell form this codebase's own run_command guidance recommends. Seen
 * live, session mu0a7she-x8eipw: a "the preview isn't showing" turn spent
 * eleven run_command calls fighting exactly this before giving up.
 *
 * The fix is what Node does for `shell: true`: `/d /s /c "<command>"` with
 * verbatim arguments. `/s` makes cmd.exe strip exactly that outer pair of quotes
 * and run everything between them untouched.
 */
export function shellInvocation(command: string): { argv: string[]; verbatim: boolean } {
  if (process.platform === 'win32') return { argv: [windowsShell(), '/d', '/s', '/c', `"${command}"`], verbatim: true }
  return { argv: ['sh', '-c', command], verbatim: false }
}

/**
 * Quotes one value so it interpolates into a shell command as a single literal
 * argument — the layer between "run a free-form command" (runShell) and
 * "pass known args" (runProcess). Prefer runProcess when the argv is known at
 * the call site; use this only for the values that genuinely join a command
 * string. It makes `"; touch pwned` / `$(…)` text inert: the payload becomes
 * one argument's literal contents, never a new command segment.
 *
 * POSIX: single-quote, the only escape POSIX needs (' → `'\''`).
 * cmd.exe: quote the argument the way the program's own argv parser reads it
 * (backslashes before a quote doubled, the quote itself `\"`), then caret-escape
 * every cmd.exe metacharacter — the quotes included. A caret is literal *inside*
 * a quoted region, so the old `"…^"…"` form let an embedded `"` end the quoting
 * and a following `&` start a new command (`a" & echo pwned> x & "b` wrote the
 * file on a real cmd.exe), and `%PATH%` expanded. With every quote escaped, cmd
 * never enters a quoted state for a payload to break out of. This is
 * cross-spawn's escaping, checked against cmd.exe for `&`, `|`, `<>`, `%VAR%`,
 * `!`, `^` and trailing backslashes.
 */
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g

export function escapeShellArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
    return quoted.replace(CMD_METACHARACTERS, '^$1')
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Runs an executable directly. Use this for structured operations whose
 * executable and arguments are already known; reserve runShell for genuine
 * shell syntax such as pipelines and builtins.
 */
export async function runProcess(plan: ProcessPlan): Promise<ShellResult> {
  const executable = plan.executable.trim()
  const args = plan.args ?? []
  const command = [executable, ...args.map((arg) => JSON.stringify(arg))].join(' ')
  if (!executable) return { command, exitCode: 1, stdout: '', stderr: 'program executable is required', elapsedMs: 0, timedOut: false }
  return runSpawned(command, [executable, ...args], plan.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS, plan.cwd, plan.signal, plan.env)
}

async function runSpawned(
  command: string,
  spawnArgs: string[],
  timeoutMs: number,
  cwd?: string,
  signal?: AbortSignal,
  env?: Record<string, string>,
  /** Pass `spawnArgs` to Windows untouched — only for a `shellInvocation` argv that is already quoted for cmd.exe. */
  verbatim = false,
): Promise<ShellResult> {
  if (cwd !== undefined && !existsSync(cwd)) {
    return { command, exitCode: 1, stdout: '', stderr: `working directory does not exist: ${cwd}`, elapsedMs: 0, timedOut: false }
  }

  const startedAt = Date.now()
  if (signal?.aborted) {
    return { command, exitCode: 1, stdout: '', stderr: 'cancelled by operator', elapsedMs: 0, timedOut: false }
  }

  const proc = Bun.spawn(spawnArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    ...(process.platform === 'win32' ? {} : { detached: true }),
  })

  let timedOut = false
  let cancelled = false
  let terminated = false
  const terminate = () => {
    if (terminated) return
    terminated = true
    terminateProcessGroup(proc)
  }
  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, Math.max(1, timeoutMs))
  const onAbort = () => {
    cancelled = true
    terminate()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  let stdout = ''
  let stderr = ''
  let exitCode = 1
  let completed = false
  try {
    ;[stdout, stderr, exitCode] = await Promise.all([
      readBoundedOutput(proc.stdout, MAX_SHELL_OUTPUT_LENGTH),
      readBoundedOutput(proc.stderr, MAX_SHELL_OUTPUT_LENGTH),
      proc.exited,
    ])
    completed = true
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
    if (!completed) terminate()
  }

  return {
    command,
    exitCode,
    stdout,
    stderr: cancelled && !stderr ? 'cancelled by operator' : stderr,
    elapsedMs: Date.now() - startedAt,
    timedOut,
  }
}

export async function readBoundedOutput(stream: ReadableStream<Uint8Array>, maxLength: number): Promise<string> {
  const limit = Math.max(0, Math.floor(maxLength))
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let totalLength = 0
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      totalLength += chunk.length
      if (output.length < limit) output += chunk.slice(0, limit - output.length)
      if (totalLength > limit) {
        await reader.cancel()
        return `${output}\n[additional characters omitted]`
      }
    }
    const finalChunk = decoder.decode()
    totalLength += finalChunk.length
    if (output.length < limit) output += finalChunk.slice(0, limit - output.length)
  } finally {
    reader.releaseLock()
  }
  return totalLength <= limit ? output : `${output}\n… [${totalLength - limit} characters omitted] …`
}

export function terminateProcessGroup(proc: Bun.Subprocess): void {
  if (process.platform === 'win32' && proc.pid) {
    try {
      const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
      const taskkill = existsSync(join(systemRoot, 'System32', 'taskkill.exe')) ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
      Bun.spawnSync([taskkill, '/PID', String(proc.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
    } catch {
      try {
        proc.kill()
      } catch {
        return
      }
    }
  } else if (proc.pid) {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      try {
        proc.kill()
      } catch {
        return
      }
      return
    }
    setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {
        // The process group has already exited.
      }
    }, 750).unref()
  } else {
    try {
      proc.kill()
    } catch {
      // The process has already exited.
    }
  }
}

/** Formats a result the way a model reads it best: status first, then the output that explains it. */
export function formatShellResult(result: ShellResult): string {
  const hint = result.exitCode !== 0 && !result.timedOut ? failureHint(result.stdout, result.stderr) : undefined
  return [
    result.timedOut ? `timed out after ${result.elapsedMs}ms (killed)` : `exit code: ${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
    hint ? `hint: ${hint}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * What a failure means when its output hides the cause from anyone who has not
 * seen it before.
 *
 * `go test` whose test binary dies — a test calls main(), which calls os.Exit —
 * prints only "exit status 1 / FAIL <pkg>" with no test named. A Go CLI run in
 * the battery spent every repair attempt on exactly that output, then recorded
 * a lesson blaming the unattended policy for it.
 */
export function failureHint(stdout: string, stderr = ''): string | undefined {
  const output = `${stdout}\n${stderr}`
  if (/^FAIL\s+\S+\s+[\d.]+s\s*$/m.test(output) && /exit status \d+/.test(output) && !/--- FAIL:/.test(output) && !/^panic:/m.test(output)) {
    const started = [...output.matchAll(/^=== RUN\s+(\S+)/gm)].map((m) => m[1]!)
    const last = started.at(-1)
    return `the Go test binary exited before reporting any result — a test${last ? ` (the last one started was ${last})` : ''}, or code it calls such as main(), ran os.Exit or log.Fatal, which ends \`go test\` itself.${last ? '' : ' Run `go test -v` to see which test was running.'} Move that logic into a function that returns an error or exit code, test that function, and let only main() call os.Exit.`
  }
  return undefined
}

/** Trims long output to a head/tail window — the interesting parts of a failing build are at both ends. */
export function clampOutput(text: string, maxLength = 4000): string {
  if (text.length <= maxLength) return text
  const half = Math.floor(maxLength / 2)
  const omitted = text.length - maxLength
  return `${text.slice(0, half)}\n… [${omitted} characters omitted] …\n${text.slice(-half)}`
}

/**
 * Commands that start a server and then stay up on purpose.
 *
 * Three copies of this idea existed, each with a slightly different list, and
 * the one place it mattered most had none: `run_command` refused these, the
 * action contract skipped its exit-zero postcondition for them, and the
 * verification runner executed them anyway. So a plan could name `bun run dev`
 * as a verification command and elia would dutifully run it, block for the full
 * verification timeout, kill it, read the non-zero exit as "the work is broken",
 * and spend the run's repair budget rewriting code that was never at fault.
 *
 * Seen live, run 2026-09-13-l0av-rnq0: `bun run dev` ran for 236 seconds and
 * exited 58 after being killed. It was the second of three verification
 * commands, so the gate could never pass no matter what the workers built, and
 * the run ended `needs-attention` with a working Vite build on disk.
 *
 * One list, exported, so the three call sites cannot drift apart again.
 *
 * It is matched against the program each segment of the command actually runs
 * (see invokedProgram), not anywhere in the line. Matching anywhere made a
 * server's *name* enough: `pip install uvicorn`, `uv add uvicorn`, `pip install
 * gunicorn flask` and `npm install serve` all read as starting a server, so
 * run_command refused to install the one package a FastAPI project cannot run
 * without — and `vite build` read as `vite`.
 */
export function isLongRunningServerCommand(command: string): boolean {
  return command.split(COMMAND_SEPARATOR).some((segment) => LONG_RUNNING_SERVER.test(invokedProgram(segment)))
}

/**
 * A run of an app's own entrypoint — `python app.py`, `node server.js`, `bun
 * run src/server.ts` — which starts a server as often as it runs a script. The
 * name cannot say which, so this is deliberately not part of
 * isLongRunningServerCommand: run_command must still be able to run a script
 * that happens to be called app.py. Verification probes these instead of
 * waiting out its full timeout on them.
 */
export function mayStartServer(command: string): boolean {
  return command.split(COMMAND_SEPARATOR).some((segment) => APP_ENTRYPOINT.test(invokedProgram(segment)))
}

/** `&&`, `||`, `;`, `|`, a backgrounding `&`, a line break. */
const COMMAND_SEPARATOR = /&&|\|\||[;|&\r\n]/

/**
 * One command segment with whatever only *launches* the real program stripped:
 * environment assignments, `npx`/`bunx`/`pnpm dlx`/`npm exec`, `uv run`/`uvx`/
 * `poetry run`/`pipenv run`/`bundle exec`, and `python -m`. What is left starts
 * with the program that actually runs.
 */
function invokedProgram(segment: string): string {
  let program = segment.trim()
  for (;;) {
    const next = program
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
      .replace(/^(?:npx|bunx|pnpx|uvx|(?:pnpm|yarn)\s+dlx|npm\s+exec|uv\s+run|poetry\s+run|pipenv\s+run|pdm\s+run|hatch\s+run|bundle\s+exec)(?:\s+-{1,2}[A-Za-z][\w-]*)*\s+/i, '')
      .replace(/^(?:python3?|py)(?:\.exe)?\s+-m\s+/i, '')
    if (next === program) return program
    program = next
  }
}

// Anchored: the program itself, optionally behind a path (`./node_modules/.bin/vite`, `bin/rails`).
const LONG_RUNNING_SERVER =
  /^(?:\S*[\\/])?(?:(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+|task\s+)?(?:dev|start|serve|preview|watch)\b|vite(?:\s+(?:dev|serve|preview)\b|\s+-|\s*$)|next\s+(?:dev|start)\b|nuxt\s+(?:dev|start)\b|nuxi\s+dev\b|astro\s+dev\b|remix\s+dev\b|nodemon\b|ts-node-dev\b|concurrently\b|http-server\b|live-server\b|serve(?:\s|$)|http\.server\b|flask\s+run\b|uvicorn\b|gunicorn\b|daphne\b|hypercorn\b|waitress-serve\b|fastapi\s+(?:dev|run)\b|streamlit\s+run\b|gradio\s+\S+\.py\b|(?:panel|bokeh)\s+serve\b|(?:chainlit|solara|reflex|shiny)\s+run\b|(?:django-admin|django)\s+runserver\b|(?:python3?|py)(?:\.exe)?\s+(?:\S*[\\/])?manage\.py\s+runserver\b|rails\s+s(?:erver)?\b|php\s+artisan\s+serve\b|jekyll\s+serve\b|hugo\s+server\b|webpack(?:-dev)?-server\b|webpack\s+serve\b|ng\s+serve\b|expo\s+start\b|docker(?:-compose|\s+compose)\s+up\b(?!.*\s(?:-d|--detach)\b)|(?:bun|node|deno)\b.*\s--(?:watch|hot)\b|tail\s+-f\b|watchexec\b)/i

const APP_ENTRYPOINT =
  /^(?:\S*[\\/])?(?:python3?|py|node|bun|deno|tsx|ts-node)(?:\.exe)?\s+(?:run\s+)?(?:-\S+\s+)*(?:\S*[\\/])?(?:app|server|main|index|run|wsgi|asgi|api|web)\.(?:py|[cm]?[jt]sx?)(?:\s|$)/i

/**
 * Guidance for a command name that does not exist in *this* platform's shell
 * but is second nature in another one.
 *
 * On Windows elia runs through cmd.exe, where `ls`, `pwd`, `cat`, `rm` and the
 * PowerShell `Verb-Noun` cmdlets are simply not commands. The action contract
 * checked availability with a PATH lookup, correctly found nothing, and then
 * reported "`ls` is not available in PATH — fix the missing environment or ask
 * the user to take over". That is true and useless: the environment is fine,
 * the agent just used another shell's vocabulary. Worse, `classifyStuck` reads
 * that shape as a broken environment, so a run could decide its machine was
 * misconfigured because a worker typed `ls`.
 *
 * Seen live, run 2026-09-13-l0av-rnq0: `ls`, `pwd`, `rm`, `Get-Location`,
 * `Get-ChildItem` and `Get-Content` each failed this way, eight times in one
 * run, every one of them burning an action from the budget.
 *
 * Returns `undefined` for a name that is genuinely just missing (a tool that
 * really does need installing), so the original "not available" message still
 * stands where it is the right answer.
 */
export function shellCommandAlternative(executable: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined
  const name = executable.trim().toLowerCase()

  const replacement = POSIX_ON_WINDOWS.get(name)
  if (replacement) {
    return `\`${executable}\` is a POSIX command and this shell is cmd.exe, so it does not exist here — this is not a broken environment. ${replacement}`
  }

  // A PowerShell cmdlet invoked directly: cmd.exe has no such executable.
  // PascalCase Verb-Noun specifically, the same shape the pipe-level check in
  // runCommand.ts looks for — a case-insensitive match would also claim
  // ordinary hyphenated binaries like `tree-sitter` or `docker-compose`.
  if (/^[A-Z][a-z]{1,}-[A-Z][A-Za-z]{1,}$/.test(executable.trim())) {
    return `\`${executable}\` is a PowerShell cmdlet, not an executable cmd.exe can run — this is not a broken environment. Put the whole pipeline inside one quoted argument: powershell -NoProfile -Command "${executable} …".`
  }

  return undefined
}

/**
 * Whether `command` starts with another shell's vocabulary that this machine
 * cannot run — `ls` under cmd.exe, or a PowerShell cmdlet called directly —
 * so it fails before running anything, in every mode, on every attempt. A name
 * that is on PATH anyway (Git's `usr/bin` puts a real `ls` there) is not one.
 */
export function startsWithForeignShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  which: (name: string) => string | null = (name) => Bun.which(name),
): boolean {
  const first = /^([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/.exec(command.trim())?.[1]
  if (!first || shellCommandAlternative(first, platform) === undefined) return false
  return which(first) === null
}

/**
 * Deliberately points at elia's own tools where one exists: they work the same
 * on every platform, and they are cheaper and more reliable than shelling out.
 */
const POSIX_ON_WINDOWS = new Map<string, string>([
  ['ls', 'Use the `list_files` tool instead of shelling out.'],
  ['pwd', 'Use the `list_files` tool, and pass `cwd` explicitly to run_command rather than asking where you are.'],
  ['cat', 'Use the `read_file` tool instead of shelling out.'],
  ['head', 'Use the `read_file` tool, which takes a line range.'],
  ['tail', 'Use the `read_file` tool, which takes a line range.'],
  ['grep', 'Use the `grep` tool instead of shelling out.'],
  ['find', 'Use the `list_files` tool with a glob pattern.'],
  ['rm', 'Use `del <file>` or `rmdir /s /q <dir>` in cmd.exe.'],
  ['cp', 'Use `copy <src> <dest>` in cmd.exe.'],
  ['mv', 'Use `move <src> <dest>` in cmd.exe.'],
  ['touch', 'Use the `write_file` tool to create a file.'],
  ['which', 'Use `where <tool>` in cmd.exe.'],
  ['sed', 'Use the `edit_file` tool to change file contents.'],
  ['awk', 'Use the `read_file` and `grep` tools, or write a real .js/.py script with write_file and run that.'],
  ['export', 'cmd.exe uses `set NAME=value`, and it does not persist between run_command calls.'],
  ['chmod', 'File modes are not a Windows concept; no equivalent is needed.'],
  ['uname', 'Use `ver` in cmd.exe.'],
  ['clear', 'Use `cls` in cmd.exe.'],
])
