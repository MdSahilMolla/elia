type Cleanup = () => void | Promise<void>

const cleanups = new Set<Cleanup>()
let installed = false
let shuttingDown = false

export function registerShutdownCleanup(cleanup: Cleanup): () => void {
  cleanups.add(cleanup)
  return () => cleanups.delete(cleanup)
}

/** Bounded budget so a hung async cleanup cannot wedge the exit path. */
const SHUTDOWN_CLEANUP_BUDGET_MS = 2_000

export async function gracefulShutdown(code = 130): Promise<never> {
  await runCleanupsOnce()
  process.exitCode = code
  process.exit(code)
}

/** Installs signal handlers once. Callers can still register component-specific cleanup. */
export function installShutdownHandlers(): void {
  if (installed) return
  installed = true
  process.once('SIGINT', () => void gracefulShutdown(130))
  process.once('SIGTERM', () => void gracefulShutdown(143))
  process.once('SIGHUP', () => void gracefulShutdown(129))
  process.once('exit', () => void runCleanupsOnce())
}

async function runCleanupsOnce(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const pending = [...cleanups].reverse()
  cleanups.clear()
  // Async cleanups are awaited before exit so their writes actually land; the
  // budget race keeps a stuck cleanup from wedging shutdown, and the 'exit'
  // handler stays a fire-and-forget safety net for the sync portion.
  const settled = Promise.allSettled(
    pending.map((cleanup) => {
      try {
        return Promise.resolve(cleanup())
      } catch {
        // Terminal cleanup must be best effort; one broken cleanup must not block the rest.
        return Promise.resolve()
      }
    }),
  )
  await Promise.race([settled, Bun.sleep(SHUTDOWN_CLEANUP_BUDGET_MS).then(() => undefined)])
}

export function isShuttingDown(): boolean {
  return shuttingDown
}