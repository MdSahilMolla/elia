import { existsSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { writeSecureFile } from '../securePersistence.ts'
import { noteCorruptState, parseLocalJson } from '../localJson.ts'
import { isSealedJar, openSealedJar, sealJar, SEALED_JAR_VERSION } from './httpSessionSeal.ts'

/**
 * A persistent cookie jar for `http_probe`, one per engagement.
 *
 * Without state, the strongest class of web finding is unreachable: IDOR, broken
 * access control, and anything behind a login all need the same authenticated
 * request replayed across pages. The jar holds *live bearer credentials* — a
 * `Set-Cookie` value is as good as the password that produced it until it
 * expires — so the rules here are conservative by construction: values are
 * **sealed at rest** (see `httpSessionSeal.ts`) inside an owner-only (`0600`)
 * file, are never rendered into any string the model reads, and are pruned the
 * moment they expire.
 *
 * The file is `recon/session.json` and the location is forced, not chosen:
 * `resolveEvidencePath` in `findings.ts` confines a finding's evidence to the
 * engagement's `recon/` folder, so a jar kept anywhere else could not be cited.
 * That is a deliberate trade — see the note on `readSessionJar` about the copy
 * that is *not* kept.
 */

const JAR_VERSION = SEALED_JAR_VERSION
const MAX_COOKIE_NAME = 256
const MAX_COOKIE_VALUE = 8_192
const MAX_SESSION_NAME = 64
/** Session names become object keys, so they get a charset rather than a length cap alone. */
const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/
/**
 * Names that pass the charset but address `Object.prototype` rather than a
 * key. `jar.sessions['__proto__'] = …` writes no own property at all, so such a
 * session would silently store nothing and read back as empty — a cookie jar
 * that forgets a login with no error is worse than one that refuses the name.
 */
const RESERVED_SESSION_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export const SESSION_JAR_FILE = 'session.json'

export interface StoredCookie {
  name: string
  value: string
  /** Lowercased. The request host for a host-only cookie, the Domain attribute otherwise. */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  /** No `Domain` attribute was sent, so the cookie is pinned to the exact host that set it. */
  hostOnly: boolean
  /** Epoch ms, or `undefined` for a cookie with neither Max-Age nor Expires (kept until cleared). */
  expires?: number
  createdAt: number
}

export interface SessionJar {
  version: number
  sessions: Record<string, StoredCookie[]>
}

/** What a `Set-Cookie` header turned into. A deletion is not a cookie to keep, and a rejected one is neither. */
export type SetCookieOutcome =
  | { kind: 'store'; cookie: StoredCookie }
  | { kind: 'delete'; name: string; domain: string; path: string }
  | { kind: 'rejected'; header: string; reason: string }

export function sessionJarPath(dir: string): string {
  return join(dir, 'recon', SESSION_JAR_FILE)
}

/** Validate a caller-supplied session name; it is a file-shaped object key, so the charset is part of the contract. */
export function normalizeSessionName(input: unknown): string {
  const name = typeof input === 'string' && input.trim().length > 0 ? input.trim() : 'default'
  if (name.length > MAX_SESSION_NAME || !SESSION_NAME.test(name)) {
    throw new Error(`session must be ${MAX_SESSION_NAME} or fewer characters of letters, digits, dot, underscore, or hyphen`)
  }
  if (RESERVED_SESSION_NAMES.has(name.toLowerCase())) throw new Error(`session name "${name}" is reserved`)
  return name
}

function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function emptyJar(): SessionJar {
  return { version: JAR_VERSION, sessions: {} }
}

function isStoredCookie(value: unknown): value is StoredCookie {
  if (!value || typeof value !== 'object') return false
  const cookie = value as Partial<StoredCookie>
  if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return false
  if (typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') return false
  if (typeof cookie.sameSite !== 'string') return false
  if (typeof cookie.secure !== 'boolean' || typeof cookie.httpOnly !== 'boolean' || typeof cookie.hostOnly !== 'boolean') return false
  if (typeof cookie.createdAt !== 'number' || !Number.isFinite(cookie.createdAt)) return false
  if (cookie.expires !== undefined && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))) return false
  return true
}

/** `undefined` when the file parsed but is not a jar at all — a different failure from an empty one. */
function parseJar(parsed: unknown): SessionJar | undefined {
  const candidate = parsed as Partial<SessionJar> | null
  if (!candidate || typeof candidate !== 'object' || candidate.version !== JAR_VERSION) return undefined
  const raw = candidate.sessions
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const sessions: Record<string, StoredCookie[]> = {}
  for (const [name, cookies] of Object.entries(raw)) {
    if (!Array.isArray(cookies)) continue
    // A cookie that lost a required field in an older or hand-edited file is
    // dropped rather than sent: half a cookie is a malformed request header.
    sessions[name] = cookies.filter(isStoredCookie)
  }
  return { version: JAR_VERSION, sessions }
}

/**
 * Read the jar. A missing file is an empty jar; a file that is not a jar starts
 * empty *and says so*, because a session that silently resets looks exactly
 * like a login that "did not work" and the operator would re-probe forever.
 * `noteCorruptState` is the repo's precedent for degrading out of a corrupt
 * local file (#1270) — with one deliberate difference: the bad bytes are not
 * kept beside the jar. They are the credential store, `copyFileSync` would give
 * the copy the default umask rather than `0600`, and the next write replaces the
 * file anyway.
 */
export function readSessionJar(path: string): { jar: SessionJar; corrupt?: string } {
  if (!existsSync(path)) return { jar: emptyJar() }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    noteCorruptState('httpProbe.sessionJar', path, error)
    return { jar: emptyJar(), corrupt: `${path} could not be read (${reason}); this probe starts from an empty session` }
  }
  let parsed: unknown
  try {
    parsed = parseLocalJson(raw, path)
  } catch (error) {
    noteCorruptState('httpProbe.sessionJar', path, error)
    const reason = error instanceof Error ? error.message : String(error)
    return { jar: emptyJar(), corrupt: `${path} is not readable JSON (${reason}); this probe starts from an empty session` }
  }
  // Version 2: the values are sealed, so the bytes on disk are ciphertext and
  // `parseJar` would reject them as not-a-jar. Open the seal first, then parse
  // the plaintext jar out of it. A jar that fails its auth tag is reported the
  // same way a corrupt one is: empty, and saying so, because a session that
  // silently resets looks exactly like a login that did not work.
  if (isSealedJar(parsed)) {
    const plaintext = openSealedJar(parsed, path)
    if (plaintext === undefined) {
      return { jar: emptyJar(), corrupt: `${path} is sealed but did not authenticate — the jar was moved, copied to another project, or edited; this probe starts from an empty session` }
    }
    let inner: unknown
    try {
      inner = parseLocalJson(plaintext, path)
    } catch (error) {
      noteCorruptState('httpProbe.sessionJar', path, error)
      return { jar: emptyJar(), corrupt: `${path} decrypted to something that is not JSON; this probe starts from an empty session` }
    }
    const jar = parseJar(inner)
    if (!jar) return { jar: emptyJar(), corrupt: `${path} decrypted to something that is not a session jar; this probe starts from an empty session` }
    return { jar }
  }

  const jar = parseJar(parsed)
  if (!jar) return { jar: emptyJar(), corrupt: `${path} is not a session jar; this probe starts from an empty session` }
  return { jar }
}

/**
 * Replace the whole jar, atomically and owner-readable. Not `appendSecureFile`:
 * that is for the append-only evidence log, and the jar is a keyed map every
 * probe rewrites. `writeSecureFile` is the secure-persistence helper that gives
 * it `0600` — this file is a credential store and must never take the default
 * umask the way a plain `Bun.write` would.
 */
export function writeSessionJar(path: string, jar: SessionJar): void {
  writeSecureFile(path, sealJar(JSON.stringify(jar, null, 2), path))
}

/** RFC 6265 §5.1.3 — a Domain attribute only covers the setting host and its subdomains, never an IP literal. */
function domainMatches(hostname: string, domain: string): boolean {
  const host = canonicalHost(hostname)
  const target = canonicalHost(domain)
  if (target.length === 0) return false
  if (target === host) return true
  // `Domain=1.2.3.4` on a request to 1.2.3.4 is a host-only cookie in every
  // browser, and letting the suffix rule through would let a host plant a
  // cookie for a sibling it does not control.
  if (isIP(target) !== 0) return false
  return host.endsWith(`.${target}`)
}

/** RFC 6265 §5.1.4 — `/api` matches `/api` and `/api/v1` but not `/` or `/apix`. */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  if (cookiePath.endsWith('/')) return true
  return requestPath.charAt(cookiePath.length) === '/'
}

/** RFC 6265 §5.1.4 default-path: everything up to but not including the last `/`. */
function defaultCookiePath(url: URL): string {
  const pathname = url.pathname
  if (!pathname.startsWith('/')) return '/'
  const lastSlash = pathname.lastIndexOf('/')
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash)
}

/**
 * Parse one `Set-Cookie` header into a stored cookie.
 *
 * Attribute handling is the part that has to be right or an auth context
 * silently breaks: `Max-Age` outranks `Expires` (RFC 6265 §5.2.2) and a
 * `Max-Age` of zero or less is a deletion, not a cookie; a `Domain` that does
 * not match the host that set it is rejected rather than widened; a `Path` that
 * is not absolute falls back to the default path.
 */
export function parseSetCookie(header: string, url: URL, now: number): SetCookieOutcome {
  const reject = (reason: string): SetCookieOutcome => ({ kind: 'rejected', header, reason })
  const segments = header.split(';')
  const pair = (segments.shift() ?? '').trim()
  const equals = pair.indexOf('=')
  if (equals <= 0) return reject('no name=value pair')
  const name = pair.slice(0, equals).trim()
  const value = pair.slice(equals + 1).trim()
  if (name.length === 0 || name.length > MAX_COOKIE_NAME) return reject(`cookie name is empty or over ${MAX_COOKIE_NAME} characters`)
  if (value.length > MAX_COOKIE_VALUE) return reject(`cookie value is over ${MAX_COOKIE_VALUE} characters`)

  let domain: string | undefined
  let path: string | undefined
  let secure = false
  let httpOnly = false
  let sameSite = 'unspecified'
  let maxAge: number | undefined
  let expires: number | undefined
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (trimmed.length === 0) continue
    const at = trimmed.indexOf('=')
    const key = (at === -1 ? trimmed : trimmed.slice(0, at)).trim().toLowerCase()
    const attribute = at === -1 ? '' : trimmed.slice(at + 1).trim()
    switch (key) {
      case 'domain':
        if (attribute.length > 0) domain = canonicalHost(attribute.replace(/^\.+/, ''))
        break
      case 'path':
        if (attribute.startsWith('/')) path = attribute
        break
      case 'secure':
        secure = true
        break
      case 'httponly':
        httpOnly = true
        break
      case 'samesite':
        sameSite = attribute.length > 0 ? `${attribute[0]!.toUpperCase()}${attribute.slice(1).toLowerCase()}` : 'unspecified'
        break
      case 'max-age':
        if (/^-?\d+$/.test(attribute)) maxAge = Number(attribute)
        break
      case 'expires': {
        const parsed = Date.parse(attribute)
        if (Number.isFinite(parsed)) expires = parsed
        break
      }
    }
  }

  const resolvedDomain = domain ?? canonicalHost(url.hostname)
  const resolvedPath = path ?? defaultCookiePath(url)
  if (domain !== undefined && !domainMatches(url.hostname, domain)) {
    return reject(`Domain=${domain} does not match the host that set it (${url.hostname})`)
  }
  if (maxAge !== undefined && maxAge <= 0) return { kind: 'delete', name, domain: resolvedDomain, path: resolvedPath }
  if (maxAge === undefined && expires !== undefined && expires <= now) return { kind: 'delete', name, domain: resolvedDomain, path: resolvedPath }

  const cookie: StoredCookie = {
    name,
    value,
    domain: resolvedDomain,
    path: resolvedPath,
    secure,
    httpOnly,
    sameSite,
    hostOnly: domain === undefined,
    createdAt: now,
  }
  if (maxAge !== undefined) cookie.expires = now + maxAge * 1000
  else if (expires !== undefined) cookie.expires = expires
  return { kind: 'store', cookie }
}

/** Whether a stored cookie is live and applicable to `url` right now. */
export function cookieApplies(cookie: StoredCookie, url: URL, now: number): boolean {
  if (cookie.expires !== undefined && cookie.expires <= now) return false
  if (cookie.secure && url.protocol !== 'https:') return false
  if (cookie.hostOnly) {
    if (canonicalHost(url.hostname) !== canonicalHost(cookie.domain)) return false
  } else if (!domainMatches(url.hostname, cookie.domain)) {
    return false
  }
  return pathMatches(cookie.path, url.pathname)
}

/** Live cookies for `url`, most specific path first — the order a server sees them in. */
export function cookiesForUrl(cookies: StoredCookie[], url: URL, now: number): StoredCookie[] {
  return cookies.filter((cookie) => cookieApplies(cookie, url, now)).sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
}

/** The `Cookie` request header for a set of cookies. The only place a value is ever concatenated back together. */
export function cookieHeader(cookies: StoredCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

/**
 * Apply one `Set-Cookie` outcome. Cookies are identified by (name, domain, path)
 * — the same triple RFC 6265 uses — so a re-set replaces rather than duplicates.
 */
export function applySetCookie(cookies: StoredCookie[], outcome: SetCookieOutcome): StoredCookie[] {
  if (outcome.kind === 'rejected') return cookies
  const target = outcome.kind === 'store' ? outcome.cookie : outcome
  const kept = cookies.filter(
    (cookie) => !(cookie.name === target.name && canonicalHost(cookie.domain) === canonicalHost(target.domain) && cookie.path === target.path),
  )
  return outcome.kind === 'delete' ? kept : [...kept, outcome.cookie]
}

/** Drop cookies that have expired, so the file does not accumulate dead credentials. */
export function pruneExpired(cookies: StoredCookie[], now: number): StoredCookie[] {
  return cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now)
}

/**
 * A cookie rendered for a human or a model: the name, the attributes that decide
 * whether the session is defensible, and the *length* of the value — never the
 * value. A missing `Secure`, `HttpOnly`, or `SameSite` here is the finding; the
 * value itself is a live credential and has no business in a transcript.
 */
export function describeCookie(cookie: StoredCookie): string {
  const attributes = [
    `value [REDACTED], ${cookie.value.length} characters`,
    `Path=${cookie.path}`,
    cookie.hostOnly ? `host-only ${cookie.domain}` : `Domain=${cookie.domain}`,
    ...(cookie.secure ? ['Secure'] : []),
    ...(cookie.httpOnly ? ['HttpOnly'] : []),
    `SameSite=${cookie.sameSite}`,
    cookie.expires === undefined ? 'session cookie' : `expires ${new Date(cookie.expires).toISOString()}`,
  ]
  return `${cookie.name} (${attributes.join(', ')})`
}
