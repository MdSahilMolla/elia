import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

export interface NetworkUrlOptions {
  allowExplicitLocal?: boolean
  requireHttps?: boolean
}

const LOCALHOST_NAMES = new Set(['localhost', 'localhost.'])

/** True for loopback-only hostnames — localhost, *.localhost, 127.0.0.1, ::1. */
export function isExplicitLocalHostname(hostname: string): boolean {
  return isExplicitLocalHost(hostname)
}

/** Parse and validate a network URL without performing any request. */
export function validateNetworkUrl(raw: string, options: NetworkUrlOptions = {}): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid network URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Refusing non-http(s) network URL: ${raw}`)
  if (url.username || url.password) throw new Error('Network URLs must not contain embedded credentials')

  const explicitLocal = isExplicitLocalHost(url.hostname)
  if (options.requireHttps && url.protocol !== 'https:' && !(options.allowExplicitLocal && explicitLocal)) {
    throw new Error(`Refusing insecure network endpoint: ${url.origin}`)
  }
  if (!options.allowExplicitLocal && isUnsafeHostname(url.hostname)) {
    throw new Error(`Refusing private or local network target: ${url.hostname}`)
  }
  if (options.allowExplicitLocal && isUnsafeHostname(url.hostname) && !explicitLocal) {
    throw new Error(`Refusing private or local network target: ${url.hostname}`)
  }
  return url
}

/** Validate a public HTTP(S) target and resolve all DNS answers before a request. */
export async function assertPublicNetworkUrl(raw: string | URL, options: NetworkUrlOptions = {}): Promise<URL> {
  const url = validateNetworkUrl(String(raw), options)
  const explicitLocal = isExplicitLocalHost(url.hostname)
  if (explicitLocal && options.allowExplicitLocal) return url
  if (isUnsafeAddress(url.hostname)) throw new Error(`Refusing private or local network target: ${url.hostname}`)
  if (isIpLiteral(url.hostname)) return url

  let answers: { address: string }[]
  try {
    answers = await lookup(url.hostname, { all: true, verbatim: true })
  } catch {
    throw new Error(`Unable to resolve network host safely: ${url.hostname}`)
  }
  if (answers.length === 0 || answers.some((answer) => isUnsafeAddress(answer.address))) {
    throw new Error(`Refusing network host that resolves to a private or local address: ${url.hostname}`)
  }
  return url
}

type LookupAnswer = { address: string; family: number }
type Resolver = (hostname: string) => Promise<LookupAnswer[]>

const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true })

/**
 * A `net` lookup that validates the very answers the socket will connect to.
 *
 * `assertPublicNetworkUrl` alone is a check-then-use: it resolves, approves,
 * and then `fetch(url)` resolves the name again at connect time, so a DNS
 * server that answers "public" to the first query and "169.254.169.254" to
 * the second walks straight past it (DNS rebinding). Doing the resolution and
 * the validation inside the connection's own lookup closes that window — there
 * is no second resolution for an attacker to answer differently.
 */
export function publicAddressLookup(options: NetworkUrlOptions = {}, resolve: Resolver = systemResolver): LookupFunction {
  return ((hostname: string, lookupOptions: { family?: number | string; all?: boolean }, callback: (...args: unknown[]) => void) => {
    const allowLocal = options.allowExplicitLocal === true && isExplicitLocalHost(hostname)
    resolve(hostname)
      .then((answers: LookupAnswer[]) => {
        const family = lookupOptions?.family === 'IPv4' ? 4 : lookupOptions?.family === 'IPv6' ? 6 : Number(lookupOptions?.family) || 0
        const usable = family ? answers.filter((answer) => answer.family === family) : answers
        if (usable.length === 0 || (!allowLocal && usable.some((answer) => isUnsafeAddress(answer.address)))) {
          throw new Error(`Refusing network host that resolves to a private or local address: ${hostname}`)
        }
        if (lookupOptions?.all) callback(null, usable)
        else callback(null, usable[0]!.address, usable[0]!.family)
      })
      .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))))
  }) as unknown as LookupFunction
}

export interface PublicFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  policy?: NetworkUrlOptions
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

/**
 * Test seam: when set, `publicFetch` hands the (already policy-checked) request
 * here instead of opening a socket, so tool tests can stub responses the way
 * they used to stub `globalThis.fetch`. Never set outside tests.
 */
export const publicFetchTestHooks: { transport?: (url: URL, init: PublicFetchInit) => Promise<Response> } = {}

/**
 * `fetch` for a URL an untrusted party chose, with the DNS answer pinned to
 * the one that passed the public-address policy (see `publicAddressLookup`).
 *
 * Built on node:http(s) because `fetch` has no per-request DNS hook; the
 * request still goes to the original hostname, so Host, SNI and certificate
 * verification are all unchanged. Redirects are never followed — a 3xx comes
 * back as-is for the caller to refuse or re-validate.
 */
export async function publicFetch(raw: string | URL, init: PublicFetchInit = {}): Promise<Response> {
  const url = await assertPublicNetworkUrl(raw, init.policy)
  if (publicFetchTestHooks.transport) return publicFetchTestHooks.transport(url, init)
  const transport = url.protocol === 'https:' ? https : http
  return new Promise<Response>((resolve, reject) => {
    const req = transport.request(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      lookup: publicAddressLookup(init.policy),
      signal: init.signal,
    }, (res) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item)
        else if (value !== undefined) headers.set(name, value)
      }
      const status = res.statusCode ?? 502
      if (NULL_BODY_STATUSES.has(status)) {
        res.resume()
        resolve(new Response(null, { status, statusText: res.statusMessage, headers }))
        return
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
          res.on('end', () => controller.close())
          res.on('error', (error) => controller.error(error))
        },
        cancel() {
          res.destroy()
        },
      })
      resolve(new Response(body, { status, statusText: res.statusMessage, headers }))
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/** Custom provider endpoints must use TLS; only an explicitly enabled localhost endpoint may use HTTP. */
export async function assertProviderEndpoint(raw: string): Promise<URL> {
  const allowExplicitLocal = process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT === '1'
  const url = validateNetworkUrl(raw, { allowExplicitLocal, requireHttps: true })
  return assertPublicNetworkUrl(url, { allowExplicitLocal, requireHttps: true })
}

function isUnsafeHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (isExplicitLocalHost(normalized)) return true
  if (normalized.endsWith('.local') || normalized.endsWith('.internal') || normalized === 'metadata.google.internal' || normalized === 'instance-data') return true
  return isUnsafeAddress(normalized)
}

function isExplicitLocalHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return LOCALHOST_NAMES.has(normalized) || normalized.endsWith('.localhost') || normalized === '127.0.0.1' || normalized === '::1'
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase().replace(/\.+$/, '')
}

function isIpLiteral(hostname: string): boolean {
  return isIP(normalizeHostname(hostname)) !== 0
}

function isUnsafeAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  const version = isIP(normalized)
  if (version === 4) return isUnsafeIpv4(normalized)
  if (version === 6) return isUnsafeIpv6(normalized)
  return false
}

function isUnsafeIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224
}

function isUnsafeIpv6(address: string): boolean {
  const normalized = address.toLocaleLowerCase().split('%')[0] ?? address
  if (normalized === '::' || normalized === '::1') return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return isUnsafeIpv4(mapped[1])
  const value = ipv6ToBigInt(normalized)
  if (value === undefined) return true
  if (value === 0n || value === 1n) return true
  // Any documented IPv4-embedding class must be checked against the IPv4
  // rules, not just the classic `::ffff:a.b.c.d` form. Bun normalizes
  // `::ffff:0:127.0.0.1` to `[::ffff:0:7f00:1]`, where the `ffff` marker sits
  // one group higher, so the old `(value >> 32n) === 0xffffn` test missed the
  // IPv4-translated, IPv4-compatible, and NAT64 classes entirely.
  const embeddedIpv4 = embeddedIpv4From(value)
  if (embeddedIpv4 !== undefined) return isUnsafeIpv4(embeddedIpv4)
  // 6to4 (2002::/16) and Teredo (2001:0::/32) embed a v4 address that must be checked too.
  const sixToFour = (value >> 112n) === 0x2002n
  const teredo = (value >> 96n) === 0x20010000n
  if (sixToFour || teredo) {
    const embeddedValue = teredo ? (value ^ 0xffffffffn) & 0xffffffffn : (value >> 80n) & 0xffffffffn
    const embeddedAddress = [
      Number((embeddedValue >> 24n) & 0xffn),
      Number((embeddedValue >> 16n) & 0xffn),
      Number((embeddedValue >> 8n) & 0xffn),
      Number(embeddedValue & 0xffn),
    ].join('.')
    if (isUnsafeIpv4(embeddedAddress)) return true
  }
  // ISATAP embeds a v4 address in the low 32 bits when the interface identifier is 0000:5efe:a.b.c.d or 0200:5efe:a.b.c.d
  const isatapIdHigh = (value >> 48n) & 0xffffn
  const isatapIdLow = (value >> 32n) & 0xffffn
  if (isatapIdLow === 0x5efen && (isatapIdHigh === 0n || isatapIdHigh === 0x0200n)) {
    const embeddedValue = value & 0xffffffffn
    const embeddedAddress = [
      Number((embeddedValue >> 24n) & 0xffn),
      Number((embeddedValue >> 16n) & 0xffn),
      Number((embeddedValue >> 8n) & 0xffn),
      Number(embeddedValue & 0xffn),
    ].join('.')
    if (isUnsafeIpv4(embeddedAddress)) return true
  }
  const fc00 = BigInt('0xfc000000000000000000000000000000')
  const fe80 = BigInt('0xfe800000000000000000000000000000')
  const ff00 = BigInt('0xff000000000000000000000000000000')
  const mask7 = BigInt('0xfe000000000000000000000000000000')
  const mask10 = BigInt('0xffc00000000000000000000000000000')
  const mask8 = BigInt('0xff000000000000000000000000000000')
  return (value & mask7) === (fc00 & mask7) || (value & mask10) === (fe80 & mask10) || (value & mask8) === ff00
}

/**
 * Recognize the documented IPv4-embedding IPv6 classes and return the embedded
 * IPv4 address (as dotted decimal) so the IPv4 rules can be re-applied to it:
 *
 *   ::a.b.c.d                 IPv4-compatible `::/96`
 *   ::ffff:a.b.c.d            IPv4-mapped    `::ffff:0:0/96`
 *   ::ffff:0:a.b.c.d          IPv4-translated `::ffff:0:0:0/96` (URL parsers
 *                             render `::ffff:0:127.0.0.1` as `[::ffff:0:7f00:1]`,
 *                             pushing the `ffff` marker a group higher)
 *   64:ff9b::a.b.c.d          NAT64 well-known prefix RFC 6052
 *   64:ff9b:1::a.b.c.d        NAT64 local-use prefix
 *
 * Returns undefined when the address does not embed an IPv4 under a known
 * prefix, so ordinary global IPv6 addresses are never miscounted.
 */
function embeddedIpv4From(value: bigint): string | undefined {
  const mid = (value >> 32n) & 0xffffffffn
  const mappedOrTranslated = mid === 0xffffn || mid === 0xffff0000n
  const compatible = (value >> 32n) === 0n
  const nat64WellKnown = (value >> 32n) === 0x0064ff9b0000000000000000n
  const nat64LocalUse = (value >> 32n) === 0x0064ff9b0001000000000000n
  if (!mappedOrTranslated && !compatible && !nat64WellKnown && !nat64LocalUse) return undefined
  const embedded = Number(value & 0xffffffffn)
  return [embedded >>> 24, (embedded >>> 16) & 255, (embedded >>> 8) & 255, embedded & 255].join('.')
}

function ipv6ToBigInt(address: string): bigint | undefined {
  const pieces = address.split('::')
  if (pieces.length > 2) return undefined
  const left = pieces[0] ? pieces[0].split(':').filter(Boolean) : []
  const right = pieces[1] ? pieces[1].split(':').filter(Boolean) : []
  const groups = [...left, ...right]
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined
  const missing = pieces.length === 2 ? 8 - groups.length : 0
  if (missing < 0 || (pieces.length === 1 && groups.length !== 8)) return undefined
  const expanded = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (expanded.length !== 8) return undefined
  return expanded.reduce((value, group) => (value << BigInt(16)) | BigInt(`0x${group}`), 0n)
}
