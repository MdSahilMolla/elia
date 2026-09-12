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

export function logSwallowedError(scope: string, error: unknown, context?: Record<string, unknown>, path: string = paths.diagnostics): void {
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
