/**
 * Runtime shape checks for `eliad` RPC results.
 *
 * Every daemon call site casts `result: unknown` straight to its expected
 * interface (`result as ShellExecResult`, etc.) with no runtime check. A
 * daemon built from a drifted protocol version, a corrupted response, or a
 * future breaking change would have its malformed fields flow straight into
 * callers (registry.ts's tool wrapping, the shell/parse/jvm check call sites)
 * instead of being caught here. Every caller already has a fallback path for
 * {@link DaemonUnavailable} (falls back to the in-process equivalent), so a
 * validation failure is folded into that same, already-handled error type
 * rather than becoming a new failure mode.
 */

import { DaemonUnavailable, type DaemonInfo, type JvmCheckResult, type ParseCheckResult, type ShellExecResult } from './types.ts'
import type { DaemonMcpCallResult, DaemonMcpEnsureResult, DaemonMcpToolDescriptor } from '../mcp/daemonBridge.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function invalid(method: string, detail: string): never {
  throw new DaemonUnavailable(`${method} returned a malformed result (${detail})`)
}

export function validateDaemonInfo(value: unknown): DaemonInfo {
  if (
    isRecord(value) &&
    typeof value.version === 'string' &&
    typeof value.protocol === 'number' &&
    typeof value.pid === 'number' &&
    typeof value.uptime_ms === 'number' &&
    typeof value.shell_workers === 'number'
  ) {
    return value as unknown as DaemonInfo
  }
  invalid('daemon.info', 'expected {version, protocol, pid, uptime_ms, shell_workers}')
}

export function validateShellExecResult(value: unknown): ShellExecResult {
  if (
    isRecord(value) &&
    typeof value.exit_code === 'number' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    typeof value.elapsed_ms === 'number' &&
    typeof value.timed_out === 'boolean'
  ) {
    return value as unknown as ShellExecResult
  }
  invalid('shell.exec', 'expected {exit_code, stdout, stderr, elapsed_ms, timed_out}')
}

export function validateParseCheckResult(value: unknown): ParseCheckResult {
  if (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    Array.isArray(value.errors) &&
    value.errors.every((e) => isRecord(e) && typeof e.line === 'number' && typeof e.column === 'number' && typeof e.message === 'string')
  ) {
    return value as unknown as ParseCheckResult
  }
  invalid('parse.check', 'expected {ok, errors: {line, column, message}[]}')
}

export function validateJvmCheckResult(value: unknown): JvmCheckResult {
  if (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    Array.isArray(value.errors) &&
    value.errors.every(
      (e) => isRecord(e) && typeof e.line === 'number' && typeof e.column === 'number' && typeof e.message === 'string' && (e.severity === 'error' || e.severity === 'warning'),
    )
  ) {
    return value as unknown as JvmCheckResult
  }
  invalid('jvm.check', 'expected {ok, errors: {line, column, message, severity}[]}')
}

function isToolDescriptor(value: unknown): value is DaemonMcpToolDescriptor {
  if (!isRecord(value) || typeof value.server !== 'string' || typeof value.name !== 'string') return false
  if (value.description !== undefined && typeof value.description !== 'string') return false
  if (value.inputSchema !== undefined && !isRecord(value.inputSchema)) return false
  return true
}

export function validateDaemonMcpEnsureResult(value: unknown): DaemonMcpEnsureResult {
  if (
    isRecord(value) &&
    Array.isArray(value.tools) &&
    value.tools.every(isToolDescriptor) &&
    Array.isArray(value.failed) &&
    value.failed.every((f) => isRecord(f) && typeof f.server === 'string' && typeof f.reason === 'string')
  ) {
    return value as unknown as DaemonMcpEnsureResult
  }
  invalid('mcp.ensure', 'expected {tools: ToolDescriptor[], failed: {server, reason}[]}')
}

export function validateDaemonMcpCallResult(value: unknown): DaemonMcpCallResult {
  if (!isRecord(value)) invalid('mcp.call', 'expected an object')
  if (value.content !== undefined) {
    if (!Array.isArray(value.content) || !value.content.every((c) => isRecord(c) && typeof c.type === 'string' && (c.text === undefined || typeof c.text === 'string'))) {
      invalid('mcp.call', 'content must be {type, text?}[]')
    }
  }
  if (value.isError !== undefined && typeof value.isError !== 'boolean') invalid('mcp.call', 'isError must be a boolean')
  return value as unknown as DaemonMcpCallResult
}
