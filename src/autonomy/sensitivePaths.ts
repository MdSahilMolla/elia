import { relative, sep } from 'node:path'

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

/**
 * `.env.example` and its kin are the committed, secret-free template a project
 * documents its variables in — reading one is how you learn what `.env` needs.
 * Blocking them stopped a task the user had asked for by name (session
 * mubi8m6o, 29 refusals). Any other `.env.*` stays protected.
 */
const ENV_TEMPLATE_SUFFIX = String.raw`(?:\.[\w-]+)*\.(?:example|sample|template|dist)`
const ENV_TEMPLATE_FILE = new RegExp(String.raw`^\.env${ENV_TEMPLATE_SUFFIX}$`, 'i')

/**
 * Source and style files named `token` are code, not stored tokens: a lexer's
 * `token.ts`, an ERC-20 contract's `token/` folder, a design system's
 * `tokens.css`. The same session was refused `contracts\token\BhumiNFT.sol`.
 * `token`, `token.txt`, `tokens.json` and the like stay protected.
 */
const CODE_EXTENSIONS = 'ts|tsx|js|jsx|mjs|cjs|py|go|rs|sol|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp|css|scss|sass|less|md|html?|vue|svelte|dart|scala|lua|zig'

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  // The Battmann intelligence store: its records reach a model only through the battmann tool, which applies
  // the classification boundary (battmann/modelBoundary.ts). Reading the file directly would bypass it.
  /battmann[^/\\]*\.sqlite(?:-wal|-shm|-journal)?$/i,
  /^(?:credentials?|secrets?|passwords?)(?:\.[^.]+)*$/i,
  new RegExp(String.raw`^tokens?(?!(?:\.[^.]+)*\.(?:${CODE_EXTENSIONS})$)(?:\.[^.]+)*$`, 'i'),
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
]

/**
 * NTFS alternate data streams let `read_file .env::$DATA` open the default
 * stream of a real `.env` file while presenting a segment that matches no
 * sensitive-name rule. On Windows, `:` is never a legal filename character, so
 * it is safe to strip everything from the first colon when classifying a
 * segment. On POSIX `:` is a legal filename character, so the stripping is
 * limited to win32 to avoid over-classifying legitimate files like `.env:1`.
 */
function stripAlternateStreamTail(segment: string): string {
  if (process.platform !== 'win32') return segment
  const colon = segment.indexOf(':')
  if (colon === -1) return segment
  // A bare drive letter segment (`C:`) is not a stream suffix.
  if (colon === 1 && segment.length === 2 && /^[A-Za-z]/.test(segment)) return segment
  return segment.slice(0, colon)
}

/** Returns true when a path names a file or directory that commonly stores secrets. */
export function isSensitivePath(inputPath: string): boolean {
  const normalized = inputPath.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalized.split('/').filter(Boolean).map(stripAlternateStreamTail)
  const lowerSegments = segments.map((segment) => segment.toLocaleLowerCase())
  const lowerPath = lowerSegments.join('/')
  const fileName = lowerSegments.at(-1) ?? ''

  if (lowerSegments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) return true
  // The bare `.config/gcloud` target — without a trailing component — used to
  // slip past both the segment set (it contains a slash, so a single segment
  // can never match) and the `includes('.config/gcloud/')` check below it.
  if (lowerPath === '.config/gcloud' || lowerPath.startsWith('.config/gcloud/')) return true
  if (SENSITIVE_FILE_NAMES.has(fileName)) return true
  if (ENV_TEMPLATE_FILE.test(fileName)) return false
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
const SENSITIVE_PATH_MENTION = new RegExp(
  [
    // `.env` and `.env.*`, but not a template (`.env.example`, `.env.local.sample`).
    String.raw`\.env(?!${ENV_TEMPLATE_SUFFIX}\b)(?:\.[A-Za-z0-9._-]+)?\b`,
    String.raw`\.npmrc\b|\.pypirc\b|\.netrc\b|\.(?:pem|key|p12|pfx)\b|\.git-credentials\b`,
    String.raw`\.aws(?:[\\/]|\b)|\.azure(?:[\\/]|\b)|\.docker(?:[\\/]|\b)|\.kube(?:[\\/]|\b)|\.gnupg(?:[\\/]|\b)|\.config[\\/]gcloud(?:[\\/]|\b)|\.ssh(?:[\\/]|\b)`,
    String.raw`\bid_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?\b`,
    String.raw`\b(?:credentials?|secrets?|passwords?|shadow|passwd|cookies|login data|local state|web data|environ|sudoers|sshd_config)\b`,
    // `token` as a file — not a `token/` folder of code, not `token.ts`.
    String.raw`\btokens?\b(?![\\/]|(?:\.[\w-]+)*\.(?:${CODE_EXTENSIONS})\b)`,
    String.raw`battmann[\w.-]*\.sqlite`,
  ].join('|'),
  'i',
)

/** Conservative shell check for common commands that would disclose protected local files. */
export function commandMayReadSensitiveData(command: string): boolean {
  // `git show`/`git log`/`git diff` read file contents (at a ref, in history,
  // or in a diff) exactly as much as `cat` does — a plan that cannot read
  // `.env` directly can still read it via `git show HEAD:.env`, `git log -p --
  // .env`, or `git diff HEAD~5 -- .env` unless those are recognised here too.
  // Windows cmd.exe's own readers (`type`, `more`, `certutil`, `print`, and the
  // PowerShell Echo-token `TYPE`) must be covered the same way. PowerShell
  // cmdlets (`get-content` + its `gc` alias, `select-string`, `import-csv`,
  // `import-clixml`, `get-filehash`) are listed explicitly because none of
  // them contain a bare `cat`/`type`/`grep` token for the word-boundary test
  // below to trip over.
  if (!/\b(?:cat|type|less|more|head|tail|sed|awk|grep|rg|cut|strings|xxd|od|base64|openssl|certutil|print|source|sqlite3|get-content|select-string|import-csv|import-clixml|get-filehash|gc\b|git\s+(?:show|log|diff)|\.\s*)\b/i.test(command)) return false
  return SENSITIVE_PATH_MENTION.test(command)
}

/** Returns a stable path relative to a trusted root for safe display only. */
export function safeRelativePath(root: string, target: string): string {
  const value = relative(root, target)
  return value === '' ? '.' : value.split(sep).join('/')
}
