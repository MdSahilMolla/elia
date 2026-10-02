/**
 * Whether the mesh sidecar should run, and where it lives.
 *
 * Two rules are deliberate and load-bearing:
 *
 * - The binary is found through `ELIA_RWS_PATH` and nowhere else. The component
 *   is a separate build with its own release cycle, and a guessed path is a
 *   guess about someone else's install layout. A missing variable is a clear
 *   "not configured", not something to paper over.
 * - The default is `off`. A file plane that starts syncing a project folder
 *   because it happened to be installable would be the wrong default for a
 *   tool that mutates the user's files.
 */

import { accessSync, constants, statSync } from 'node:fs'

/** `off` (default) — never start the mesh. `auto` — start only an already-paired
 * workspace. `require` — start and surface failures, for exercising the
 * intended path. */
export type MeshMode = 'off' | 'auto' | 'require'

export function meshMode(): MeshMode {
  const raw = (process.env.ELIA_WORKSPACE_MESH ?? 'off').toLowerCase()
  return raw === 'auto' || raw === 'require' ? raw : 'off'
}

export function meshEnabled(): boolean {
  return meshMode() !== 'off'
}

/**
 * The absolute path to the `workspace` sidecar, or `undefined` when it is not
 * configured or not runnable. A path that is set but missing or non-executable
 * resolves to `undefined` rather than being returned and failing at spawn:
 * {@link meshPathProblem} recovers the reason for a message.
 */
export function resolveMeshPath(): string | undefined {
  const configured = process.env.ELIA_RWS_PATH?.trim()
  if (!configured) return undefined
  return isRunnable(configured) ? configured : undefined
}

/**
 * Why `ELIA_RWS_PATH` did not resolve, when it was set. Returns `undefined`
 * when the variable is unset (nothing to explain) or the binary is fine.
 */
export function meshPathProblem(): string | undefined {
  const configured = process.env.ELIA_RWS_PATH?.trim()
  if (!configured) return undefined
  if (!exists(configured)) return `ELIA_RWS_PATH points at ${configured}, which does not exist`
  if (!isRunnable(configured)) return `ELIA_RWS_PATH points at ${configured}, which is not executable`
  return undefined
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function isRunnable(path: string): boolean {
  if (!exists(path)) return false
  // Windows has no executable bit; a `.cmd`/`.exe` is runnable if it exists.
  if (process.platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * How the host sidecar is reached by members that reconnect.
 *
 * `attach` on its own binds `127.0.0.1:0`, which is right for a folder nobody
 * else talks to and useless for a mesh: a member that has already paired reaches
 * the host at the address it was given once, and a host that re-binds to a random
 * port on restart is a host that cannot be reached again. So the address has to be
 * configurable, and the advertised address is the one that matters — it is what
 * ends up in the member's pinned record.
 *
 * Only consulted for a host. A member reconnects to the address pairing recorded,
 * and re-advertising one would just be a second place to be wrong.
 */
export function meshHostListenAddress(): string {
  const configured = process.env.ELIA_RWS_LISTEN?.trim()
  return configured === undefined || configured === '' ? '127.0.0.1:0' : configured
}

export function meshHostAdvertiseAddress(): string | undefined {
  const configured = process.env.ELIA_RWS_ADVERTISE?.trim()
  if (configured === undefined || configured === '') return undefined
  return stripAdvertisePort(configured)
}

/**
 * Drops a port from an advertised address.
 *
 * The sidecar puts this value in the join code as a bare host and takes the port
 * from what it bound, so `host:port` here becomes an address it wraps a second
 * time — a literal `[host:port]:port` that no peer can resolve. The failure shows
 * up on the *other* machine, some seconds after this one was configured, which is
 * about the worst place to find out.
 *
 * A bare IPv6 literal is the case this must not get wrong: it is mostly colons,
 * and its last group is digits. Two colons means there is no port to strip, and a
 * bracketed address is split on the bracket instead.
 */
function stripAdvertisePort(value: string): string {
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    return close === -1 ? value : value.slice(0, close + 1)
  }
  const colons = value.split(':').length - 1
  if (colons !== 1) return value
  const separator = value.lastIndexOf(':')
  return /^[0-9]+$/.test(value.slice(separator + 1)) ? value.slice(0, separator) : value
}
