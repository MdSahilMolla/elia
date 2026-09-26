import { copyFileSync } from 'node:fs'
import { logSwallowedError } from './diagnostics.ts'

/**
 * Local state files that turn out not to be what they should be.
 *
 * elia keeps its state in JSON files it wrote itself, and most loaders already
 * degrade rather than crash when one is corrupt: an unreadable allow list is
 * treated as empty, a torn checkpoint as missing. What they did not do is say
 * so (#1270). A person whose allow rules silently stopped applying has no way
 * to find out why, and the next write erases the evidence. So a loader that
 * degrades also notes it, with the path and the parser's reason, and can keep
 * the bad file beside itself as `<file>.corrupt`.
 *
 * Where degrading would be wrong, `parseLocalJson` throws an error that names
 * the file instead of the bare `SyntaxError` a raw `JSON.parse` gives.
 */

export class CorruptStateError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path} could not be read: ${reason}`)
    this.name = 'CorruptStateError'
  }
}

/** `JSON.parse`, with a failure that says which file and why. */
export function parseLocalJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new CorruptStateError(path, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Records a local state file that could not be read, where the caller degrades
 * instead of failing. Never throws.
 */
export function noteCorruptState(scope: string, path: string, error: unknown, options: { keepCopy?: boolean; diagnosticsPath?: string } = {}): void {
  logSwallowedError(scope, error, { path, ...(options.keepCopy ? { keptAs: `${path}.corrupt` } : {}) }, ...(options.diagnosticsPath ? [options.diagnosticsPath] : []))
  if (!options.keepCopy) return
  try {
    copyFileSync(path, `${path}.corrupt`)
  } catch {
    // Keeping the copy is a courtesy; the log line above already says what happened.
  }
}
