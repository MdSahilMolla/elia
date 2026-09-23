import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensurePreviewServer, injectReloadScript, resetPreviewServerForTests, resolveWithinRoot } from './server.ts'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-preview-test-'))
})

afterEach(() => {
  resetPreviewServerForTests()
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

test('resolveWithinRoot resolves a normal relative path', () => {
  const resolved = resolveWithinRoot(testDir, '/index.html')
  expect(resolved).toBe(join(testDir, 'index.html'))
})

test('resolveWithinRoot defaults "/" to index.html', () => {
  expect(resolveWithinRoot(testDir, '/')).toBe(join(testDir, 'index.html'))
})

test('resolveWithinRoot rejects path traversal out of the root', () => {
  expect(resolveWithinRoot(testDir, '/../../etc/passwd')).toBeUndefined()
})

test('resolveWithinRoot rejects an encoded traversal attempt', () => {
  expect(resolveWithinRoot(testDir, '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined()
})

test('injectReloadScript inserts before a closing body tag', () => {
  const html = '<html><body><h1>hi</h1></body></html>'
  const result = injectReloadScript(html)
  expect(result).toContain('<h1>hi</h1>')
  expect(result).toContain('WebSocket')
  expect(result.indexOf('WebSocket')).toBeLessThan(result.indexOf('</body>'))
})

test('injectReloadScript appends when there is no body tag', () => {
  const html = '<h1>fragment</h1>'
  const result = injectReloadScript(html)
  expect(result.startsWith(html)).toBe(true)
  expect(result).toContain('WebSocket')
})

test('server serves a static HTML file with the reload script injected', async () => {
  writeFileSync(join(testDir, 'index.html'), '<html><body>hello</body></html>')
  const server = ensurePreviewServer(testDir)

  const res = await fetch(`${server.baseUrl}/index.html`)
  const text = await res.text()

  expect(res.status).toBe(200)
  expect(text).toContain('hello')
  expect(text).toContain('WebSocket')
})

test('server returns 404 for a missing file', async () => {
  const server = ensurePreviewServer(testDir)
  const res = await fetch(`${server.baseUrl}/does-not-exist.html`)
  expect(res.status).toBe(404)
})

test("a request for a subdirectory serves that subdirectory's index.html, not the root page", async () => {
  mkdirSync(join(testDir, 'game'), { recursive: true })
  writeFileSync(join(testDir, 'game', 'index.html'), '<html><body>the game</body></html>')
  writeFileSync(join(testDir, 'index.html'), '<html><body>root page</body></html>')
  const server = ensurePreviewServer(testDir)

  const res = await fetch(`${server.baseUrl}/game`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('the game')
})

test('server returns 403 for a path-traversal request over HTTP', async () => {
  const server = ensurePreviewServer(testDir)
  const res = await fetch(`${server.baseUrl}/../../../../etc/passwd`, { redirect: 'manual' })
  // Browsers/undici normalize ".." in the URL before it reaches the server in some
  // cases, so accept either an outright rejection or a 404 (never a 200 with real content).
  expect([403, 404]).toContain(res.status)
})

test('editing a served file triggers a live-reload push over the WebSocket', async () => {
  writeFileSync(join(testDir, 'live.html'), '<html><body>v1</body></html>')
  const server = ensurePreviewServer(testDir)

  const reloadReceived = new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/__reload`)
    let edits: ReturnType<typeof setInterval> | undefined
    const timeout = setTimeout(() => {
      clearInterval(edits)
      reject(new Error('timed out waiting for reload push'))
    }, 15000)
    const done = () => {
      clearTimeout(timeout)
      clearInterval(edits)
      ws.close()
      resolve()
    }
    ws.onerror = () => reject(new Error('reload WebSocket errored'))
    ws.onmessage = done
    ws.onopen = () => {
      // Keep touching the file until the watcher notices. A single write can be
      // missed on a loaded CI runner where recursive fs.watch registers slowly.
      let n = 2
      const touch = () => writeFileSync(join(testDir, 'live.html'), `<html><body>v${n++}</body></html>`)
      touch()
      edits = setInterval(touch, 250)
    }
  })

  await reloadReceived
}, 20000)

test('resolveWithinRoot rejects malformed percent-encoding', () => {
  expect(resolveWithinRoot(testDir, '/%E0%A4%A')).toBeUndefined()
})

test('resolveWithinRoot rejects a symlink that escapes the root', () => {
  const outside = mkdtempSync(join(tmpdir(), 'elia-preview-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  let linked = true
  try {
    symlinkSync(join(outside, 'secret.txt'), join(testDir, 'leak.txt'))
  } catch {
    linked = false // e.g. Windows without the symlink privilege
  }
  try {
    if (linked) expect(resolveWithinRoot(testDir, '/leak.txt')).toBeUndefined()
  } finally {
    rmSync(join(testDir, 'leak.txt'), { force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('server refuses to serve a file reached through an escaping symlink', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'elia-preview-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  let linked = true
  try {
    symlinkSync(join(outside, 'secret.txt'), join(testDir, 'leak.txt'))
  } catch {
    linked = false
  }
  try {
    if (linked) {
      const server = ensurePreviewServer(testDir)
      const res = await fetch(`${server.baseUrl}/leak.txt`)
      expect(res.status).not.toBe(200)
    }
  } finally {
    rmSync(join(testDir, 'leak.txt'), { force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// `elia auto` on a static site proves the page through this server, and one
// such run printed "Run complete" and then never exited — the listening socket
// and the file watcher held it open. A process can only be seen to end from
// outside it, so this takes a real child with no process.exit of its own.
test('a preview server never keeps a finished process alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-preview-exit-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
    const script = join(dir, 'child.ts')
    const serverModule = pathToFileURL(join(import.meta.dir, 'server.ts')).href
    writeFileSync(
      script,
      [
        `const { ensurePreviewServer } = await import(${JSON.stringify(serverModule)})`,
        `const server = ensurePreviewServer(${JSON.stringify(dir)})`,
        `const response = await fetch(server.baseUrl + '/index.html')`,
        `console.log('SERVED ' + response.status)`,
      ].join('\n'),
    )
    const child = Bun.spawn([process.execPath, script], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
    if (!exited) child.kill()
    expect(await new Response(child.stdout).text()).toContain('SERVED 200')
    expect(exited).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
