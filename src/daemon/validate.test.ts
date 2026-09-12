import { expect, test } from 'bun:test'
import { DaemonUnavailable } from './types.ts'
import {
  validateDaemonInfo,
  validateDaemonMcpCallResult,
  validateDaemonMcpEnsureResult,
  validateJvmCheckResult,
  validateParseCheckResult,
  validateShellExecResult,
} from './validate.ts'

test('validateDaemonInfo accepts a well-formed result and returns it unchanged', () => {
  const info = { version: '1.2.3', protocol: 1, pid: 42, uptime_ms: 100, shell_workers: 4 }
  expect(validateDaemonInfo(info)).toEqual(info)
})

test('validateDaemonInfo rejects a malformed result as DaemonUnavailable', () => {
  expect(() => validateDaemonInfo({ version: '1.2.3' })).toThrow(DaemonUnavailable)
  expect(() => validateDaemonInfo(null)).toThrow(DaemonUnavailable)
  expect(() => validateDaemonInfo('not an object')).toThrow(DaemonUnavailable)
  expect(() => validateDaemonInfo({ version: 1, protocol: 1, pid: 1, uptime_ms: 1, shell_workers: 1 })).toThrow(DaemonUnavailable)
})

test('validateShellExecResult accepts a well-formed result and rejects a malformed one', () => {
  const ok = { exit_code: 0, stdout: 'hi', stderr: '', elapsed_ms: 5, timed_out: false }
  expect(validateShellExecResult(ok)).toEqual(ok)
  expect(() => validateShellExecResult({ exit_code: '0', stdout: 'hi', stderr: '', elapsed_ms: 5, timed_out: false })).toThrow(DaemonUnavailable)
  expect(() => validateShellExecResult({})).toThrow(DaemonUnavailable)
})

test('validateParseCheckResult accepts errors as a well-formed array and rejects malformed entries', () => {
  const ok = { ok: false, errors: [{ line: 1, column: 2, message: 'bad' }] }
  expect(validateParseCheckResult(ok)).toEqual(ok)
  expect(() => validateParseCheckResult({ ok: false, errors: [{ line: 1, message: 'missing column' }] })).toThrow(DaemonUnavailable)
  expect(() => validateParseCheckResult({ ok: 'false', errors: [] })).toThrow(DaemonUnavailable)
})

test('validateJvmCheckResult requires a valid severity on every diagnostic', () => {
  const ok = { ok: false, errors: [{ line: 1, column: 2, message: 'bad', severity: 'warning' as const }] }
  expect(validateJvmCheckResult(ok)).toEqual(ok)
  expect(() => validateJvmCheckResult({ ok: false, errors: [{ line: 1, column: 2, message: 'bad', severity: 'fatal' }] })).toThrow(DaemonUnavailable)
})

test('validateDaemonMcpEnsureResult accepts a well-formed result and rejects a malformed tool descriptor', () => {
  const ok = { tools: [{ server: 's', name: 't', description: 'd', inputSchema: { type: 'object' } }], failed: [{ server: 's2', reason: 'boom' }] }
  expect(validateDaemonMcpEnsureResult(ok)).toEqual(ok)
  expect(() => validateDaemonMcpEnsureResult({ tools: [{ server: 's' }], failed: [] })).toThrow(DaemonUnavailable)
  expect(() => validateDaemonMcpEnsureResult({ tools: [], failed: [{ server: 's2' }] })).toThrow(DaemonUnavailable)
})

test('validateDaemonMcpCallResult accepts content/isError and rejects malformed content entries', () => {
  const ok = { content: [{ type: 'text', text: 'hi' }], isError: false }
  expect(validateDaemonMcpCallResult(ok)).toEqual(ok)
  expect(validateDaemonMcpCallResult({})).toEqual({})
  expect(() => validateDaemonMcpCallResult({ content: [{ text: 'missing type' }] })).toThrow(DaemonUnavailable)
  expect(() => validateDaemonMcpCallResult({ isError: 'yes' })).toThrow(DaemonUnavailable)
  expect(() => validateDaemonMcpCallResult(null)).toThrow(DaemonUnavailable)
})
