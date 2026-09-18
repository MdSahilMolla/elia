import { expect, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertProviderEndpoint, assertPublicNetworkUrl, publicAddressLookup, publicFetch, validateNetworkUrl } from './networkPolicy.ts'

async function withLocalServer<T>(run: (port: number, hits: () => number) => Promise<T>): Promise<T> {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.setHeader('content-type', 'text/plain')
    res.end(`host=${req.headers.host}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    return await run((server.address() as AddressInfo).port, () => hits)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function getThrough(port: number, lookup: ReturnType<typeof publicAddressLookup>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'rebind.example', port, path: '/', lookup }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the connection-time lookup refuses a name that rebinds to a private address', async () => {
  // The rebinding shape: an earlier check saw a public answer, but by connect
  // time the same name resolves to loopback. The lookup the socket actually
  // uses must catch it — no request may reach the private server.
  await withLocalServer(async (port, hits) => {
    const rebinding = publicAddressLookup({}, async () => [{ address: '127.0.0.1', family: 4 }])
    await expect(getThrough(port, rebinding)).rejects.toThrow('private or local')
    expect(hits()).toBe(0)
  })
})

test('the connection-time lookup refuses when any one answer is private', async () => {
  await withLocalServer(async (port, hits) => {
    const mixed = publicAddressLookup({}, async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }])
    await expect(getThrough(port, mixed)).rejects.toThrow('private or local')
    expect(hits()).toBe(0)
  })
})

test('the connection-time lookup connects to exactly the address it validated, keeping the original Host', async () => {
  // An allowed answer is passed straight to the socket — this one is loopback
  // only because the test's server lives there; allowExplicitLocal+localhost
  // is the one configuration where that is legitimate.
  await withLocalServer(async (port) => {
    const body = await publicFetch(`http://localhost:${port}/`, { policy: { allowExplicitLocal: true } }).then((r) => r.text())
    expect(body).toBe(`host=localhost:${port}`)
  })
})

test('publicFetch refuses a local target without the explicit opt-in', async () => {
  await withLocalServer(async (port, hits) => {
    await expect(publicFetch(`http://localhost:${port}/`)).rejects.toThrow('private or local')
    expect(hits()).toBe(0)
  })
})

test('network URL validation rejects unsafe schemes, credentials, and literal internal targets', () => {
  for (const url of [
    'file:///etc/passwd',
    'http://user:password@example.com/data',
    'http://127.0.0.1:3000',
    'http://10.0.0.7/metadata',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://service.local/',
  ]) {
    expect(() => validateNetworkUrl(url)).toThrow()
  }
})

test('network URL validation rejects IPv6 loopback and address-embedding bypass forms', () => {
  for (const url of [
    'http://[0:0:0:0:0:0:0:1]/', // long-form loopback, not the compressed ::1
    'http://[0000:0000:0000:0000:0000:0000:0000:0001]/',
    'http://[::]/', // unspecified address, long form
    'http://[0:0:0:0:0:0:0:0]/',
    'http://[2002:7f00:0001::]/', // 6to4 embedding 127.0.0.1
    'http://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/', // Teredo embedding a loopback client IP
    'http://[0:0:0:0:0000:5efe:127.0.0.1]/', // ISATAP embedding 127.0.0.1
  ]) {
    expect(() => validateNetworkUrl(url)).toThrow()
  }
})

test('network URL validation rejects IPv4-translated, compatible, and NAT64 embedding forms', () => {
  // Bun normalizes `[::ffff:0:127.0.0.1]` to `[::ffff:0:7f00:1]`, pushing the
  // `ffff` marker a group higher than the classic mapped form — the old
  // `(value >> 32n) === 0xffffn` check missed every one of these. Each embeds
  // a local/private IPv4 that an attacker could reach through a NAT64 gateway
  // or IPv4-compatible routing.
  for (const url of [
    'http://[::ffff:0:127.0.0.1]/', // IPv4-translated ??::ffff:0:0:0/96
    'http://[::ffff:0:10.0.0.1]/',
    'http://[::ffff:0:192.168.1.1]/',
    'http://[::ffff:0:169.254.169.254]/', // host metadata via translation
    'http://[::127.0.0.1]/', // IPv4-compatible ::/96
    'http://[::192.168.1.1]/',
    'http://[::10.0.0.1]/',
    'http://[::169.254.169.254]/',
    'http://[64:ff9b::127.0.0.1]/', // NAT64 well-known prefix
    'http://[64:ff9b::10.0.0.1]/',
    'http://[64:ff9b::169.254.169.254]/',
    'http://[64:ff9b:1::7f00:1]/', // NAT64 local-use prefix
    'http://[64:ff9b:1::a00:1]/',
  ]) {
    expect(() => validateNetworkUrl(url)).toThrow()
  }
})

test('network URL validation still accepts authoritative public IPv6 globals', () => {
  for (const url of [
    'http://[2606:4700:4700::1111]/', // Cloudflare DNS
    'http://[2001:4860:4860::8888]/', // Google DNS
    'http://[2606:4700:4700::1111:1]/',
    'http://[2400:cb00:2049:1::c629:d7a2]/', // Cloudflare front-end
  ]) {
    expect(() => validateNetworkUrl(url)).not.toThrow()
  }
})

test('the DNS-answer path refuses NAT64 and translated loopback answers', async () => {
  const rebinding = publicAddressLookup({}, async () => [{ address: '64:ff9b::7f00:1', family: 6 }])
  await withLocalServer(async (port, hits) => {
    await expect(getThrough(port, rebinding)).rejects.toThrow('private or local')
    expect(hits()).toBe(0)
  })
})

test('network URL validation accepts public HTTPS syntax and requires TLS for providers', async () => {
  expect(validateNetworkUrl('https://api.example.com/v1').origin).toBe('https://api.example.com')
  await expect(assertPublicNetworkUrl('https://203.0.113.8')).rejects.toThrow('private or local')
  await expect(assertProviderEndpoint('http://api.example.com/v1')).rejects.toThrow('insecure network endpoint')
})

test('localhost provider endpoints require an explicit development opt-in', async () => {
  const previous = process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT
  try {
    delete process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT
    await expect(assertProviderEndpoint('http://127.0.0.1:11434/v1')).rejects.toThrow()
    process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT = '1'
    await expect(assertProviderEndpoint('http://127.0.0.1:11434/v1')).resolves.toMatchObject({ hostname: '127.0.0.1' })
  } finally {
    if (previous === undefined) delete process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT
    else process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT = previous
  }
})
