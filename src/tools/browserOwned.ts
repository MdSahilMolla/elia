import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { findChromePath } from '../preview/launchChrome.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { terminateProcessGroup } from '../shell.ts'

/**
 * elia's owned headless browser backend — the piece the existing browser.ts
 * bridge chain never had: every other branch (bridge command, browser MCP,
 * `ELIA_BROWSER_CDP_URL`) drives a browser the *user* already has running.
 * This launches and owns one instead, headless, so `browser` works with no
 * external setup at all.
 *
 * Deliberately not a new automation layer: a headless Chromium-family
 * process is launched with its DevTools port open, and browser.ts's
 * existing, already-tested `callCdp` raw-CDP client drives it exactly the
 * way it already drives an externally-supplied `ELIA_BROWSER_CDP_URL` — this
 * module's only job is finding a browser binary and keeping one alive.
 */

export function ownedBrowserRequested(): boolean {
  return (process.env.ELIA_BROWSER ?? '').trim().toLowerCase() === 'owned'
}

const DISABLED = new Set(['off', 'none', 'false', '0', 'no'])

/**
 * Whether `browser` should fall back to elia's own headless browser when no
 * user bridge is configured.
 *
 * It used to require `ELIA_BROWSER=owned`, on the grounds that launching a
 * browser is not something to do as a silent, un-asked-for fallback. In
 * practice that left most sessions with no browser at all: every call failed
 * with "no browser bridge is configured", so elia could not look at the page
 * it had just built, and now that it can read the console and network as well
 * as the DOM, that absence costs far more. And a `browser` call *is* the ask —
 * nothing is launched until the model uses the tool.
 *
 * What made the old concern real is kept in hand: the browser is headless, so
 * no window appears; it is launched on first use, not at startup; it is killed
 * when the session ends; and it has no login state of its own, so it cannot act
 * as the user anywhere. `ELIA_BROWSER=off` turns the fallback off entirely, and
 * with no Chromium-family browser installed it simply reports that, as before.
 */
export function useOwnedBrowserByDefault(env: NodeJS.ProcessEnv = process.env, chromiumAvailable: () => boolean = () => findChromePath() !== undefined): boolean {
  const mode = (env.ELIA_BROWSER ?? '').trim().toLowerCase()
  if (mode === 'owned') return true
  if (DISABLED.has(mode)) return false
  return chromiumAvailable()
}

interface OwnedBrowserInstance {
  proc: Bun.Subprocess
  /** Base HTTP origin of the DevTools endpoint — e.g. http://127.0.0.1:54321 */
  cdpOrigin: string
}

let instance: OwnedBrowserInstance | undefined
let launching: Promise<OwnedBrowserInstance> | undefined
let shutdownRegistered = false

/** A free ephemeral TCP port, found by binding to port 0 and reading back what the OS assigned. Small unavoidable TOCTOU window (another process could grab it before Chrome binds) — standard practice for this kind of local handoff. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('could not determine a free port'))
      })
    })
  })
}

async function waitForCdpReady(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(100)
  }
  throw new Error(`headless browser did not become ready within ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function launchOwnedBrowser(): Promise<OwnedBrowserInstance> {
  const chromePath = findChromePath()
  if (!chromePath) {
    throw new Error('no Chromium-family browser (Chrome, Edge, Brave, or Chromium) was found on this machine — the owned browser backend needs one installed')
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'elia-owned-browser-'))
  const port = await findFreePort()
  const proc = Bun.spawn(
    [
      chromePath,
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      'about:blank',
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
  )
  const cdpOrigin = `http://127.0.0.1:${port}`
  try {
    await waitForCdpReady(cdpOrigin, 15_000)
  } catch (err) {
    terminateProcessGroup(proc)
    throw err
  }
  return { proc, cdpOrigin }
}

/** Resolves the running owned browser's DevTools origin, launching one on first use. Reused across calls within this process; never relaunched while the process is still alive. */
export async function ownedBrowserEndpoint(): Promise<string> {
  if (instance && instance.proc.exitCode === null) return instance.cdpOrigin
  if (!launching) {
    launching = launchOwnedBrowser()
      .then((launched) => {
        instance = launched
        if (!shutdownRegistered) {
          shutdownRegistered = true
          registerShutdownCleanup(() => {
            if (instance) terminateProcessGroup(instance.proc)
          })
        }
        return launched
      })
      .finally(() => {
        launching = undefined
      })
  }
  const launched = await launching
  return launched.cdpOrigin
}

/** Test-only: forces the next call to relaunch instead of reusing a cached instance. */
export function resetOwnedBrowserForTests(): void {
  if (instance) terminateProcessGroup(instance.proc)
  instance = undefined
  launching = undefined
  shutdownRegistered = false
}
