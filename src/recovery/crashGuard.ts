import { describeFault, recordFault, type FaultRecord } from './faults.ts'

/**
 * The last line of defence: what happens when an error gets past every handler.
 *
 * Without this, an uncaught exception ended the process with a stack trace on
 * stderr and nothing on disk — the next start had no idea anything had gone
 * wrong, and the same bug could kill the tenth session exactly as it killed the
 * first. Now it is recorded (faults.ts), the person is told what survived and
 * how to pick it up, and the process leaves through the normal shutdown path so
 * the session is saved and the terminal restored.
 *
 * The two kinds are treated differently on purpose. An uncaught exception
 * unwound a stack mid-operation: carrying on risks acting on state that is half
 * updated, so the process stops. An unhandled rejection is a promise nobody was
 * waiting for — the code that made it has already moved on, and the state it
 * could have corrupted is only its own — so it is recorded and the session
 * keeps going, with one warning per distinct bug. Several in a burst means
 * something is looping on failure, and that is treated as a crash.
 */

export interface CrashGuardDeps {
  command: string
  sessionId?: () => string | undefined
  record?: typeof recordFault
  warn?: (text: string) => void
  /**
   * Leaves through the normal shutdown path with this exit code, saying
   * `message` once the terminal is back — a live UI would paint over it before.
   * Without one, the message is only warned.
   */
  exit?: (code: number, message: string) => void
  now?: () => number
}

/** EX_SOFTWARE: an internal software error. */
export const CRASH_EXIT_CODE = 70
/** More unhandled rejections than this inside the window is a loop, not a stray promise. */
const REJECTION_BURST = 20
const REJECTION_WINDOW_MS = 60_000

export interface CrashGuard {
  onUncaughtException(error: unknown): void
  onUnhandledRejection(reason: unknown): void
}

export function createCrashGuard(deps: CrashGuardDeps): CrashGuard {
  const record = deps.record ?? recordFault
  const warn = deps.warn ?? ((text: string) => process.stderr.write(`${text}\n`))
  const now = deps.now ?? Date.now
  const warned = new Set<string>()
  const recent: number[] = []
  let exiting = false

  const context = (source: 'uncaught-exception' | 'unhandled-rejection', fatal: boolean) => {
    const sessionId = deps.sessionId?.()
    return { source, command: deps.command, fatal, ...(sessionId ? { sessionId } : {}) }
  }
  const resumeHint = (): string => {
    // Only a conversation resumes with --resume; a run, the pilot and the rest
    // resume their own way, and elia doctor lists each with its command.
    const sessionId = deps.command === 'repl' ? deps.sessionId?.() : undefined
    return sessionId
      ? `Your conversation up to the last finished turn is saved — elia --resume ${sessionId} picks it up.`
      : 'Work up to the last finished step is saved — elia doctor shows how to pick it up.'
  }
  const stop = (recorded: FaultRecord | undefined, what: string): void => {
    if (exiting) return
    exiting = true
    const message = [
      `elia hit an internal error and has to stop: ${what}`,
      `  ${resumeHint()}`,
      recorded
        ? `  Recorded as ${recorded.signature}; elia doctor shows it, and elia doctor --repair fixes it on a branch.`
        : '  It could not be recorded.',
    ].join('\n')
    if (deps.exit) deps.exit(CRASH_EXIT_CODE, message)
    else warn(message)
  }

  return {
    onUncaughtException(error) {
      const recorded = record(error, context('uncaught-exception', true))
      stop(recorded, recorded ? describeFault(recorded) : String(error))
    },
    onUnhandledRejection(reason) {
      const at = now()
      recent.push(at)
      while (recent.length > 0 && at - recent[0]! > REJECTION_WINDOW_MS) recent.shift()
      const burst = recent.length > REJECTION_BURST
      const recorded = record(reason, context('unhandled-rejection', burst))
      if (burst) {
        stop(recorded, `${recent.length} unhandled promise rejections in a minute — the last: ${recorded ? describeFault(recorded) : String(reason)}`)
        return
      }
      const key = recorded?.signature ?? String(reason)
      if (warned.has(key)) return
      warned.add(key)
      warn(`▸ elia caught an internal error it was not waiting for and carried on: ${recorded ? `${describeFault(recorded)} (recorded as ${recorded.signature})` : String(reason)}`)
    },
  }
}

let installed = false

/**
 * Installs the guard on this process, once. Called by the entry point only —
 * never from a module a test imports, since it changes what an error does to
 * the whole process.
 */
export function installCrashGuard(deps: CrashGuardDeps): void {
  if (installed) return
  installed = true
  const guard = createCrashGuard(deps)
  process.on('uncaughtException', (error) => guard.onUncaughtException(error))
  process.on('unhandledRejection', (reason) => guard.onUnhandledRejection(reason))
}
