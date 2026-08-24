import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveReactStaticPath, startReactServer } from './react_server.ts'

test('React static path resolution rejects traversal, malformed encoding, and sensitive files', () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-react-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'elia-react-outside-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html>')
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, '.env'), 'ELIA_SECRET=never-serve')
  writeFileSync(join(outside, 'secret.txt'), 'never-serve')
  symlinkSync(outside, join(root, 'link'), 'dir')

  expect(resolveReactStaticPath(root, '/')).toBe(join(root, 'index.html'))
  expect(resolveReactStaticPath(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'))
  expect(resolveReactStaticPath(root, '/../secret.txt')).toBeUndefined()
  expect(resolveReactStaticPath(root, '/%2e%2e/secret.txt')).toBeUndefined()
  expect(resolveReactStaticPath(root, '/%E0%A4%A')).toBeUndefined()
  expect(resolveReactStaticPath(root, '/.env')).toBeUndefined()
  expect(resolveReactStaticPath(root, '/link/secret.txt')).toBeUndefined()

  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('React server binds to loopback and serves with no-store security headers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-react-server-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><body>ok</body>')
  const started = startReactServer({ root, port: 0 })
  try {
    expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${started.baseUrl}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toContain('ok')

    const forbidden = await fetch(`${started.baseUrl}/%2e%2e/%2e%2e/etc/passwd`)
    expect(forbidden.status).toBe(403)
  } finally {
    started.server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})
