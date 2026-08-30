// When a command fails only because a dependency isn't installed, elia should
// just install it and re-run — not stop and report "module not found" as if the
// user could do anything with that. This detects the handful of unambiguous
// "missing package" errors and works out the install command; runCommand.ts
// runs it through the governor (so manual mode still asks, auto mode just does
// it) and retries the original command once.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface MissingPackage {
  manager: 'node' | 'python'
  package: string
}

const NODE_PATTERNS = [
  /Cannot find (?:module|package) ['"]([^'"./][^'"]*)['"]/,
  /Error: Cannot find module ['"]([^'"./][^'"]*)['"]/,
  /Module not found: Error: Can't resolve ['"]([^'"./][^'"]*)['"]/,
  /Cannot find name ['"]([a-z0-9@/_-]+)['"].*install/i,
]

const PYTHON_PATTERNS = [
  /ModuleNotFoundError: No module named ['"]([a-z0-9_-]+)/i,
  /ImportError: No module named ['"]?([a-z0-9_-]+)/i,
]

/** Trims a bare import specifier down to the installable package name (drops subpaths, keeps @scope). */
function packageRoot(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return name ? `${scope}/${name}` : scope!
  }
  return specifier.split('/')[0]!
}

/** Some names are Node built-ins or clearly not npm packages — never try to install those. */
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'crypto', 'stream', 'util', 'events', 'child_process',
  'url', 'net', 'tls', 'zlib', 'buffer', 'assert', 'process', 'readline', 'worker_threads',
])

export function detectMissingPackage(output: string): MissingPackage | undefined {
  for (const pattern of NODE_PATTERNS) {
    const match = pattern.exec(output)
    if (match?.[1]) {
      const pkg = packageRoot(match[1].replace(/^node:/, ''))
      if (!NODE_BUILTINS.has(pkg) && /^[@a-z0-9][a-z0-9._@/-]*$/i.test(pkg)) return { manager: 'node', package: pkg }
    }
  }
  for (const pattern of PYTHON_PATTERNS) {
    const match = pattern.exec(output)
    if (match?.[1]) {
      const pkg = match[1].split('.')[0]!
      if (/^[a-z0-9][a-z0-9._-]*$/i.test(pkg)) return { manager: 'python', package: pkg }
    }
  }
  return undefined
}

/** The install command for a detected missing package, respecting the project's package manager. */
export function installCommandFor(missing: MissingPackage, cwd = process.cwd()): string {
  if (missing.manager === 'python') return `pip install ${missing.package}`
  const bun = existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))
  return bun ? `bun add ${missing.package}` : `npm install ${missing.package}`
}

/** True when the failed command was itself an install — re-installing on top of a broken install is not the fix. */
export function isInstallCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add)\b|\bpip3?\s+install\b|\bpoetry\s+(?:install|add)\b/i.test(command)
}
