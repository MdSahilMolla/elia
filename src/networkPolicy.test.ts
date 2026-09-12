import { expect, test } from 'bun:test'
import { assertProviderEndpoint, assertPublicNetworkUrl, validateNetworkUrl } from './networkPolicy.ts'

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
