import { runProcess, type ShellResult } from '../shell.ts'
import { logSwallowedError } from '../diagnostics.ts'

/**
 * An additive container execution backend for runShell, alongside (not
 * replacing) the existing git-worktree isolation used for parallel variant
 * runs. Worktrees isolate *files*; this isolates the *process* a command
 * actually runs in — a different, complementary boundary (no host package
 * installs, no host network by default, no access to anything outside the
 * bind-mounted project directory).
 *
 * Strictly opt-in and, when not opted into, exactly zero behavioral change:
 * both the mode env var and an explicit image are required before this ever
 * runs a single `docker` command.
 */

export class ContainerUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContainerUnavailable'
  }
}

export function containerSandboxRequested(): boolean {
  return (process.env.ELIA_SANDBOX ?? '').trim().toLowerCase() === 'container'
}

/**
 * No default: guessing a base image is the same mistake deployment.ts
 * deliberately avoids for a registry destination — a large, surprising,
 * unattended `docker pull` is not something to trigger from an implicit
 * fallback. `ELIA_SANDBOX=container` opts into the feature; a separate,
 * explicit `ELIA_SANDBOX_IMAGE` opts into an actual image.
 */
export function sandboxImage(): string | undefined {
  const value = process.env.ELIA_SANDBOX_IMAGE?.trim()
  return value || undefined
}

export function containerSandboxConfigured(): boolean {
  return containerSandboxRequested() && Boolean(sandboxImage())
}

const CONTAINER_WORKDIR = '/workspace'

/**
 * Runs `command` inside `docker run --rm`, the project directory bind-mounted
 * at {@link CONTAINER_WORKDIR}. Throws {@link ContainerUnavailable} only when
 * docker itself could not be used at all (missing binary, daemon
 * unreachable) — the caller's cue to fall back to host execution, mirroring
 * exactly how daemon/client.ts's DaemonUnavailable already signals "try the
 * next backend" to runShell. Any other outcome — including the sandboxed
 * command failing, or the configured image itself being missing — returns a
 * normal ShellResult instead of throwing: the command genuinely ran (or
 * genuinely could not be started for a reason that is a configuration
 * problem, not a "docker is unavailable" problem), and re-running it again on
 * the bare host would silently discard the isolation the caller explicitly
 * asked for.
 */
export async function runShellInContainer(command: string, timeoutMs: number, cwd?: string, signal?: AbortSignal): Promise<ShellResult> {
  const image = sandboxImage()
  if (!image) throw new ContainerUnavailable('ELIA_SANDBOX_IMAGE is not set — elia will not guess a sandbox image')
  if (!Bun.which('docker')) throw new ContainerUnavailable('docker is not installed or not on PATH')

  const workspace = cwd ?? process.cwd()
  const networkArgs = (process.env.ELIA_SANDBOX_NETWORK ?? '').trim().toLowerCase() === 'off' ? ['--network', 'none'] : []
  const args = ['run', '--rm', '-v', `${workspace}:${CONTAINER_WORKDIR}`, '-w', CONTAINER_WORKDIR, ...networkArgs, image, 'sh', '-c', command]

  const result = await runProcess({ executable: 'docker', args, timeoutMs, cwd: workspace, signal })

  if (isDockerTransportFailure(result)) {
    throw new ContainerUnavailable(result.stderr.trim() || `docker exited with code ${result.exitCode} before the command could run`)
  }
  // Report the original command the caller asked for, not the docker argv
  // that actually ran — everything else about the result is exactly what
  // that command produced, sandboxed.
  return { ...result, command }
}

/**
 * True only for docker's own connection/startup failures — the daemon isn't
 * running, the socket isn't reachable, permission was refused connecting to
 * it. A timeout is the sandboxed command's own problem (it genuinely ran,
 * just too slowly) and is never treated as a transport failure; neither is a
 * missing image, which is a configuration error the operator needs to see
 * and fix, not something to silently drop the sandbox for.
 */
export function isDockerTransportFailure(result: ShellResult): boolean {
  if (result.timedOut || result.exitCode === 0) return false
  const stderr = result.stderr.toLowerCase()
  return /cannot connect to the docker daemon|docker daemon is not running|is the docker daemon running\?|error during connect|permission denied while trying to connect/.test(stderr)
}

/** Emits a diagnostics record (never a console warning that would spam every fallback) the first time this run's container sandbox falls back to the host. */
let warnedThisProcess = false
export function noteContainerFallback(reason: string): void {
  if (warnedThisProcess) return
  warnedThisProcess = true
  logSwallowedError('sandbox.container.fallbackToHost', new Error(reason))
}

/** Test seam. */
export function resetContainerSandboxWarningForTests(): void {
  warnedThisProcess = false
}
