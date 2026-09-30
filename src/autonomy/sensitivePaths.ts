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
  // Elia's per-user HMAC key, which signs pre-authorizations. A model that
  // reads this can mint its own standing approvals. A write to it is refused
  // here as a sensitive path AND gated at the governor layer
  // (TRUST_CONTROL_INTENT).
  /^preauth\.secret$/i,
]

/**
 * Elia's own trust surface: `policy.json` (governance policy), `allow.json`
 * (standing approvals), `preauth.json` + `preauth.secret` (pre-authorizations
 * and their HMAC key) under a `.elia/` directory, plus anything under the
 * per-user `~/.config/elia` home those stores relocated to. Also the files a
 * later run EXECUTES or is steered by without asking again: lifecycle hooks,
 * scheduled tasks, the autopilot's saved backlog, and a durable run's own state
 * (`.elia/runs/<id>/goal-graph.json`, `events.ndjson`, `plan.md`, `checkpoints/`) —
 * the loop writes those itself, in-process, never through a governed tool, so
 * any model write to them is an attempt to edit its own run record. Matched by PATH
 * rather than bare file name, because `policy.json`/`allow.json` are ordinary
 * project config names elsewhere and must not be swept up.
 */
const ELIA_TRUST_FILE = /(?:^|\/)\.elia\/(?:policy|allow)\.json$|(?:^|\/)\.elia\/preauth\.(?:json|secret)$|(?:^|\/)\.elia\/(?:lifecycle-hooks|schedules)\.json$|(?:^|\/)\.elia\/autopilot\/state\.json$|(?:^|\/)\.elia\/runs\/[^/]+\/(?:goal-graph\.json[^/]*|events\.ndjson|plan\.md|checkpoints(?:\/.*)?)$/
const ELIA_TRUST_HOME = /(?:^|\/)\.config\/elia(?:\/|$)/

/** True when a path names one of elia's own trust-control files. */
export function isEliaTrustFile(inputPath: string): boolean {
  const norm = inputPath.replaceAll('\\', '/').toLocaleLowerCase()
  return ELIA_TRUST_FILE.test(norm) || ELIA_TRUST_HOME.test(norm)
}

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

/** Elia's own trust surface as it is named in text (a shell line, model-written code). */
export const ELIA_TRUST_MENTION: readonly string[] = [
  String.raw`\.elia[\\/](?:policy|allow|preauth)\.(?:json|secret)\b`,
  String.raw`\.config[\\/]elia(?:[\\/]|\b)`,
  String.raw`preauth\.secret\b`,
  String.raw`\.elia[\\/]runs[\\/][^\s'"]*?(?:goal-graph\.json|events\.ndjson|plan\.md|checkpoints)\b`,
]

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
    // Elia's own trust surface. A shell command carries no resolved path and
    // can hide one behind `~`, a glob, or a `cd`, so the trust files are
    // matched as text here: `cat ~/.config/elia/allow.json` would otherwise
    // ride the read-only shell policy and hand the model its own governor
    // inputs (and `preauth.secret`, the key that signs them).
    ...ELIA_TRUST_MENTION,
  ].join('|'),
  'i',
)

/**
 * The text a shell would act on once it has removed quotes and backslash
 * escapes: `.e''nv`, `.e"n"v` and `.e\nv` all name `.env`. The guards below
 * match text, so they must see this form as well as the raw one.
 */
export function unquoteShellText(command: string): string {
  return command.replace(/['"\\]/g, '')
}

/**
 * Concrete protected paths a shell glob could expand to. Each entry is a run
 * of path segments; a command token is expanded segment by segment against
 * them (`.e?v`, `.e[n]v`, `~/.config/eli?/preauth.secr?t`, `.c?nfig/elia`).
 */
const GLOB_TARGETS: readonly (readonly string[])[] = [
  ...['.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.aws', '.azure', '.docker', '.kube', '.gnupg', '.ssh',
    'preauth.secret', 'credentials', 'credentials.json', 'secret', 'secrets', 'password', 'passwords', 'shadow', 'passwd',
    'cookies', 'environ', 'sudoers', 'sshd_config', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'token', 'tokens'].map((name) => [name]),
  ['.config', 'gcloud'],
  ['.config', 'elia'],
  ['.config', 'elia', 'allow.json'],
  ['.config', 'elia', 'policy.json'],
  ['.config', 'elia', 'preauth.secret'],
  ['.elia', 'allow.json'],
  ['.elia', 'policy.json'],
  ['.elia', 'preauth.json'],
  ['.elia', 'preauth.secret'],
]

const GLOB_CHARS = /[?*[]/

/** One shell glob segment as a regex (`?`, `*`, `[...]`); other characters are literal. */
function globSegmentRegex(segment: string): RegExp | undefined {
  let source = ''
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!
    if (char === '?') source += '.'
    else if (char === '*') source += '.*'
    else if (char === '[') {
      const close = segment.indexOf(']', index + 2)
      if (close === -1) source += '\\['
      else {
        const body = segment.slice(index + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')
        source += `[${body}]`
        index = close
      }
    } else source += char.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  try {
    return new RegExp(`^${source}$`, 'i')
  } catch {
    return undefined
  }
}

/**
 * True when a glob segment could stand for the concrete name. A glob that opens
 * with a wildcard never matches a dotfile (the shell skips them), and a bare
 * `*` or `*.ext` is an ordinary "all files" / "all of one type" word — not read
 * as a probe for `credentials` or `allow.json` when it is the whole token.
 */
function globSegmentMatches(glob: string, name: string, whole: boolean): boolean {
  if (!GLOB_CHARS.test(glob)) return glob.toLowerCase() === name.toLowerCase()
  if (/^[?*[]/.test(glob) && name.startsWith('.')) return false
  if (whole && /^\*(?:\.[A-Za-z0-9]+)?$/.test(glob)) return false
  return globSegmentRegex(glob)?.test(name) ?? false
}

/** True when a token with glob characters can expand to a protected path. */
function globMayNameSensitivePath(token: string): boolean {
  const segments = token.split(/[\\/]+/).filter(Boolean)
  return GLOB_TARGETS.some((target) => {
    for (let start = 0; start + target.length <= segments.length; start += 1) {
      const window = segments.slice(start, start + target.length)
      if (!window.some((segment) => GLOB_CHARS.test(segment))) continue
      const whole = segments.length === 1 && target.length === 1
      if (window.every((segment, index) => globSegmentMatches(segment, target[index]!, whole))) return true
    }
    return false
  })
}

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
  // The shell removes quotes and escapes and expands globs before the reader
  // runs, so the text is judged raw, unquoted, and glob-expanded.
  const unquoted = unquoteShellText(command)
  if (!/\b(?:cat|type|less|more|head|tail|sed|awk|grep|rg|cut|strings|xxd|od|base64|openssl|certutil|print|source|sqlite3|get-content|select-string|import-csv|import-clixml|get-filehash|gc\b|git\s+(?:show|log|diff)|\.\s*)\b/i.test(unquoted)) return false
  if (SENSITIVE_PATH_MENTION.test(command) || SENSITIVE_PATH_MENTION.test(unquoted)) return true
  return unquoted.split(/[\s;|&<>()=:,]+/).some((token) => GLOB_CHARS.test(token) && globMayNameSensitivePath(token))
}

/** Returns a stable path relative to a trusted root for safe display only. */
export function safeRelativePath(root: string, target: string): string {
  const value = relative(root, target)
  return value === '' ? '.' : value.split(sep).join('/')
}
