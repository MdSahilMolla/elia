import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface NetworkUrlOptions {
  allowExplicitLocal?: boolean
  requireHttps?: boolean
}

const LOCALHOST_NAMES = new Set(['localhost', 'localhost.'])

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
  if ((value >> 32n) === 0xffffn) {
    const mappedValue = Number(value & 0xffffffffn)
    const mappedAddress = [mappedValue >>> 24, (mappedValue >>> 16) & 255, (mappedValue >>> 8) & 255, mappedValue & 255].join('.')
    return isUnsafeIpv4(mappedAddress)
  }
  const fc00 = BigInt('0xfc000000000000000000000000000000')
  const fe80 = BigInt('0xfe800000000000000000000000000000')
  const ff00 = BigInt('0xff000000000000000000000000000000')
  const mask7 = BigInt('0xfe000000000000000000000000000000')
  const mask10 = BigInt('0xffc00000000000000000000000000000')
  const mask8 = BigInt('0xff000000000000000000000000000000')
  return (value & mask7) === (fc00 & mask7) || (value & mask10) === (fe80 & mask10) || (value & mask8) === ff00
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
