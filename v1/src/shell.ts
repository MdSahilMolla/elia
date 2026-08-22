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

export async function runShell(
  command: string,
  timeoutMs = DEFAULT_SHELL_TIMEOUT_MS,
  /** Directory to run in. Passed to the spawn rather than prefixed as `cd`, which differs per shell (and per drive on Windows). */
  cwd?: string,
): Promise<ShellResult> {
  const startedAt = Date.now()
  const shellArgs = process.platform === 'win32' ? ['cmd', '/c', command] : ['sh', '-c', command]

  const proc = Bun.spawn(shellArgs, { stdout: 'pipe', stderr: 'pipe', ...(cwd ? { cwd } : {}) })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timeout)

  return { command, exitCode, stdout, stderr, elapsedMs: Date.now() - startedAt, timedOut }
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
