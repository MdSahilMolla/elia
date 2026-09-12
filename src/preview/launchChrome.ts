import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface LaunchResult {
  browser: 'chrome' | 'default'
  message: string
}

/**
 * Chromium-family browsers, in preference order. All of them take
 * `--new-window <url>` identically, so the live-reload preview works in any of
 * them — the point of the list is that a Windows machine very often has Edge
 * (shipped with the OS) but not Chrome, and falling straight through to the
 * system opener there loses the live-reload window for no reason.
 */
function candidateChromePaths(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env['LocalAppData'] ?? join(homedir(), 'AppData', 'Local')
    const roots = [programFiles, programFilesX86, localAppData]
    // Path segments below each root, ending in the executable.
    const relatives: string[][] = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ]
    return relatives.flatMap((segments) => roots.map((root) => join(root, ...segments)))
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ]
}

/** Exported so tests can inject a fake existence check instead of touching the real filesystem. */
export function findChromePath(exists: (path: string) => boolean = existsSync): string | undefined {
  return candidateChromePaths().find(exists)
}

/** A human-readable name for whichever Chromium binary was found, for an honest "opened in X" message. */
export function browserNameForPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.includes('msedge') || lower.includes('edge')) return 'Edge'
  if (lower.includes('brave')) return 'Brave'
  if (lower.includes('chromium')) return 'Chromium'
  return 'Chrome'
}

/** Exported so tests can assert the Windows fallback never shells out through cmd.exe. */
export function defaultBrowserCommand(url: string): string[] {
  // Windows: deliberately NOT `cmd /c start <url>`. `cmd.exe /c` re-parses its
  // trailing argument string for shell metacharacters (&, |, ^, …) independent
  // of how the argv array was quoted — the same vulnerability class as Node's
  // CVE-2024-27980. `url` here can come from the model (src/tools/preview.ts
  // validates only the http(s) scheme, not host/path/query/fragment), so a
  // crafted URL reaching `cmd /c start` could execute an attacker-chosen
  // command. `rundll32 url.dll,FileProtocolHandler` opens a URL in the default
  // browser the same way `start` does, but never invokes cmd.exe, so there is
  // no shell re-parsing step for metacharacters to exploit.
  if (process.platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler', url]
  if (process.platform === 'darwin') return ['open', url]
  return ['xdg-open', url]
}

/**
 * Opens `url` in a real Chrome window when Chrome can be found on this machine,
 * otherwise falls back to the OS's default-browser opener — and always says
 * which one happened, so "opened in Chrome" is never silently a lie.
 */
export async function launchInBrowser(
  url: string,
  exists: (path: string) => boolean = existsSync,
): Promise<LaunchResult> {
  const chromePath = findChromePath(exists)
  if (chromePath) {
    Bun.spawn([chromePath, '--new-window', url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    return { browser: 'chrome', message: `Opened ${url} in ${browserNameForPath(chromePath)}` }
  }

  Bun.spawn(defaultBrowserCommand(url), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  return { browser: 'default', message: `No Chromium browser found — opened ${url} in the system default browser instead (no live-reload)` }
}
