/**
 * Client for `elia-index`, the Go workspace-search sidecar (pilot).
 *
 * This client is a thin preferred tier above ripgrep in the grep tool: one
 * short-lived stdio child per search, one NDJSON request line in, one response
 * line out, then stdin closes so the child exits. No daemon lifecycle, no
 * sockets, no resident state.
 *
 * Every transport problem throws {@link GoIndexUnavailable} and the caller
 * falls back to ripgrep and then the pure-JS scan. Nothing here is required
 * for correctness — with `ELIA_GO_INDEX` unset the tool behaves exactly as
 * before.
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../statePaths.ts'
import { readBoundedOutput, terminateProcessGroup } from '../shell.ts'
import { isIgnored } from '../tools/ignoreDirs.ts'
import { isSensitivePath } from '../autonomy/sensitivePaths.ts'
import {
  GO_INVALID_PARAMS,
  GO_PROTOCOL_VERSION,
  type GoIndexQueryParams,
  type GoIndexQueryResult,
  type GoIndexRpcResponse,
} from './types.ts'

export class GoIndexUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoIndexUnavailable'
  }
}

/** `off` (default) — never touch the sidecar. `auto` — use it, fall back on
 * any transport failure. `require` — use it and surface failures (for
 * benchmarking the intended path). */
export type GoIndexMode = 'off' | 'auto' | 'require'

export function goIndexMode(): GoIndexMode {
  const raw = (process.env.ELIA_GO_INDEX ?? 'off').toLowerCase()
  return raw === 'auto' || raw === 'require' ? raw : 'off'
}

export function goIndexEnabled(): boolean {
  return goIndexMode() !== 'off'
}

/** Locate the `elia-index` binary: an explicit override, then the local
 * `just build-go` output. Release-style builds land in the same directory, so
 * newest wins when both exist. */
export function resolveGoIndexPath(): string | undefined {
  const override = process.env.ELIA_GO_INDEX_PATH
  if (override && existsSync(override)) return override
  const base = process.platform === 'win32' ? 'elia-index.exe' : 'elia-index'
  const candidates = [join(ELIA_ROOT, 'go', 'bin', base)]
  let newest: string | undefined
  let newestMs = -1
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(candidate).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs > newestMs) {
      newest = candidate
      newestMs = mtimeMs
    }
  }
  return newest
}

// The sidecar enforces match bounds server-side, so this cap only guards
// against a misbehaving child — it is deliberately larger than the grep
// tool's own output bound.
const GO_INDEX_OUTPUT_BYTES = 8_000_000
const GO_INDEX_TIMEOUT_MS = 20_000

/**
 * Search via the Go sidecar and format identically to the other grep
 * backends. Throws GoIndexUnavailable on any transport problem (caller falls
 * back); an invalid pattern throws a plain error like the JS backend.
 */
export async function searchWithGoIndex(
  pattern: string,
  dir: string,
  inputDir: string,
  globPattern: string | undefined,
  context: number | undefined,
): Promise<string> {
  if (!goIndexEnabled()) throw new GoIndexUnavailable('ELIA_GO_INDEX=off')
  const bin = resolveGoIndexPath()
  if (!bin) throw new GoIndexUnavailable('elia-index binary not found (run just build-go)')
  const params: GoIndexQueryParams = { pattern, dir, context: context ?? 0 }
  if (globPattern) params.glob = globPattern
  const result = await callGoIndex(bin, 'index.query', params)
  return formatGoResult(result, inputDir)
}

async function callGoIndex(bin: string, method: string, params: GoIndexQueryParams): Promise<GoIndexQueryResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([bin], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  } catch (error) {
    throw new GoIndexUnavailable(`elia-index spawn failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const payload = JSON.stringify({ id: 1, method, params }) + '\n'
  if (typeof proc.stdin !== 'object' || !proc.stdin) {
    terminateProcessGroup(proc)
    throw new GoIndexUnavailable('elia-index stdin is not a pipe')
  }
  const stdin = proc.stdin
  try {
    stdin.write(payload)
    stdin.end()
  } catch (error) {
    terminateProcessGroup(proc)
    throw new GoIndexUnavailable(`elia-index write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof proc.stdout !== 'object' || !proc.stdout || typeof proc.stderr !== 'object' || !proc.stderr) {
    terminateProcessGroup(proc)
    throw new GoIndexUnavailable('elia-index stdout/stderr are not pipes')
  }
  const stdout = proc.stdout
  const stderr = proc.stderr
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    terminateProcessGroup(proc)
  }, GO_INDEX_TIMEOUT_MS)
  try {
    const [out, exitCode] = await Promise.all([readBoundedOutput(stdout, GO_INDEX_OUTPUT_BYTES), proc.exited])
    // Drain stderr so a chatty child can never block on a full pipe.
    void readBoundedOutput(stderr, 64_000).catch(() => {})
    if (timedOut) throw new GoIndexUnavailable('elia-index timed out')
    if (exitCode !== 0) throw new GoIndexUnavailable(`elia-index exited with code ${exitCode}`)
    let msg: GoIndexRpcResponse
    try {
      msg = JSON.parse(out.trim()) as GoIndexRpcResponse
    } catch {
      throw new GoIndexUnavailable('elia-index returned malformed JSON')
    }
    if (msg.protocol !== GO_PROTOCOL_VERSION) {
      throw new GoIndexUnavailable(`elia-index protocol ${msg.protocol}, expected ${GO_PROTOCOL_VERSION}`)
    }
    if (msg.error) {
      if (msg.error.code === GO_INVALID_PARAMS) throw new Error(msg.error.message)
      throw new GoIndexUnavailable(`elia-index error ${msg.error.code}: ${msg.error.message}`)
    }
    return msg.result as GoIndexQueryResult
  } finally {
    clearTimeout(timeout)
  }
}

/** Format a sidecar result exactly like searchWithJs, including its suffixes.
 * Backend-agnostic guards (ignore lists, sensitive paths) are re-applied here
 * so a response can never widen the tool contract. */
function formatGoResult(result: GoIndexQueryResult, inputDir: string): string {
  const lines: string[] = []
  for (const m of result.matches ?? []) {
    if (typeof m.rel !== 'string' || typeof m.sep !== 'string') continue
    if (isIgnored(m.rel) || isSensitivePath(m.rel)) continue
    if (m.sep === '--') {
      lines.push('--')
      continue
    }
    if (typeof m.line !== 'number' || typeof m.text !== 'string') continue
    lines.push(`${inputDir}/${m.rel}${m.sep}${m.line}${m.sep}${m.text}`)
  }
  const parts: string[] = []
  if (result.skippedLarge > 0) parts.push(`\n\n[skipped ${result.skippedLarge} file(s) over 5000000 bytes]`)
  if (result.skippedBinary > 0) parts.push(`${parts.length > 0 ? '' : '\n\n'}[skipped ${result.skippedBinary} binary file(s)]`)
  if (lines.length === 0) return `No matches found.${parts.join('')}`
  return `${lines.join('\n')}${parts.join('')}`
}
