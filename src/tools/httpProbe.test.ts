import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newEngagementTool, engagementDir } from './engagement.ts'
import { httpProbeTool, parseScope, parseScopeHosts, hostInScope, stripZoneId } from './httpProbe.ts'
import { readSessionJar, SESSION_JAR_FILE, writeSessionJar } from './httpSession.ts'
import { SEALED_JAR_VERSION } from './httpSessionSeal.ts'

const originalFetch = globalThis.fetch
const slug = 'elia-test-httpprobe-2026'
const loopbackSlug = 'elia-test-httpprobe-loopback-2026'
const sessions = [slug, loopbackSlug]

interface SeenRequest {
  url: string
  method: string
  cookie: string | null
  body: string | null
}

let requests: SeenRequest[] = []

afterEach(() => {
  globalThis.fetch = originalFetch
  requests = []
  for (const name of sessions) rmSync(engagementDir(name), { recursive: true, force: true })
})

/**
 * Stub the transport and record what each hop actually received, so a test can
 * assert on the bytes on the wire rather than on the tool's own account of them.
 * Re-stubbing starts a fresh log, so `requests[0]` is always this phase's first
 * hop.
 */
function stub(handler: (call: SeenRequest) => Response): void {
  requests = []
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: SeenRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: headers.get('cookie'),
      body: typeof init?.body === 'string' ? init.body : null,
    }
    requests.push(call)
    return handler(call)
  }) as unknown as typeof fetch
}

/** A response carrying N `Set-Cookie` headers — which an object literal cannot express. */
function withSetCookies(body: string, cookies: string[], init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(body, { ...init, headers })
}

function jarPath(name = slug): string {
  return join(engagementDir(name), 'recon', SESSION_JAR_FILE)
}

function readJar(name = slug): { version: number; sessions: Record<string, Array<{ name: string; value: string; path: string }>> } {
  // The jar is sealed at rest, so assertions go through the production reader
  // rather than parsing the file — a test that read ciphertext would pass even
  // if the jar stopped round-tripping.
  return readSessionJar(jarPath(name)).jar as unknown as { version: number; sessions: Record<string, Array<{ name: string; value: string; path: string }>> }
}

function writeJar(content: string, name = slug): void {
  mkdirSync(join(engagementDir(name), 'recon'), { recursive: true })
  writeFileSync(jarPath(name), content)
}

/** Seed the jar through the production writer so it is sealed exactly as a real probe would seal it. */
function seedJar(jar: unknown, name = slug): void {
  writeSessionJar(jarPath(name), jar as Parameters<typeof writeSessionJar>[1])
}

test('parseScopeHosts extracts hostnames, IPs, and CIDR ranges', () => {
  const hosts = parseScopeHosts('Target: app.acme.com and 10.0.0.0/24; also api.acme.com. Out of scope: everything else. Version 1.2.3 is fine.')
  expect(hosts).toContain('app.acme.com')
  expect(hosts).toContain('api.acme.com')
  expect(hosts).toContain('10.0.0.0/24')
})

test('parseScopeHosts reads only the in-scope section and subtracts out-of-scope entries', () => {
  const text = [
    '# Engagement scope: x',
    '',
    '**Target:** app.acme.com',
    '**Authorized by:** alice@contact-person.org, legal.example.net',
    '',
    '## Rules of engagement',
    'Test app.acme.com and 10.0.0.0/24. Out of scope: payments.acme.com',
    '',
    '## Out of scope',
    '- admin.acme.com',
    '- 10.0.0.0/24',
    '',
    '## Notes',
    'Vendor status page: status.vendor.io',
  ].join('\n')
  const { include, exclude } = parseScope(text)
  expect(include).toEqual(expect.arrayContaining(['app.acme.com', '10.0.0.0/24']))
  expect(include).not.toContain('contact-person.org')
  expect(include).not.toContain('legal.example.net')
  expect(include).not.toContain('status.vendor.io')
  expect(include).not.toContain('payments.acme.com')
  expect(exclude).toEqual(expect.arrayContaining(['payments.acme.com', 'admin.acme.com', '10.0.0.0/24']))
  expect(parseScopeHosts(text)).toEqual(['app.acme.com'])
  expect(hostInScope('admin.acme.com', ['acme.com'], exclude)).toBe(false)
  expect(hostInScope('www.acme.com', ['acme.com'], exclude)).toBe(true)
})

test('parseScopeHosts does not treat bare hex-letter words as IPv6 hosts', () => {
  const hosts = parseScopeHosts('Scope: a dead face can add a bed at acme.com; the cafe is beef free')
  expect(hosts).toEqual(['acme.com'])
})

test('hostInScope matches exact hosts, subdomains, and CIDR membership', () => {
  const scope = ['acme.com', '10.0.0.0/24', '*.staging.acme.com']
  expect(hostInScope('acme.com', scope)).toBe(true)
  expect(hostInScope('www.acme.com', scope)).toBe(true)
  expect(hostInScope('10.0.0.55', scope)).toBe(true)
  expect(hostInScope('10.0.1.5', scope)).toBe(false)
  expect(hostInScope('x.staging.acme.com', scope)).toBe(true)
  expect(hostInScope('evil.com', scope)).toBe(false)
})

test('IPv6 zone identifiers are stripped from scope hosts and probe hostnames', () => {
  expect(stripZoneId('fe80::1%eth0')).toBe('fe80::1')
  expect(stripZoneId('fe80::1%25eth0')).toBe('fe80::1')
  expect(stripZoneId('example.com')).toBe('example.com')
  const hosts = parseScopeHosts('ffc3:3f1d:2f7:488::1%eth0 is the loopback link')
  expect(hosts).toContain('ffc3:3f1d:2f7:488::1')
  expect(hostInScope('fe80::1%eth0', ['fe80::1'])).toBe(true)
  expect(hostInScope('fe80::1%25eth0', ['fe80::1'])).toBe(true)
  expect(hostInScope('fe80::1', ['fe80::1'])).toBe(true)
})

async function scaffold() {
  await newEngagementTool.execute({ slug, target: 'app.example.com', authorizedBy: 'own lab', scope: 'https://app.example.com only, plus 192.168.10.0/24' })
}

test('http_probe refuses when the engagement was never scaffolded', async () => {
  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  expect(result).toContain('Run new_engagement first')
})

test('http_probe refuses a target host outside SCOPE.md', async () => {
  await scaffold()
  await expect(httpProbeTool.execute({ engagement: slug, url: 'https://not-in-scope.com/' })).rejects.toThrow('not in scope')
})

test('http_probe refuses a non-http protocol', async () => {
  await scaffold()
  await expect(httpProbeTool.execute({ engagement: slug, url: 'ftp://app.example.com/' })).rejects.toThrow('http(s)')
})

test('a session name that is not a plain key is refused, not silently stored under nothing', async () => {
  await scaffold()
  for (const bad of ['../escape', 'two words', '__proto__', 'a'.repeat(65)]) {
    await expect(httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/', session: bad })).rejects.toThrow()
  }
})

test('useSession: null means "not set" rather than a call error', async () => {
  await scaffold()
  stub(() => withSetCookies('ok', ['sid=abc123; Path=/']))
  const first = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/', useSession: null })
  expect(first).toContain('no stored cookies matched this URL')
    const second = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  expect(second).toContain('1 cookie(s) sent from recon/session.json')
  const jar = readJar()
  const stored = jar.sessions.default?.[0]
  expect(stored?.value).toBe('abc123')
})

test('a jar cookie missing a field is dropped instead of sent as a malformed header', async () => {
  await scaffold()
  seedJar({ version: SEALED_JAR_VERSION, sessions: { default: [{ name: 'sid', value: 'abc123', domain: 'app.example.com' }] } })
  stub(() => new Response('ok', { status: 200 }))
  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  expect(requests[0]?.cookie).toBeNull()
  expect(result).toContain('no stored cookies matched this URL')
})

test('http_probe sends an in-scope request and records the exchange to recon/traffic.jsonl', async () => {
  await scaffold()
  let seenUrl: string | undefined
  let seenInit: RequestInit | undefined
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    seenUrl = String(input)
    seenInit = init
    return new Response('<h1>hello</h1>', { status: 200, headers: { 'content-type': 'text/html', server: 'nginx' } })
  }) as unknown as typeof fetch

  const result = await httpProbeTool.execute({
    engagement: slug,
    url: 'https://app.example.com/search?q=1',
    method: 'POST',
    headers: { 'x-test': 'yes' },
    body: 'payload=1',
  })

  expect(seenUrl).toBe('https://app.example.com/search?q=1')
  expect(seenInit?.method).toBe('POST')
  expect(result).toContain('200')
  expect(result).toContain('hello')

  const traffic = await Bun.file(join(engagementDir(slug), 'recon', 'traffic.jsonl')).text()
  const entry = JSON.parse(traffic.trim())
  expect(entry.method).toBe('POST')
  expect(entry.status).toBe(200)
  expect(entry.requestHeaders['x-test']).toBe('yes')
  expect(entry.responseHeaders.server).toBe('nginx')
})

test('http_probe records a transport failure instead of throwing', async () => {
  await scaffold()
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch

  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  expect(result).toContain('Request failed')
  const traffic = await Bun.file(join(engagementDir(slug), 'recon', 'traffic.jsonl')).text()
  expect(JSON.parse(traffic.trim()).error).toContain('ECONNREFUSED')
})

test('http_probe matches a plain IPv6 scope entry for a zoned hostname', async () => {
  await newEngagementTool.execute({ slug, target: 'fe80::1', authorizedBy: 'own lab', scope: 'fe80::1 only' })
  globalThis.fetch = (async () => new Response('zone ok', { status: 200 })) as unknown as typeof fetch

  const result = await httpProbeTool.execute({ engagement: slug, url: 'http://[fe80::1]/' })
  expect(result).toContain('200')
  expect(result).toContain('zone ok')
})

// `redactSecrets` on the serialized record ran its assignment rule to the next
// whitespace/comma/semicolon, which on JSON swallows the value's closing quote:
// `set-cookie: JSESSIONID=9F1A; Path=/` became
// `"set-cookie":"[REDACTED]; Path=/; HttpOnly"` and the evidence line no longer
// parsed. Redaction is key-aware and runs on the record instead.
test('http_probe records a session cookie as a parseable JSONL line with the body intact', async () => {
  await scaffold()
  const body = `<html>${'lorem ipsum dolor sit amet '.repeat(12)}</html>`
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html', 'set-cookie': 'JSESSIONID=9F1A; Path=/; HttpOnly' },
    })) as unknown as typeof fetch

  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login' })
  expect(result).toContain('200')

  const traffic = await Bun.file(join(engagementDir(slug), 'recon', 'traffic.jsonl')).text()
  expect(traffic.trim().split('\n')).toHaveLength(1)
  const entry = JSON.parse(traffic.trim())
  expect(entry.responseHeaders['set-cookie']).toBe('[REDACTED]')
  expect(entry.responseBodySnippet).toBe(body)
})

// --- Phase E1: a persistent per-engagement cookie session ------------------
// Without state, IDOR, broken access control, and anything behind a login are
// unreachable: the strongest findings all need the same authenticated request
// replayed. Every test below asserts on what went out on the wire, not on the
// tool's own account of it.

test('a cookie from one response is sent on the next probe', async () => {
  await scaffold()
  stub(() => withSetCookies('ok', ['session=abc123; Path=/; HttpOnly; SameSite=Lax']))
  const login = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login', method: 'POST', body: 'user=a&pass=b' })
  expect(login).toContain('session')
  expect(requests[0]?.cookie).toBeNull()

  stub(() => new Response('welcome alice', { status: 200 }))
  const next = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/dashboard' })
  expect(requests[0]?.cookie).toBe('session=abc123')
  expect(next).toContain('1 cookie(s) sent')
  expect(next).toContain('session')
})

// Regression: `Object.fromEntries(headers.entries())` keeps only the LAST
// Set-Cookie, and `headers.get('set-cookie')` comma-joins them into a string
// whose `Expires=Wed, 01 Oct 2026 …` no parser can split. A CSRF cookie lost
// this way means every later request is missing its token, with nothing in the
// output to say so.
test('two Set-Cookie headers are both captured', async () => {
  await scaffold()
  stub(() => withSetCookies('ok', ['PHPSESSID=9F1A9F1A; Path=/; HttpOnly', 'csrftoken=tok3n; Path=/; SameSite=Strict']))
  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login' })

  const stored = readJar().sessions['default'] ?? []
  expect(stored.map((cookie) => cookie.name).sort()).toEqual(['PHPSESSID', 'csrftoken'])
  expect(result).toContain('PHPSESSID')
  expect(result).toContain('csrftoken')

  stub(() => new Response('ok', { status: 200 }))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/dashboard' })
  expect(requests[0]?.cookie?.split('; ').sort()).toEqual(['PHPSESSID=9F1A9F1A', 'csrftoken=tok3n'])
})

test('a Max-Age of zero and an Expires in the past delete the cookie instead of storing it', async () => {
  await scaffold()
  stub(() => withSetCookies('ok', ['a=1; Path=/; Max-Age=0', 'b=2; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  expect(readJar().sessions['default'] ?? []).toEqual([])

  stub(() => withSetCookies('ok', ['c=3; Path=/; Max-Age=0', 'live=4; Path=/; Max-Age=3600']))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  stub(() => new Response('ok', { status: 200 }))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  expect(requests[0]?.cookie).toBe('live=4')
})

test('a Path-scoped cookie is not sent to a path it does not cover', async () => {
  await scaffold()
  stub(() => withSetCookies('ok', ['api=zzz; Path=/api; HttpOnly', 'root=yyy; Path=/']))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/api/login' })

  stub(() => new Response('home', { status: 200 }))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  expect(requests[0]?.cookie).toBe('root=yyy')

  stub(() => new Response('users', { status: 200 }))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/api/v1/users' })
  expect(requests[0]?.cookie).toBe('api=zzz; root=yyy')

  // …and not to a path that merely starts with the same characters.
  stub(() => new Response('nope', { status: 200 }))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/apifoo' })
  expect(requests[0]?.cookie).toBe('root=yyy')
})

test('an explicit caller-supplied Cookie header wins over the jar, and nothing is merged', async () => {
  await scaffold()
  stub(() => withSetCookies('ok', ['session=fromjar; Path=/']))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login' })

  stub(() => new Response('ok', { status: 200 }))
  const result = await httpProbeTool.execute({
    engagement: slug,
    url: 'https://app.example.com/replay',
    headers: { Cookie: 'session=explicit-replay' },
  })
  expect(requests[0]?.cookie).toBe('session=explicit-replay')
  expect(result).toContain('withheld')
  // The jar is untouched — an override for one request is not a re-login.
  expect(readJar().sessions['default']?.[0]?.value).toBe('fromjar')
})

test('useSession false sends no cookies and stores none', async () => {
  await scaffold()
  stub(() => withSetCookies('ok', ['session=abc123; Path=/']))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login' })

  stub(() => withSetCookies('anonymous', ['session=guest; Path=/']))
  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/pricing', useSession: false })
  expect(requests[0]?.cookie).toBeNull()
  expect(result).toContain('useSession was set to false')
  expect(readJar().sessions['default']?.[0]?.value).toBe('abc123')
})

test('clearSession wipes the named session and a following probe sends nothing', async () => {
  await scaffold()
  stub(() => withSetCookies('ok', ['a=1; Path=/', 'b=2; Path=/']))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login', session: 'admin' })
  stub(() => withSetCookies('ok', ['c=3; Path=/']))
  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login', session: 'user2' })

  stub(() => new Response('cleared', { status: 200 }))
  const cleared = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/', session: 'admin', clearSession: true })
  expect(cleared).toContain('Cleared session "admin"')
  expect(cleared).toContain('2 cookie(s) removed')
  expect(requests).toHaveLength(0) // clearing never sends a request
  // A second auth context in the same file is untouched.
  expect(Object.keys(readJar().sessions)).toEqual(['user2'])

  await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/admin' })
  expect(requests[0]?.cookie).toBeNull()
})

test('a redirect chain is followed, each hop re-checking scope', async () => {
  await scaffold()
  const hops = new Map([
    ['https://app.example.com/old', '/sso'],
    ['https://app.example.com/sso', 'https://app.example.com/callback?code=1'],
    ['https://app.example.com/callback?code=1', '/dashboard'],
  ])
  stub((call) => {
    const location = hops.get(call.url)
    if (location === undefined) return new Response('welcome', { status: 200 })
    return new Response(null, { status: 302, headers: { location } })
  })

  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/old' })
  expect(requests.map((call) => call.url)).toEqual([
    'https://app.example.com/old',
    'https://app.example.com/sso',
    'https://app.example.com/callback?code=1',
    'https://app.example.com/dashboard',
  ])
  expect(result).toContain('3 redirects followed')
  expect(result).toContain('welcome')
  const entry = JSON.parse((await Bun.file(join(engagementDir(slug), 'recon', 'traffic.jsonl')).text()).trim())
  expect(entry.finalUrl).toBe('https://app.example.com/dashboard')
  expect(entry.redirects).toHaveLength(3)
})

test('a chain longer than the cap stops at the cap and says so', async () => {
  await scaffold()
  let hop = 0
  stub(() => new Response(null, { status: 302, headers: { location: `https://app.example.com/hop/${(hop += 1)}` } }))

  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/start' })
  expect(requests).toHaveLength(6) // the original plus the 5 hops it is allowed to follow
  expect(result).toContain('Stopped after 5 redirects')
  expect(result).toContain('302')
})

test('a redirect to an out-of-scope host is refused and never requested', async () => {
  await scaffold()
  stub(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } }))

  await expect(httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/logout' })).rejects.toThrow('not in scope')
  expect(requests.map((call) => call.url)).toEqual(['https://app.example.com/logout'])
  // The redirect is still evidence: the 302 that pointed off-scope is on record.
  const entry = JSON.parse((await Bun.file(join(engagementDir(slug), 'recon', 'traffic.jsonl')).text()).trim())
  expect(entry.blockedRedirect).toBe('https://evil.example/collect')
  expect(entry.status).toBe(302)
})

test('a malformed session.json recovers to an empty jar and says so', async () => {
  await scaffold()
  writeJar('{"sessions": {"default": [ {"name": "a",')

  stub(() => new Response('ok', { status: 200 }))
  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/' })
  expect(requests[0]?.cookie).toBeNull()
  expect(result).toContain('not readable JSON')
  expect(result).toContain('empty session')
})

test('the evidence line still parses when a PHPSESSID was set, and carries no value', async () => {
  await scaffold()
  const value = 'kQw3r9ZpX2mB7vL1sT4yU6'
  stub(() => withSetCookies(`<html>PHPSESSID=${value}</html>`, [`PHPSESSID=${value}; Path=/; HttpOnly`]))

  const result = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login', session: 'php' })
  expect(result).not.toContain(value)

  const traffic = await Bun.file(join(engagementDir(slug), 'recon', 'traffic.jsonl')).text()
  const entry = JSON.parse(traffic.trim())
  expect(entry.session).toBe('php')
  expect(entry.setCookie).toHaveLength(1)
  expect(entry.setCookie[0]).toContain('PHPSESSID')
  expect(entry.setCookie[0]).toContain('HttpOnly')
  expect(entry.setCookie[0]).not.toContain(value)
  // The body echoes the cookie the way a broken app does; the value is masked
  // there too, and the surrounding markup survives.
  expect(entry.responseBodySnippet).toContain('<html>')
  expect(entry.responseBodySnippet).not.toContain(value)
  expect(traffic).not.toContain(value)
})

test('no raw cookie value is returned to the model, on any path', async () => {
  await scaffold()
  const value = 'Yq4Tz8Lm2Pw9Kd6Xs1Nb3'
  stub(() => withSetCookies('ok', [`session=${value}; Path=/; HttpOnly`]))
  const stored = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login' })
  const cleared = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login', clearSession: true })
  stub(() => withSetCookies('ok', [`session=${value}; Path=/; HttpOnly`]))
  const anonymous = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/login', useSession: false })
  const listed = await httpProbeTool.execute({ engagement: slug, url: 'https://app.example.com/next' })

  for (const output of [stored, cleared, anonymous, listed]) {
    expect(output).not.toContain(value)
    expect(output).toContain('session')
  }
  // The value-length is reported instead, so the shape is still checkable.
  expect(stored).toContain(`${value.length} characters`)
  expect(readJar().sessions['default']?.[0]?.value).toBe(value)
})

// Over a real socket, with Bun's own HTTP stack on both ends: the cookie
// travels as a header, the 302 is a real 302, and the second request only
// carries the session because the first one set it. The server answers with a
// verdict rather than an echo — a body containing `cookie=…` is exactly what the
// redactor is there to blank, so echoing the value would prove nothing.
test('a login round-trip and its redirect chain work over a loopback server', async () => {
  await newEngagementTool.execute({ slug: loopbackSlug, target: 'loopback lab', authorizedBy: 'own lab', scope: 'http://127.0.0.1 only' })
  const cookieValue = 'loopback-session-8c1f4a'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/login') {
        return new Response(null, { status: 302, headers: { location: '/dashboard', 'set-cookie': `session=${cookieValue}; Path=/; HttpOnly; SameSite=Lax` } })
      }
      if (url.pathname === '/dashboard') return new Response('dashboard ok', { status: 200 })
      const authenticated = request.headers.get('cookie') === `session=${cookieValue}`
      return new Response(authenticated ? 'account alice' : 'account anonymous', { status: 200 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  try {
    const login = await httpProbeTool.execute({ engagement: loopbackSlug, url: `${base}/login`, method: 'POST', body: 'user=alice&pass=hunter2' })
    expect(login).toContain('1 redirect followed')
    expect(login).toContain('dashboard ok')
    expect(login).not.toContain(cookieValue)

    const me = await httpProbeTool.execute({ engagement: loopbackSlug, url: `${base}/api/me` })
    expect(me).toContain('account alice')
    expect(me).not.toContain(cookieValue)
    // The value must be on disk to be replayable, but never in the clear.
    expect(await Bun.file(jarPath(loopbackSlug)).text()).not.toContain(cookieValue)
    expect(readSessionJar(jarPath(loopbackSlug)).jar.sessions.default?.[0]?.value).toBe(cookieValue)

    const anonymous = await httpProbeTool.execute({ engagement: loopbackSlug, url: `${base}/api/me`, useSession: false })
    expect(anonymous).toContain('account anonymous')
  } finally {
    server.stop(true)
  }
})
