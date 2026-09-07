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

export interface ParseCheckParams {
  /** The full proposed file contents. */
  source: string
  /** File path — its extension selects the lexical rules. */
  path?: string
  /** Explicit language override: "js" | "ts" | "py" | "rs" | "go" | "generic". */
  language?: string
}

export interface ParseCheckError {
  line: number
  column: number
  message: string
}

/** Result of `parse.check` — from the C++ structural validator (native/elia-parse). */
export interface ParseCheckResult {
  ok: boolean
  errors: ParseCheckError[]
}

export interface JvmCheckParams {
  /** Full proposed contents of a single `.java` file. */
  source: string
  /** File path — the class/package name is read from `source`, this is the fallback. */
  path?: string
  /** Optional classpath entries for resolving imports. */
  classpath?: string[]
}

export interface JvmDiagnostic {
  line: number
  column: number
  message: string
  severity: 'error' | 'warning'
}

/** Result of `jvm.check` — from the JDK compiler via elia-jvm-bridge (Java). */
export interface JvmCheckResult {
  ok: boolean
  errors: JvmDiagnostic[]
}

/** Negative RPC error codes are transport/daemon problems; the client treats
 * them as "fall back to the in-process path". A command that exits non-zero is a
 * successful RPC with `exit_code !== 0`, never an error. */
export const RPC_METHOD_NOT_FOUND = -32601
