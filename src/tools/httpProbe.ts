import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { appendSecureFile } from '../securePersistence.ts'
import { redactArchiveValue, redactSecrets } from '../ui/redact.ts'
import { currentAgent } from '../autonomy/context.ts'
import { engagementDir } from './engagement.ts'
import {
  SESSION_JAR_FILE,
  applySetCookie,
  cookieHeader,
  cookiesForUrl,
  describeCookie,
  normalizeSessionName,
  parseSetCookie,
  pruneExpired,
  readSessionJar,
  sessionJarPath,
  writeSessionJar,
  type StoredCookie,
} from './httpSession.ts'

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const REQUEST_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_SNIPPET = 4_000
/**
 * Redirect hops to follow, matching `web_fetch`. Long enough for the real
 * chains a login or a vanity URL produces (SSO → callback → app), short enough
 * that a loop or a redirect chain longer than any real site terminates instead
 * of walking the engagement's authorization boundary hop by hop.
 */
const MAX_REDIRECTS = 5

/**
 * Strip a trailing IPv6 zone identifier (`%eth0` or the URL-encoded `%25eth0`)
 * from a host token so `fe80::1%eth0` matches a plain `fe80::1` scope entry.
 * Only applied to tokens containing `:` so hostnames with literal `%` are untouched.
 */
export function stripZoneId(token: string): string {
  if (!token.includes(':')) return token
  return token.replace(/%(?:25)?[0-9a-z._-]+$/i, '')
}

const OUT_OF_SCOPE_LABEL = /^(?:out[\s-]*of[\s-]*scope|excluded?|exclusions?|off[\s-]*limits|not\s+(?:in\s+scope|authori[sz]ed)|do\s+not\s+test|forbidden)\b/i
const IN_SCOPE_LABEL = /^(?:in[\s-]*scope|scope|targets?|authori[sz]ed\s+(?:targets?|hosts?|scope|assets?)|rules\s+of\s+engagement|allowed|assets?)\b/i

export interface ScopeHosts {
  include: string[]
  exclude: string[]
}

type ScopeSection = 'in' | 'out' | 'skip'

/** Host/IP/CIDR tokens in one stretch of text. An IPv6 token must really be one, so a word like "face" is not a host. */
function scopeTokens(text: string): string[] {
  const tokens: string[] = []
  const pattern = /\b((?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?|localhost|\[?[0-9a-f:]+\]?(?:\/\d{1,3})?)\b/gi
  for (const match of text.matchAll(pattern)) {
    const before = text[match.index - 1]
    const after = text[match.index + match[0].length]
    // The domain half of an e-mail address is a contact, not a target.
    if (before === '@' || after === '@') continue
    const token = stripZoneId(match[1]!.toLowerCase().replace(/^\[|\]$/g, ''))
    const [addr, bits] = token.split('/')
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(addr!)) {
      // Skip bare version-like or date-like dotted numbers that are not addresses.
      if (isIP(addr!) === 4 && (bits === undefined || Number(bits) <= 32)) tokens.push(token)
      continue
    }
    if (token.includes(':')) {
      if (isIP(addr!) === 6 && (bits === undefined || Number(bits) <= 128)) tokens.push(token)
      continue
    }
    if (/^[0-9a-f]+$/.test(token) && token !== 'localhost') continue
    tokens.push(token)
  }
  return tokens
}

function sectionOf(label: string): ScopeSection {
  const text = label.trim().replace(/[*_`:]/g, '').trim()
  if (OUT_OF_SCOPE_LABEL.test(text)) return 'out'
  if (IN_SCOPE_LABEL.test(text)) return 'in'
  return 'skip'
}

/**
 * Read the authorization out of a SCOPE.md: hosts named in an explicit in-scope
 * section (a heading or label such as "Scope", "Target", "Rules of engagement")
 * and hosts named as out of scope. Hosts under any other heading ("Authorized
 * by", contacts, notes) are not authorization. Text before the first heading or
 * label is read as in scope, and "Out of scope: ..." inside a line is split off.
 */
export function parseScope(scopeText: string): ScopeHosts {
  const include = new Set<string>()
  const exclude = new Set<string>()
  let section: ScopeSection = 'in'
  const take = (kind: ScopeSection, text: string): void => {
    if (kind === 'skip') return
    for (const token of scopeTokens(text)) (kind === 'in' ? include : exclude).add(token)
  }
  for (const rawLine of scopeText.split(/\r?\n/)) {
    let line = rawLine
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/)
    const label = heading ? undefined : line.match(/^\s*(?:[-*+]\s+)?(?:\*\*([^*]+?)\*\*:?|([A-Za-z][A-Za-z -]{1,30}):)\s*(.*)$/)
    if (heading) {
      section = sectionOf(heading[1]!)
      continue
    }
    if (label) {
      const name = label[1] ?? label[2]!
      const known = sectionOf(name)
      if (known !== 'skip' || label[1] !== undefined) {
        section = known
        line = label[3] ?? ''
      }
    }
    // "... Out of scope: a, b" inside one line: the split is the boundary.
    const inline = line.match(/^(.*?)\bout[\s-]*of[\s-]*scope\b\s*[:-]?(.*)$/i)
    if (inline) {
      take(section, inline[1]!)
      take('out', inline[2]!)
      continue
    }
    take(section, line)
  }
  return { include: [...include], exclude: [...exclude] }
}

/** The authorized host tokens of a SCOPE.md, out-of-scope entries removed. */
export function parseScopeHosts(scopeText: string): string[] {
  const { include, exclude } = parseScope(scopeText)
  return include.filter((token) => !exclude.includes(token))
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  const ipInt = ipv4ToInt(ip)
  const rangeInt = ipv4ToInt(range!)
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}

function tokenCovers(host: string, token: string, hostIsIpv4: boolean): boolean {
  if (token === host) return true
  if (token.startsWith('*.') && (host === token.slice(2) || host.endsWith(token.slice(1)))) return true
  // A plain domain token also covers its subdomains.
  if (!token.includes('/') && isIP(token) === 0 && token !== 'localhost' && (host === token || host.endsWith(`.${token}`))) return true
  return hostIsIpv4 && token.includes('/') && ipv4InCidr(host, token)
}

/**
 * Whether a request hostname is covered by an engagement's authorized scope
 * tokens. `excluded` (SCOPE.md's out-of-scope entries) wins over `scopeHosts`.
 */
export function hostInScope(hostname: string, scopeHosts: string[], excluded: string[] = []): boolean {
  const host = stripZoneId(hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''))
  const hostIsIpv4 = isIP(host) === 4
  if (excluded.some((token) => tokenCovers(host, token, hostIsIpv4))) return false
  return scopeHosts.some((token) => tokenCovers(host, token, hostIsIpv4))
}

/**
 * Reads a response body down to a snippet cap and reports whether it was cut
 * short. Reading the whole body (`response.text()`) for a recon capture made a
 * 2 GB download allocate in memory before a single line was returned; this
 * stops after the first chunk that crosses the cap and cancels the stream.
 */
async function readBodySnippet(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: '', truncated: false }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let totalLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      totalLength += chunk.length
      if (output.length < limit) output += chunk.slice(0, limit - output.length)
      if (totalLength > limit) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return { text: output, truncated: totalLength > limit }
}

/**
 * One hop's worth of redirect, or `undefined` when the response is the answer.
 *
 * Same shape as `redirectTarget` in `webFetch.ts`, and for the same reason: the
 * request is issued with `redirect: 'manual'` so that *every* hop comes back
 * through this tool's own scope check. Letting `fetch` follow a redirect would
 * move the second, third, and fifth hop past the authorization check the first
 * one passed — the single worst thing this tool could do, because a target that
 * answers with `Location: https://elsewhere/` would then be reached without
 * ever appearing in SCOPE.md.
 */
function redirectTarget(response: Response, from: URL): URL | undefined {
  if (response.status < 300 || response.status >= 400) return undefined
  const location = response.headers.get('location')
  if (!location) return undefined
  try {
    // Relative Locations are common and legal — a login POST answers with
    // `Location: /dashboard`, and a `Location:` with an empty value is a no-op.
    return new URL(location, from)
  } catch {
    throw new Error(`http_probe failed: redirect to an unparsable location (${location})`)
  }
}

/** Models send booleans as JSON `true`/`false`, as the strings `"true"`/`"false"`, and as `null` for "not set". All three are accepted; anything else is a call error. */
function readBoolean(input: unknown, name: string, fallback: boolean): boolean {
  if (input === undefined || input === null) return fallback
  if (typeof input === 'boolean') return input
  if (typeof input === 'string') {
    const value = input.trim().toLowerCase()
    if (value === 'true') return true
    if (value === 'false') return false
  }
  throw new Error(`${name} must be a boolean`)
}

export const httpProbeTool: Tool = {
  name: 'http_probe',
  description:
    "Send one HTTP request to an in-scope target for an authorized engagement and record the full request/response pair to recon/traffic.jsonl as evidence. The target host must appear in the engagement's SCOPE.md (hostnames, IPs, and IPv4 CIDR ranges are matched) — a request outside scope is refused, and a redirect is re-checked against SCOPE.md on every hop, so a Location pointing off-scope is recorded but never requested. Redirects are followed up to 5 hops (a chain longer than that, or a loop, stops and says so). Cookies persist in recon/session.json: probe the login, then every later probe replays the session, which is what makes IDOR, broken access control, and anything behind a login reachable. Cookie values are never returned or written to the evidence log — only names, attributes, and lengths. Requires new_engagement first.",
  input_schema: {
    type: 'object',
    properties: {
      engagement: { type: 'string', description: 'The engagement slug (from new_engagement)' },
      url: { type: 'string', description: 'Full http(s) URL of the target; its host must be in SCOPE.md' },
      method: { type: 'string', description: 'HTTP method (default GET)' },
      headers: { type: 'object', description: 'Optional request headers as a string map' },
      body: { type: 'string', description: 'Optional request body (max 64 KB)' },
      session: {
        type: 'string',
        description:
          "Name of the cookie session to use, so several auth contexts can coexist (e.g. 'admin', 'user2'). Default 'default'. Each name is a separate set of cookies in recon/session.json",
      },
      useSession: {
        type: 'boolean',
        description: 'Set false to send the request with no cookies and leave the session untouched (default true)',
      },
      clearSession: { type: 'boolean', description: 'Set true to wipe the named session and report what was removed; no request is sent' },
    },
    required: ['engagement', 'url'],
  },
  async execute(input) {
    const slug = typeof input.engagement === 'string' ? input.engagement.trim() : ''
    if (!slug) throw new Error('engagement must be a non-empty string')
    const dir = engagementDir(slug)
    const scopePath = join(dir, 'SCOPE.md')
    if (!existsSync(scopePath)) {
      return `No engagement "${slug}" found (missing ${scopePath}). Run new_engagement first.`
    }

    const rawUrl = typeof input.url === 'string' ? input.url.trim() : ''
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new Error(`Invalid URL: ${rawUrl}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`http_probe only speaks http(s), got ${url.protocol}`)
    if (url.username || url.password) throw new Error('URL must not contain embedded credentials')

    const scopeText = await Bun.file(scopePath).text()
    const { include: scopeHosts, exclude: excludedHosts } = parseScope(scopeText)
    if (!hostInScope(url.hostname, scopeHosts, excludedHosts)) {
      throw new Error(
        `${url.hostname} is not in scope for "${slug}". SCOPE.md authorizes: ${scopeHosts.join(', ') || '(no hosts parsed)'}. Update the engagement scope if this target is genuinely authorized.`,
      )
    }

    const sessionName = normalizeSessionName(input.session)
    const useSession = readBoolean(input.useSession, 'useSession', true)
    const clearSession = readBoolean(input.clearSession, 'clearSession', false)
    const jarPath = sessionJarPath(dir)
    const { jar, corrupt } = readSessionJar(jarPath)
    const notes: string[] = []
    if (corrupt) notes.push(`Session jar: ${corrupt}.`)

    if (clearSession) {
      const removed = jar.sessions[sessionName]?.length ?? 0
      delete jar.sessions[sessionName]
      if (removed > 0) {
        await captureBeforeWrite(jarPath)
        writeSessionJar(jarPath, jar)
      }
      return [
        `Cleared session "${sessionName}" for "${slug}": ${removed} cookie(s) removed from recon/${SESSION_JAR_FILE}.`,
        removed === 0 ? 'Nothing was stored under that name, so the file was left alone.' : 'Other sessions in the jar are untouched.',
        ...notes,
      ].join('\n')
    }

    const method = (typeof input.method === 'string' ? input.method.trim().toUpperCase() : 'GET') || 'GET'
    if (!METHODS.has(method)) throw new Error(`method must be one of ${[...METHODS].join(', ')}`)

    const headers = new Headers()
    if (input.headers !== undefined) {
      if (typeof input.headers !== 'object' || input.headers === null || Array.isArray(input.headers)) throw new Error('headers must be an object')
      for (const [key, value] of Object.entries(input.headers as Record<string, unknown>)) {
        if (typeof value !== 'string') throw new Error(`header "${key}" must be a string`)
        headers.set(key, value)
      }
    }
    let body: string | undefined
    if (input.body !== undefined) {
      if (typeof input.body !== 'string') throw new Error('body must be a string')
      if (Buffer.byteLength(input.body) > MAX_BODY_BYTES) throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`)
      body = input.body
    }

    const startedAt = Date.now()
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(currentAgent().signal ? [currentAgent().signal!] : [])])
    let status = 0 // 0 means the request never produced a response at all
    let responseHeaders: Record<string, string> = {}
    let setCookie: string[] = []
    const rejectedCookies: string[] = []
    let responseSnippet = ''
    let truncated = false
    let error: string | undefined
    let stop: string | undefined
    let blockedRedirect: string | undefined

    // The jar is copied, never written through: one probe reads a snapshot, and
    // every hop merges its own Set-Cookie into that working set.
    let cookies: StoredCookie[] = pruneExpired(jar.sessions[sessionName] ?? [], startedAt)
    let jarChanged = false
    let currentUrl = url
    let currentMethod = method
    let currentBody = body
    const firstHopHeaders = new Headers()
    let sentNames: string[] = []
    let withheld = 0
    const seen = new Set<string>([url.toString()])
    const chain: Array<{ from: string; status: number; location: string; method: string; cookies: string[] }> = []
    let followed = 0
    let finalResponse: Response | undefined

    try {
      for (;;) {
        // Clone per hop: the jar's cookies are matched against *this* URL, so a
        // `/api` cookie is offered to /api/v1 and withheld from /.
        const hopHeaders = new Headers(headers)
        // Explicit beats implicit. A caller-supplied `Cookie` header is the
        // model replaying a captured request, and it must go out byte for byte —
        // merging the jar into it would produce a request it cannot reproduce or
        // reason about. So the caller's header wins outright and the jar's
        // cookies are withheld, which the output says rather than hiding.
        const applicable = useSession ? cookiesForUrl(cookies, currentUrl, startedAt) : []
        const hopNames = applicable.map((cookie) => cookie.name)
        if (hopHeaders.has('cookie')) withheld = applicable.length
        else if (applicable.length > 0) hopHeaders.set('cookie', cookieHeader(applicable))
        if (chain.length === 0 && followed === 0) {
          for (const [key, value] of hopHeaders.entries()) firstHopHeaders.set(key, value)
          sentNames = hopNames
        }

        const response = await fetch(currentUrl, {
          method: currentMethod,
          headers: hopHeaders,
          body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
          redirect: 'manual',
          signal,
        })

        // Read every Set-Cookie before anything else touches the headers.
        // `Object.fromEntries(headers.entries())` keeps only the LAST one, and
        // `headers.get('set-cookie')` comma-joins them into a string whose
        // `Expires=Wed, 01 Oct 2026 …` no parser can split. `getSetCookie()`
        // returns them as an array, which is the only form that keeps a second
        // CSRF cookie from silently vanishing.
        for (const header of response.headers.getSetCookie()) {
          const outcome = parseSetCookie(header, currentUrl, startedAt)
          if (outcome.kind === 'rejected') rejectedCookies.push(outcome.reason)
          else {
            cookies = applySetCookie(cookies, outcome)
            jarChanged = true
            if (outcome.kind === 'store') setCookie.push(describeCookie(outcome.cookie))
          }
        }

        const next = redirectTarget(response, currentUrl)
        if (!next) {
          finalResponse = response
          break
        }
        chain.push({ from: currentUrl.toString(), status: response.status, location: next.toString(), method: currentMethod, cookies: hopNames })
        if (followed >= MAX_REDIRECTS) {
          stop = `Stopped after ${MAX_REDIRECTS} redirects: the target is still answering ${response.status} and wants ${next.toString()}. Request it directly if that path is in scope.`
          finalResponse = response
          break
        }
        if (seen.has(next.toString())) {
          stop = `Redirect loop: ${next.toString()} has already been requested in this chain.`
          finalResponse = response
          break
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          response.body?.cancel().catch(() => undefined)
          throw new Error(`http_probe refused to follow a ${next.protocol} redirect to ${next.toString()}`)
        }
        if (next.username || next.password) {
          response.body?.cancel().catch(() => undefined)
          throw new Error(`http_probe refused to follow a redirect to ${next.toString()}: the URL carries embedded credentials`)
        }
        // Every hop is re-checked against SCOPE.md, not just the first. A target
        // that answers 302 → https://elsewhere/ would otherwise be one redirect
        // away from being reached with an engagement's authorization nowhere in
        // it, and the engagement's cookies riding along.
        if (!hostInScope(next.hostname, scopeHosts)) {
          blockedRedirect = next.toString()
          finalResponse = response
          break
        }
        seen.add(next.toString())
        response.body?.cancel().catch(() => undefined)
        currentUrl = next
        // 303 always downgrades to GET, and so do 301/302 after a POST — which
        // is exactly the shape of a form login answering `Location: /dashboard`.
        // 307/308 keep the method and body, so a replayed request stays a
        // replayed request.
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET'
          currentBody = undefined
        }
        followed += 1
      }
      if (finalResponse) {
        status = finalResponse.status
        responseHeaders = Object.fromEntries(finalResponse.headers.entries())
        const snippet = await readBodySnippet(finalResponse.body, MAX_RESPONSE_SNIPPET)
        responseSnippet = snippet.text
        truncated = snippet.truncated || responseSnippet.length >= MAX_RESPONSE_SNIPPET
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const elapsedMs = Date.now() - startedAt

    const record = {
      ts: new Date(startedAt).toISOString(),
      method,
      url: url.toString(),
      finalUrl: currentUrl.toString(),
      session: sessionName,
      useSession,
      requestHeaders: Object.fromEntries(firstHopHeaders.entries()),
      requestBody: body ?? null,
      status,
      responseHeaders,
      // Every cookie the chain set, described without a single value: which
      // cookies exist and how they are scoped is the evidence, and the value is
      // a live credential that has no business in a transcript.
      setCookie,
      cookieNamesSent: sentNames,
      redirects: chain,
      responseBodySnippet: responseSnippet,
      truncated,
      elapsedMs,
      ...(error ? { error } : {}),
      ...(blockedRedirect ? { blockedRedirect } : {}),
    }
    const trafficPath = join(dir, 'recon', 'traffic.jsonl')
    await captureBeforeWrite(trafficPath)
    // Append-only on an O_APPEND handle rather than read-modify-rewrite: two
    // probes in flight used to race on the read/`Bun.write` pair and the loser
    // silently dropped the other's entry (last writer wins). `appendFileSync`
    // keeps every concurrent record.
    // Key-aware redaction on the parsed record, not on the serialized text:
    // `redactSecrets` is a text pass, and its assignment rule ran to the next
    // whitespace/comma/semicolon — which on JSON means swallowing the value's
    // closing quote, so `set-cookie: JSESSIONID=9F1A; Path=/` wrote
    // `"set-cookie":"[REDACTED]; Path=/; HttpOnly"` and left an unparseable
    // evidence line. `redactArchiveValue` keeps the full multiline body and
    // request payload this archive exists to preserve, which `redactRecord`
    // would flatten and truncate to 160 characters per field.
    const archived = redactArchiveValue(record) as Record<string, unknown>
    // That same key arm blanks any field whose *name* carries a credential
    // keyword, which is right for a `cookie` value and wrong for the parts that
    // hold no secret at all: which cookies the server set and with which
    // attributes (a missing Secure/HttpOnly/SameSite *is* the finding), and which
    // auth context the exchange belongs to. Both are re-attached from summaries
    // that were built without a cookie value in the first place, so restoring
    // them cannot put a credential back on disk.
    archived.setCookie = setCookie.map((line) => redactArchiveValue(line))
    archived.session = sessionName
    appendSecureFile(trafficPath, `${JSON.stringify(archived)}\n`)

    // `useSession: false` means "no cookies at all" — the request went out
    // anonymous and nothing it set is kept, or a probe meant to see the
    // unauthenticated page would quietly arm the next one.
    if (jarChanged && useSession) {
      await captureBeforeWrite(jarPath)
      jar.sessions[sessionName] = pruneExpired(cookies, Date.now())
      writeSessionJar(jarPath, jar)
    }

    if (error) return [`Request failed after ${elapsedMs}ms: ${error}`, ...notes, 'Logged to recon/traffic.jsonl'].join('\n')
    if (blockedRedirect) {
      throw new Error(
        `Refused to follow a redirect from ${currentUrl.hostname} to ${blockedRedirect}: that host is not in scope for "${slug}", so the request was NOT made. ` +
          `SCOPE.md authorizes: ${scopeHosts.join(', ') || '(no hosts parsed)'}. The redirect itself is recorded in recon/traffic.jsonl.`,
      )
    }
    // The labels below are worded to survive the redactor. `redactSecrets` is a
    // text pass over this whole string, and its assignment rule fires on
    // `identifier: value` — so a `Set-Cookie: NAME (…)` heading masked the very
    // cookie name the line exists to report, and `(useSession: false)` read as
    // an assignment and lost half the sentence.
    const sessionLine = !useSession
      ? 'not used, because useSession was set to false — no cookies were sent, and none were kept from this response'
      : withheld > 0
        ? `${withheld} stored cookie(s) withheld — the request supplied its own Cookie header, which wins over the jar; nothing was merged`
        : sentNames.length > 0
          ? `${sentNames.length} cookie(s) sent from recon/${SESSION_JAR_FILE} → ${sentNames.join(', ')}`
          : 'no stored cookies matched this URL'
    return redactSecrets(
      [
        followed > 0
          ? `${method} ${url} → ${status} (${elapsedMs}ms, ${followed} redirect${followed === 1 ? '' : 's'} followed to ${currentUrl})`
          : `${method} ${url} → ${status} (${elapsedMs}ms)`,
        `Session "${sessionName}" → ${sessionLine}`,
        ...(setCookie.length > 0 ? [`Set-Cookie → ${setCookie.join(' | ')}`] : []),
        ...(rejectedCookies.length > 0 ? [`Set-Cookie rejected → ${rejectedCookies.join(' | ')}`] : []),
        ...(stop ? [stop] : []),
        ...notes,
        `Response headers: ${Object.entries(responseHeaders).map(([k, v]) => `${k}: ${v}`).join(' | ') || '(none)'}`,
        '',
        responseSnippet || '(empty body)',
        record.truncated ? `\n… response truncated at ${MAX_RESPONSE_SNIPPET} chars; full entry in recon/traffic.jsonl` : '',
        '',
        'Cite recon/traffic.jsonl as evidence in log_finding.',
      ].join('\n'),
    )
  },
}
