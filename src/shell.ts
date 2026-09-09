/** Shared shell execution. One implementation so the tool, verification, and the evolution gate all behave identically. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonUnavailable, daemonMode, daemonShellExec } from './daemon/index.ts'

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

  const shellArgs = process.platform === 'win32' ? [windowsShell(), '/d', '/s', '/c', command] : ['sh', '-c', command]

  const proc = Bun.spawn(shellArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
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
  return [
    result.timedOut ? `timed out after ${result.elapsedMs}ms (killed)` : `exit code: ${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Trims long output to a head/tail window — the interesting parts of a failing build are at both ends. */
export function clampOutput(text: string, maxLength = 4000): string {
  if (text.length <= maxLength) return text
  const half = Math.floor(maxLength / 2)
  const omitted = text.length - maxLength
  return `${text.slice(0, half)}\n… [${omitted} characters omitted] …\n${text.slice(-half)}`
}
