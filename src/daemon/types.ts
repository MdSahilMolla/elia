/**
 * The wire protocol between the Elia CLI and `eliad` (the resident daemon).
 *
 * Mirrors `crates/eliad/src/protocol.rs` field-for-field. Keep the two in
 * lockstep and bump {@link PROTOCOL_VERSION} on any breaking change — the client
 * checks it on connect (`daemon.info`) and replaces a daemon that does not
 * match.
 */

/** Bumped on any breaking change to a method's params or result shape. */
export const PROTOCOL_VERSION = 1

export interface RpcRequest {
  id: number
  method: string
  params: unknown
}

export interface RpcResponse {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

/** Result of `daemon.info`. */
export interface DaemonInfo {
  version: string
  protocol: number
  pid: number
  uptime_ms: number
  shell_workers: number
}

export interface ShellExecParams {
  command: string
  /** Absolute directory to run in. */
  cwd: string
  timeout_ms: number
}

export interface ShellExecResult {
  exit_code: number
  stdout: string
  stderr: string
  elapsed_ms: number
  timed_out: boolean
}

/** Negative RPC error codes are transport/daemon problems; the client treats
 * them as "fall back to the in-process path". A command that exits non-zero is a
 * successful RPC with `exit_code !== 0`, never an error. */
export const RPC_METHOD_NOT_FOUND = -32601
