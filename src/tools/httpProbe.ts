import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { redactSecrets } from '../ui/redact.ts'
import { currentAgent } from '../autonomy/context.ts'
import { engagementDir } from './engagement.ts'

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const REQUEST_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_SNIPPET = 4_000

/** Pull every host/IP/CIDR token out of a SCOPE.md so a request target can be checked against it. */
export function parseScopeHosts(scopeText: string): string[] {
  const tokens = new Set<string>()
  const pattern = /\b((?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?|localhost|\[?[0-9a-f:]+\]?(?:\/\d{1,3})?)\b/gi
  for (const match of scopeText.matchAll(pattern)) {
    const token = match[1]!.toLowerCase().replace(/^\[|\]$/g, '')
    // Skip bare version-like or date-like dotted numbers that are not addresses.
    if (/^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(token)) {
      const [ip, bits] = token.split('/')
      if (isIP(ip!) === 4 && (bits === undefined || Number(bits) <= 32)) tokens.add(token)
      continue
    }
    tokens.add(token)
  }
  return [...tokens]
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

/** Whether a request hostname is covered by an engagement's authorized scope tokens. */
export function hostInScope(hostname: string, scopeHosts: string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const hostIsIpv4 = isIP(host) === 4
  for (const token of scopeHosts) {
    if (token === host) return true
    if (token.startsWith('*.') && (host === token.slice(2) || host.endsWith(token.slice(1)))) return true
    // A plain domain token also covers its subdomains.
    if (!token.includes('/') && isIP(token) === 0 && token !== 'localhost' && (host === token || host.endsWith(`.${token}`))) return true
    if (hostIsIpv4 && token.includes('/') && ipv4InCidr(host, token)) return true
  }
  return false
}

export const httpProbeTool: Tool = {
  name: 'http_probe',
  description:
    "Send a single HTTP request to an in-scope target for an authorized engagement and record the full request/response pair to recon/traffic.jsonl as evidence. The target host must appear in the engagement's SCOPE.md (hostnames, IPs, and IPv4 CIDR ranges are matched) — a request outside scope is refused. Use this for manual probing, replaying a request with a tweaked parameter, or capturing a response to cite in log_finding. Requires new_engagement first.",
  input_schema: {
    type: 'object',
    properties: {
      engagement: { type: 'string', description: 'The engagement slug (from new_engagement)' },
      url: { type: 'string', description: 'Full http(s) URL of the target; its host must be in SCOPE.md' },
      method: { type: 'string', description: 'HTTP method (default GET)' },
      headers: { type: 'object', description: 'Optional request headers as a string map' },
      body: { type: 'string', description: 'Optional request body (max 64 KB)' },
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
    const scopeHosts = parseScopeHosts(scopeText)
    if (!hostInScope(url.hostname, scopeHosts)) {
      throw new Error(
        `${url.hostname} is not in scope for "${slug}". SCOPE.md authorizes: ${scopeHosts.join(', ') || '(no hosts parsed)'}. Update the engagement scope if this target is genuinely authorized.`,
      )
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
    let status: number
    let responseHeaders: Record<string, string> = {}
    let responseSnippet = ''
    let error: string | undefined
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(currentAgent().signal ? [currentAgent().signal!] : [])]),
      })
      status = response.status
      responseHeaders = Object.fromEntries(response.headers.entries())
      const text = await response.text()
      responseSnippet = text.slice(0, MAX_RESPONSE_SNIPPET)
    } catch (caught) {
      status = 0
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const elapsedMs = Date.now() - startedAt

    const record = {
      ts: new Date(startedAt).toISOString(),
      method,
      url: url.toString(),
      requestHeaders: Object.fromEntries(headers.entries()),
      requestBody: body ?? null,
      status,
      responseHeaders,
      responseBodySnippet: responseSnippet,
      truncated: responseSnippet.length >= MAX_RESPONSE_SNIPPET,
      elapsedMs,
      ...(error ? { error } : {}),
    }
    const trafficPath = join(dir, 'recon', 'traffic.jsonl')
    await captureBeforeWrite(trafficPath)
    const existing = existsSync(trafficPath) ? await Bun.file(trafficPath).text() : ''
    await Bun.write(trafficPath, `${existing}${redactSecrets(JSON.stringify(record))}\n`)

    if (error) return `Request failed after ${elapsedMs}ms: ${error}\nLogged to recon/traffic.jsonl`
    return redactSecrets(
      [
        `${method} ${url} → ${status} (${elapsedMs}ms)`,
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
