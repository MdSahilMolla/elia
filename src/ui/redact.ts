const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|session|private[_-]?key|access[_-]?key|client[_-]?secret|webhook)/i

/**
 * Cookie and session-credential names, for keys and `name=value` pairs.
 *
 * `SECRET_KEY` above matches `session` anywhere in a key, so `JSESSIONID`
 * trips it — but not `PHPSESSID`, `ASP.NET_SessionId`, or `_sessid`, which is
 * exactly the naming a PHP or ASP.NET target gives the cookie that *is* the
 * login. Those values are bearer credentials for as long as they live, and the
 * one place they must never reach is a recon transcript.
 *
 * The rule is deliberately stricter than a keyword substring, because a
 * substring rule on these words eats ordinary evidence: `author`, `monkey`,
 * `tokenizer`, `residual`, and a browser action map keyed by `refresh` are all
 * things a report has to be able to quote. So a name is sensitive when it is
 * exactly one of these (after `_`, `-`, and `.` are stripped) or when it *ends*
 * in one — which is how vendors attach a prefix (`PHPSESSID`,
 * `github_token`, `oauth`). Ends-in only, and never on a bare three-letter tail,
 * so nothing matches on its last few characters by accident.
 */
const COOKIE_NAMES = new Set([
  'sid',
  'sessid',
  'sessionid',
  'session',
  'connectsid',
  'phpsessid',
  'jsessionid',
  'aspsessionid',
  'aspnetsessionid',
  'cookie',
  'cookies',
  'authcookie',
  'sessioncookie',
  'csrf',
  'csrftoken',
  'xsrf',
  'xsrftoken',
  'auth',
  'authtoken',
  'token',
  'accesstoken',
  'refreshtoken',
  'refresh',
  'credential',
  'credentials',
])
const COOKIE_NAME_SUFFIXES = ['sessid', 'sessionid', 'session', 'cookie', 'csrf', 'xsrf', 'token', 'auth', 'refresh', 'credential', 'sid']

/**
 * Whether a cookie or session-credential name — an object key, or the left half
 * of a `name=value` pair — is one of the shapes above. Exported so the cookie
 * jar and the probe tool ask the same question the redactor does.
 */
export function isCookieName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized.length === 0) return false
  return COOKIE_NAMES.has(normalized) || COOKIE_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

/**
 * Keys whose value is a connection string that usually embeds a password
 * (`DATABASE_URL`, `redisUri`, `sentry_dsn`, `connectionString`). A bare `url`
 * is not here: most URLs are evidence, and `redactSecrets` already strips the
 * credentials out of the ones that carry any.
 */
const CONNECTION_KEY = /(?:dsn|connectionstring|connstr|(?:database|db|redis|mongo|mongodb|postgres|postgresql|mysql|amqp|broker)(?:url|uri))$/

/** Whether an object key names a credential at all, under either rule. */
export function isSensitiveKey(key: string): boolean {
  return SECRET_KEY.test(key) || isCookieName(key) || CONNECTION_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
}

// `scheme://user:password@host` — credentials embedded in a URL or connection string. Matched
// on the authority part only (up to the first `/`, `?` or `#`), through the last `@` in it, so a
// password containing `@` is covered. A bare `user@host` (`ssh://git@github.com`) names no secret
// and is left alone, unless the user part is a long opaque token (`https://<token>@host`).
const URL_CREDENTIALS = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:[^\s/?#@:]*:[^\s/?#]*|[A-Za-z0-9_-]{20,})@/g
// Value arms, most specific first:
//  1. a real JWT — three dot-separated base64url segments, header starting
//     `eyJ` (base64 of `{"`). Matched as ONE span so the whole token gets a
//     single [REDACTED], not just the middle payload segment: the base64url
//     alphabet uses `-`/`_` instead of `+`/`/`, which broke the old unbroken-
//     alnum fallback into sub-40-char chunks that slipped through untouched.
//  2. prefixed API keys — the prefix must be followed by its own separator
//     (`sk-`, `sk_`, `rk_`, `re_`). The old arm matched a bare `sk`/`pk`/`rk`
//     and up to 8 following path chars, so `wo|rk|space/edcdemo/src/...`
//     redacted to `wo[REDACTED]` — a repo path, not a secret. The prefix must
//     also start a token (`\b`): unanchored, `sk_assessment` inside the tool
//     name `risk_assessment` read as a key and printed as `ri[REDACTED]`.
//  3. vendor-prefixed tokens (`ghp_…`, `xoxb-…`, `AKIA…`, `AIza…`)
//  4. a general `<prefix>_<token>` shape for vendor secrets outside the
//     hardcoded list above (e.g. Stripe `whsec_…`) — lowercase prefix so it
//     doesn't start swallowing ordinary CONSTANT_CASE identifiers.
//  5. a `Bearer <token>` header
//  6. a base64 blob that ends in `=`/`==` padding — a filesystem path does not.
//     The padding alone is not enough to call something base64: an assignment
//     written without spaces puts an `=` directly after the identifier, so this
//     arm read `$errorActionPreference='Stop'` as a padded blob and rewrote it
//     to `$[REDACTED]'Stop'`. `isFalseBase64Padding` below settles it on length.
const SECRET_VALUE =
  /(\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|\b(?:sk|pk|rk|re|ey)[-_][A-Za-z0-9._-]{8,}|(?:xox[baprs]-|gh[pousr]_|AIza|AKIA|ASIA)[A-Za-z0-9_\-/]{8,}|\b[a-z]{2,10}_[A-Za-z0-9]{16,}\b|Bearer\s+[A-Za-z0-9._\-/+=]{8,}|\b[A-Za-z0-9+/]{16,}={1,2})/g

// Shapeless opaque runs, checked separately because they carry no prefix to
// vouch for them:
//  - an AWS-style secret key: exactly 40 chars from the *full* base64url
//    alphabet (including `/` and `+`), with or without `=` padding. Bounded by
//    lookaround (not `\b`, since `/` and `+` aren't word characters) so a longer
//    surrounding base64 run only matches when it is exactly 40 long.
//  - a long unbroken base62 run (hex / base62 API tokens), no `/` or `.`
const OPAQUE_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}={0,2}(?![A-Za-z0-9+/])|\b[A-Za-z0-9]{40,}\b/g

/**
 * An opaque run that is evidence, not a credential. Every 40-char run used to
 * be redacted, which blanked out each full git commit SHA in tool output — the
 * very identifier a user needs to follow what happened — along with long
 * digit-free identifiers. A random base62 token of this length contains a
 * digit with overwhelming probability, and a secret in an assignment
 * (`token=…`) is still caught by SECRET_ASSIGNMENT below.
 *
 * 64-char hex stays redacted: it is a SHA-256 digest, but it is also exactly
 * what `openssl rand -hex 32` produces, the usual shape of a generated secret.
 */
function isDigestOrIdentifier(run: string): boolean {
  if (/^[0-9a-f]{40}$/.test(run)) return true
  return !/\d/.test(run)
}

// `key=value` / `key: value` assignments where the identifier contains a
// credential-like keyword (`SECRET_KEY`, `DATABASE_PASSWORD`, `authToken`, ...).
const SECRET_ASSIGNMENT = new RegExp(
  `(?:^|[^\\w])([A-Za-z0-9_-]*?(?:${SECRET_KEY.source.slice(1, -1)})[A-Za-z0-9_-]*)\\s*[:=]\\s*[^\\s,;]+`,
  'gi',
)

/** An identifier the base64-padding arm claimed, e.g. `errorActionPreference=`. */
const PADDED_BASE64 = /^[A-Za-z0-9+/]{16,}={1,2}$/

/**
 * Every `name=value` assignment, with the name kept for `isCookieName` to judge.
 *
 * The pattern is deliberately wider than the rule it feeds: matching the shape
 * and asking about the name in the replacement is what keeps `author=octocat`
 * and `myVeryLongCamelCaseName=2` intact while `PHPSESSID=9F1A` is masked.
 *
 * The leading boundary is a lookbehind, not a consumed character. The earlier
 * assignment arm consumed the delimiter before the identifier, and on a JSON
 * string value that delimiter is the opening quote — which is how
 * `recon/traffic.jsonl` ended up with an unparseable evidence line. A lookbehind
 * cannot eat the quote, so this arm cannot corrupt a record even when it runs
 * over serialized evidence.
 */
const ASSIGNED_TOKEN = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})\s*=\s*[^\s;,}"']+/g

/**
 * Whether a match the padding arm claimed cannot actually be base64.
 *
 * Two things have to hold for it to be an encoding rather than an identifier
 * that happens to be followed by `=`:
 *
 *  - Base64 encodes three bytes to four characters, so a blob that needed `=`
 *    padding is a multiple of four characters long, padding included. That
 *    rules out `errorActionPreference=` (22).
 *  - It contains a digit. Length alone is a coincidence away from wrong —
 *    `myVeryLongCamelCaseName=` is exactly 24 — and encoded random bytes carry
 *    a digit with overwhelming probability at this length, the same reasoning
 *    `isDigestOrIdentifier` above already applies to opaque runs.
 *
 * Seen live, session mubbhz5c-tnp9i0: every PowerShell verification command
 * the model wrote was stored as `$[REDACTED]'Stop'`, so the record of the run
 * no longer showed what had actually been proposed.
 */
function isFalseBase64Padding(match: string): boolean {
  if (!PADDED_BASE64.test(match)) return false
  return match.length % 4 !== 0 || !/\d/.test(match.replace(/=+$/, ''))
}

/** Redacts credential-like values without flattening or truncating the surrounding evidence. */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(SECRET_VALUE, (match) => (isFalseBase64Padding(match) ? match : '[REDACTED]'))
    .replace(OPAQUE_RUN, (run) => (isDigestOrIdentifier(run) ? run : '[REDACTED]'))
    .replace(ASSIGNED_TOKEN, (match, name: string) => (isCookieName(name) ? `${name}=[REDACTED]` : match))
    // An assignment the arm above already emptied is left alone, name included.
    // `SECRET_ASSIGNMENT` replaces the whole `name: value` run, so letting it
    // run second would strip the cookie name off a line whose value is already
    // gone — and which cookie a server set, with which attributes, is the part
    // of that line a finding has to quote.
    .replace(SECRET_ASSIGNMENT, (match) => (match.endsWith('=[REDACTED]') || match.endsWith(':[REDACTED]') ? match : '[REDACTED]'))
}

/**
 * Rewrites an absolute path that sits inside the current project to its
 * repo-relative form, so `C:\…\elia\workspace\edcdemo` (or the POSIX
 * equivalent) reads as `workspace/edcdemo` instead of being partly redacted or
 * truncated into noise. A home directory or any path *outside* the project is
 * left alone for the secret/redaction rules to handle.
 */
export function relativizeProjectPaths(text: string, cwd = process.cwd()): string {
  if (!cwd) return text
  let out = text
  for (const root of new Set([cwd, cwd.replace(/\\/g, '/')])) {
    if (!root) continue
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // `<root>/rest` -> `rest`; a bare `<root>` -> `.`
    out = out
      .replace(new RegExp(`${escaped}[\\\\/]`, 'g'), '')
      .replace(new RegExp(`${escaped}(?![\\w./\\\\-])`, 'g'), '.')
  }
  return out
}

export function redactText(text: string, maxLength = 300): string {
  const localized = relativizeProjectPaths(text)
  const redacted = redactSecrets(localized)
  const flattened = redacted.replace(/\s+/g, ' ').trim()
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactText(value, 160)
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey)]))
  }
  return value
}

export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, redactValue(value, key)]))
}

/** Archive redaction preserves multiline evidence and full non-secret tool arguments. */
export function redactArchiveValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactArchiveValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactArchiveValue(item, name)]))
  }
  return value
}
