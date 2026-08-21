type Cleanup = () => void

const cleanups = new Set<Cleanup>()
let installed = false
let shuttingDown = false

export function registerShutdownCleanup(cleanup: Cleanup): () => void {
  cleanups.add(cleanup)
  return () => cleanups.delete(cleanup)
}

export function gracefulShutdown(code = 130): never {
  if (!shuttingDown) {
    shuttingDown = true
    for (const cleanup of [...cleanups].reverse()) {
      try {
        cleanup()
      } catch {
        // Terminal cleanup must be best effort; one broken cleanup must not block the rest.
      }
    }
  }
  process.exitCode = code
  process.exit(code)
}

/** Installs signal handlers once. Callers can still register component-specific cleanup. */
export function installShutdownHandlers(): void {
  if (installed) return
  installed = true
  process.once('SIGINT', () => gracefulShutdown(130))
  process.once('SIGTERM', () => gracefulShutdown(143))
  process.once('SIGHUP', () => gracefulShutdown(129))
  process.once('exit', () => {
    for (const cleanup of [...cleanups].reverse()) {
      try {
        cleanup()
      } catch {
        // Best effort during process exit.
      }
    }
  })
}

export function isShuttingDown(): boolean {
  return shuttingDown
}
