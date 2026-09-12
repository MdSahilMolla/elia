import { basename, relative, sep } from 'node:path'

const SENSITIVE_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.config/gcloud',
  '.docker',
  '.kube',
  '.ssh',
  '.gnupg',
])

const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
  'authorized_keys',
  'application_default_credentials.json',
  'dockerconfigjson',
  'cookies',
  'login data',
  'local state',
  'web data',
  'shadow',
  'passwd',
])

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^(?:credentials?|secrets?|tokens?|passwords?)(?:\.[^.]+)*$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
]

/** Returns true when a path names a file or directory that commonly stores secrets. */
export function isSensitivePath(inputPath: string): boolean {
  const normalized = inputPath.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalized.split('/').filter(Boolean)
  const lowerSegments = segments.map((segment) => segment.toLocaleLowerCase())
  const lowerPath = lowerSegments.join('/')
  const fileName = lowerSegments.at(-1) ?? ''

  if (lowerSegments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) return true
  if (lowerPath.includes('.config/gcloud/')) return true
  if (SENSITIVE_FILE_NAMES.has(fileName)) return true
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(fileName))
}

/** Throws before protected file bytes can be opened or returned to the model. */
export function assertSafeFileAccess(path: string): void {
  if (isSensitivePath(path)) throw new Error(`access to protected sensitive path is denied: ${path}`)
}

/**
 * Text naming a file or directory that commonly stores secrets, matched
 * loosely against a whole command line rather than a single path argument.
 * Shared by every "does this command disclose a protected path" check below.
 */
const SENSITIVE_PATH_MENTION =
  /\.env(?:\.[A-Za-z0-9._-]+)?\b|\.npmrc\b|\.pypirc\b|\.netrc\b|\.ssh(?:[\\/]|\b)|\bid_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?\b|\b(?:credentials?|secrets?|tokens?|passwords?|shadow|passwd|cookies|login data|local state|web data)\b/i

/** Conservative shell check for common commands that would disclose protected local files. */
export function commandMayReadSensitiveData(command: string): boolean {
  // `git show`/`git log`/`git diff` read file contents (at a ref, in history,
  // or in a diff) exactly as much as `cat` does — a plan that cannot read
  // `.env` directly can still read it via `git show HEAD:.env`, `git log -p --
  // .env`, or `git diff HEAD~5 -- .env` unless those are recognised here too.
  if (!/\b(?:cat|less|more|head|tail|sed|awk|grep|rg|cut|strings|xxd|od|base64|openssl|source|git\s+(?:show|log|diff)|\.\s*)\b/i.test(command)) return false
  return SENSITIVE_PATH_MENTION.test(command)
}

/** Returns a stable path relative to a trusted root for safe display only. */
export function safeRelativePath(root: string, target: string): string {
  const value = relative(root, target)
  return value === '' ? '.' : value.split(sep).join('/')
}
