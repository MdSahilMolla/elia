import { readBoundedOutput } from '../shell.ts'

/**
 * Argv-level execution for `git` and `gh`, with no shell in the middle.
 *
 * The `github` tool builds commands from model-supplied strings — commit
 * messages, PR titles and bodies, branch names. Passing those through a shell
 * (`sh -c "git commit -m ..."`) is a command-injection surface. Spawning the
 * binary directly with an argv array closes it: a title of `"; rm -rf /` is
 * just an odd PR title, never a second command.
 */

export interface ExecResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  /** True when the binary itself was not found on PATH. */
  missing: boolean
}

export type ExecFn = (bin: 'git' | 'gh', args: string[], cwd: string | undefined, signal?: AbortSignal) => Promise<ExecResult>

const MAX_OUTPUT = 100_000
/** A `gh` call reaches the GitHub API; a `git push` reaches the remote. Bound the wait so a stuck network or a credential prompt can't hang a turn. */
const DEFAULT_TIMEOUT_MS = 30_000

const realExec: ExecFn = async (bin, args, cwd, signal) => {
  if (!Bun.which(bin)) {
    return { ok: false, exitCode: 127, stdout: '', stderr: `${bin} is not installed or not on PATH`, missing: true }
  }
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    })
    let timedOut = false
    const kill = () => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, DEFAULT_TIMEOUT_MS)
    const onAbort = () => kill()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readBoundedOutput(proc.stdout, MAX_OUTPUT),
        readBoundedOutput(proc.stderr, MAX_OUTPUT),
        proc.exited,
      ])
      if (timedOut) {
        return { ok: false, exitCode: 124, stdout: stdout.trim(), stderr: `${bin} ${args[0] ?? ''} timed out after ${DEFAULT_TIMEOUT_MS}ms`, missing: false }
      }
      return { ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim(), missing: false }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    return { ok: false, exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), missing: false }
  }
}

let execImpl: ExecFn = realExec

export function execCapture(bin: 'git' | 'gh', args: string[], cwd?: string, signal?: AbortSignal): Promise<ExecResult> {
  return execImpl(bin, args, cwd, signal)
}

/** Test-only: swap the executor for a stub. Pass nothing to restore the real one. */
export function setExecForTests(fn?: ExecFn): void {
  execImpl = fn ?? realExec
}
