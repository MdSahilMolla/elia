/** Shared shell execution. One implementation so the tool, verification, and the evolution gate all behave identically. */

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
): Promise<ShellResult> {
  const startedAt = Date.now()
  const shellArgs = process.platform === 'win32' ? ['cmd', '/c', command] : ['sh', '-c', command]

  const proc = Bun.spawn(shellArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
    ...(process.platform === 'win32' ? {} : { detached: true }),
  })

  let timedOut = false
  let cancelled = false
  let terminated = false
  const terminate = () => {
    if (terminated) return
    terminated = true
    if (process.platform !== 'win32' && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM')
      } catch {
        proc.kill()
      }
      setTimeout(() => {
        try {
          process.kill(-proc.pid, 'SIGKILL')
        } catch {
          // The process group may already have exited.
        }
      }, 750).unref()
    } else {
      proc.kill()
    }
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

  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(proc.stdout, MAX_SHELL_OUTPUT_LENGTH),
    readBounded(proc.stderr, MAX_SHELL_OUTPUT_LENGTH),
    proc.exited,
  ])
  clearTimeout(timeout)
  signal?.removeEventListener('abort', onAbort)

  return {
    command,
    exitCode,
    stdout,
    stderr: cancelled && !stderr ? 'cancelled by operator' : stderr,
    elapsedMs: Date.now() - startedAt,
    timedOut,
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxLength: number): Promise<string> {
  const text = await new Response(stream).text()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\\n… [${text.length - maxLength} characters omitted] …`
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
