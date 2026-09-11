const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|session|private[_-]?key|access[_-]?key|client[_-]?secret|webhook)/i
// Value arms, most specific first:
//  1. a real JWT — three dot-separated base64url segments, header starting
//     `eyJ` (base64 of `{"`). Matched as ONE span so the whole token gets a
//     single [REDACTED], not just the middle payload segment: the base64url
//     alphabet uses `-`/`_` instead of `+`/`/`, which broke the old unbroken-
//     alnum fallback into sub-40-char chunks that slipped through untouched.
//  2. prefixed API keys — the prefix must be followed by its own separator
//     (`sk-`, `sk_`, `rk_`, `re_`). The old arm matched a bare `sk`/`pk`/`rk`
//     and up to 8 following path chars, so `wo|rk|space/edcdemo/src/...`
//     redacted to `wo[REDACTED]` — a repo path, not a secret.
//  3. vendor-prefixed tokens (`ghp_…`, `xoxb-…`, `AKIA…`, `AIza…`)
//  4. a general `<prefix>_<token>` shape for vendor secrets outside the
//     hardcoded list above (e.g. Stripe `whsec_…`) — lowercase prefix so it
//     doesn't start swallowing ordinary CONSTANT_CASE identifiers.
//  5. a `Bearer <token>` header
//  6. an AWS-style secret key: exactly 40 chars from the *full* base64url
//     alphabet (including `/` and `+`), with or without `=` padding. Bounded
//     by lookaround (not `\b`, since `/` and `+` aren't word characters) so a
//     longer surrounding base64 run only matches when it is exactly 40 long.
//  7. a base64 blob that ends in `=`/`==` padding — a filesystem path does not
//  8. a long unbroken base62 run (hex / base62 API tokens), no `/` or `.`
const SECRET_VALUE =
  /(\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|(?:sk|pk|rk|re|ey)[-_][A-Za-z0-9._\-]{8,}|(?:xox[baprs]-|gh[pousr]_|AIza|AKIA|ASIA)[A-Za-z0-9_\-/]{8,}|\b[a-z]{2,10}_[A-Za-z0-9]{16,}\b|Bearer\s+[A-Za-z0-9._\-/+=]{8,}|(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}={0,2}(?![A-Za-z0-9+/])|\b[A-Za-z0-9+/]{16,}={1,2}|\b[A-Za-z0-9]{40,}\b)/g

// `key=value` / `key: value` assignments where the identifier contains a
// credential-like keyword (`SECRET_KEY`, `DATABASE_PASSWORD`, `authToken`, ...).
const SECRET_ASSIGNMENT = new RegExp(
  `(?:^|[^\\w])([A-Za-z0-9_-]*?(?:${SECRET_KEY.source.slice(1, -1)})[A-Za-z0-9_-]*)\\s*[:=]\\s*[^\\s,;]+`,
  'gi',
)

/** Redacts credential-like values without flattening or truncating the surrounding evidence. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_VALUE, '[REDACTED]').replace(SECRET_ASSIGNMENT, '[REDACTED]')
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
  if (key && SECRET_KEY.test(key)) return '[REDACTED]'
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
  if (key && SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactArchiveValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactArchiveValue(item, name)]))
  }
  return value
}
