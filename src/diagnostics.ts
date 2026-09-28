import { appendSecureFile, rotateSecureFile } from './securePersistence.ts'
import { paths } from './statePaths.ts'
import { redactRecord, redactText } from './ui/redact.ts'

/**
 * A place for errors that are handled by degrading gracefully (return
 * `undefined`, skip a malformed line, treat a value as absent) rather than by
 * throwing. Swallowing is often the right behavior — a corrupt session file
 * shouldn't crash the CLI — but swallowing *silently* means a real, recurring
 * failure (a bad upgrade, a flaky daemon, a permissions problem) is invisible
 * until someone notices its symptom days later. This gives every such site a
 * one-line, redacted, append-only record instead, without changing its
 * control flow.
 *
 * Best-effort by design: a failure to log here must never become a new
 * failure for the caller, so every write is wrapped in its own try/catch.
 */

const MAX_LOG_BYTES = 2_000_000

/**
 * Test seam: `ELIA_DIAGNOSTICS_PATH` relocates the log, the way
 * `ELIA_PREAUTH_DIR` relocates the preauth grant store. Resolved per call
 * rather than at module load because `paths.diagnostics` is derived from the cwd
 * captured when `statePaths.ts` was first imported — and under `bun test` another
 * file may have chdir'd into a temp directory by then, which makes that default
 * resolve into a directory a later test deletes. Since every write below is
 * best-effort, a test asserting on the default path would then be asserting on a
 * file nothing was ever written to, and would fail only in a full-suite run.
 */
export function diagnosticsPath(): string {
  return process.env.ELIA_DIAGNOSTICS_PATH ?? paths.diagnostics
}

export function logSwallowedError(scope: string, error: unknown, context?: Record<string, unknown>, path: string = diagnosticsPath()): void {
  try {
    const record = {
      at: new Date().toISOString(),
      scope,
      message: redactText(error instanceof Error ? error.message : String(error), 500),
      ...(context ? { context: redactRecord(context) } : {}),
    }
    rotateSecureFile(path, MAX_LOG_BYTES)
    appendSecureFile(path, `${JSON.stringify(record)}\n`)
  } catch {
    // Logging the swallowed error must never itself throw.
  }
}
