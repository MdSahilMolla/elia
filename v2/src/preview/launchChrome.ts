import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface LaunchResult {
  browser: 'chrome' | 'default'
  message: string
}

function candidateChromePaths(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env['LocalAppData'] ?? join(homedir(), 'AppData', 'Local')
    return [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

/** Exported so tests can inject a fake existence check instead of touching the real filesystem. */
export function findChromePath(exists: (path: string) => boolean = existsSync): string | undefined {
  return candidateChromePaths().find(exists)
}

function defaultBrowserCommand(url: string): string[] {
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '""', url]
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
    return { browser: 'chrome', message: `Opened ${url} in Chrome` }
  }

  Bun.spawn(defaultBrowserCommand(url), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  return { browser: 'default', message: `Chrome not found — opened ${url} in the system default browser instead` }
}
