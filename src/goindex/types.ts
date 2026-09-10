/**
 * Wire protocol between the Elia CLI and `elia-index` (the Go workspace-search
 * sidecar in `go/`).
 *
 * Mirrors `go/internal/rpc/rpc.go` and the `index.Query` result shape. Keep the
 * two in lockstep and bump {@link GO_PROTOCOL_VERSION} on any breaking change —
 * the client checks it on every response and falls back to ripgrep / pure-JS on
 * mismatch.
 */

/** Bumped on any breaking change to a method's params or result shape. */
export const GO_PROTOCOL_VERSION = 1

export interface GoIndexQueryParams {
  pattern: string
  /** Absolute workspace directory to search under. */
  dir: string
  glob?: string
  context?: number
}

export interface GoIndexMatch {
  /** Slash-separated path relative to dir. */
  rel: string
  /** 1-based line number; 0 for "--" group separators. */
  line: number
  /** ":" match, "-" context, "--" separator. */
  sep: string
  text: string
}

export interface GoIndexQueryResult {
  matches: GoIndexMatch[]
  truncated: boolean
  skippedLarge: number
  skippedBinary: number
}

export interface GoIndexRpcResponse {
  id: number
  protocol: number
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * Error codes from the sidecar. -32602 (invalid params, including a pattern Go
 * cannot compile) surfaces as a plain error like the other backends; anything
 * else is a transport problem and the caller falls back.
 */
export const GO_INVALID_PARAMS = -32602
