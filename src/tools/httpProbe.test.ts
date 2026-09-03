import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { newEngagementTool, engagementDir } from './engagement.ts'
import { httpProbeTool, parseScopeHosts, hostInScope } from './httpProbe.ts'

const originalFetch = globalThis.fetch
const slug = 'elia-test-httpprobe-2026'

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(engagementDir(slug), { recursive: true, force: true })
})

test('parseScopeHosts extracts hostnames, IPs, and CIDR ranges', () => {
  const hosts = parseScopeHosts('Target: app.acme.com and 10.0.0.0/24; also api.acme.com. Out of scope: everything else. Version 1.2.3 is fine.')
  expect(hosts).toContain('app.acme.com')
  expect(hosts).toContain('api.acme.com')
  expect(hosts).toContain('10.0.0.0/24')
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
