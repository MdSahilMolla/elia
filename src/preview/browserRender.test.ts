import { expect, test } from 'bun:test'
import { findChromePath } from './launchChrome.ts'
import { browserRenderEnabled, judgePageObservation, renderDepthNote, verifyPageRender, type PageObservation } from './browserRender.ts'

const seen = (over: Partial<PageObservation> = {}): PageObservation => ({
  exceptions: [],
  consoleErrors: [],
  failedResources: [],
  visibleTextChars: 120,
  visibleElements: 2,
  ...over,
})

test('a page that loads, paints, and throws nothing passes', () => {
  expect(judgePageObservation(seen()).ok).toBe(true)
})

test('an uncaught exception fails the page even though it painted', () => {
  const verdict = judgePageObservation(seen({ exceptions: ['TypeError: Cannot read properties of null (reading \'addEventListener\')\n    at app.js:3'] }))
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('threw while loading')
  expect(verdict.reason).toContain('addEventListener')
  expect(verdict.reason).not.toContain('app.js:3')
})

test('a missing stylesheet or script fails the page', () => {
  const verdict = judgePageObservation(seen({ failedResources: ['stylesheet http://127.0.0.1/style.css returned HTTP 404', 'script http://127.0.0.1/app.js returned HTTP 404'] }))
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('style.css')
  expect(verdict.reason).toContain('+1 more')
})

test('a blank screen fails: nothing visible after load', () => {
  const verdict = judgePageObservation(seen({ visibleTextChars: 0, visibleElements: 0 }))
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('nothing is visible')
})

test('a canvas-only page is not blank', () => {
  expect(judgePageObservation(seen({ visibleTextChars: 0, visibleElements: 1 })).ok).toBe(true)
})

test('console errors are evidence, not a failure; favicon misses are ignored', () => {
  const verdict = judgePageObservation(seen({
    consoleErrors: ['Failed to load resource: 404 (http://127.0.0.1/favicon.ico)', 'analytics blocked'],
    failedResources: ['document http://127.0.0.1/favicon.ico failed (net::ERR_FILE_NOT_FOUND)'],
  }))
  expect(verdict.ok).toBe(true)
  expect(verdict.warnings).toEqual(['console error: analytics blocked'])
})

test('navigation failure is reported as such', () => {
  const verdict = judgePageObservation(seen({ navigationError: 'net::ERR_CONNECTION_REFUSED' }))
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('ERR_CONNECTION_REFUSED')
})

test('the browser check is off under bun test unless asked for, and ELIA_BROWSER=off wins', () => {
  expect(browserRenderEnabled({ NODE_ENV: 'test' })).toBe(false)
  expect(browserRenderEnabled({ NODE_ENV: 'test', ELIA_RENDER_BROWSER: 'on' })).toBe(true)
  expect(browserRenderEnabled({})).toBe(true)
  expect(browserRenderEnabled({ ELIA_BROWSER: 'off' })).toBe(false)
  expect(browserRenderEnabled({ ELIA_RENDER_BROWSER: 'off' })).toBe(false)
})

const httpOk = async () => ({ ok: true, status: 200, bodyBytes: 500 })

test('verifyPageRender stops at a failing HTTP check without starting a browser', async () => {
  let launched = false
  const result = await verifyPageRender('http://x/', undefined, {}, {
    enabled: true,
    http: async () => ({ ok: false, reason: 'root returned HTTP 500' }),
    browserEndpoint: async () => { launched = true; return 'http://cdp' },
  })
  expect(result).toMatchObject({ ok: false, depth: 'http', reason: 'root returned HTTP 500' })
  expect(launched).toBe(false)
})

test('verifyPageRender fails a page the browser saw throw, though HTTP passed', async () => {
  const result = await verifyPageRender('http://x/', undefined, {}, {
    enabled: true,
    http: httpOk,
    browserEndpoint: async () => 'http://cdp',
    observe: async () => seen({ exceptions: ['ReferenceError: app is not defined'] }),
  })
  expect(result.ok).toBe(false)
  expect(result.depth).toBe('browser')
  expect(result.reason).toContain('app is not defined')
})

test('no browser leaves the HTTP verdict standing, labelled HTTP only', async () => {
  const result = await verifyPageRender('http://x/', undefined, {}, {
    enabled: true,
    http: httpOk,
    browserEndpoint: async () => { throw new Error('no Chromium-family browser was found') },
  })
  expect(result.ok).toBe(true)
  expect(result.depth).toBe('http')
  expect(renderDepthNote(result)).toContain('HTTP only')
  expect(renderDepthNote(result)).toContain('no Chromium-family browser')
})

// Real Chromium, opt-in: ELIA_RENDER_BROWSER_E2E=1 bun test src/preview/browserRender.test.ts
const e2e = process.env.ELIA_RENDER_BROWSER_E2E === '1' && findChromePath() !== undefined
test.skipIf(!e2e)('real browser: catches a boot-time throw, a missing stylesheet, and a blank root that HTTP passes', async () => {
  const pages: Record<string, string> = {
    '/good': '<!doctype html><html><body><h1>Tip calculator</h1><p>Enter a bill amount.</p></body></html>',
    '/throws': '<!doctype html><html><body><h1>Tip calculator</h1><script>document.getElementById("bill").addEventListener("input", () => {})</script></body></html>',
    '/nocss': '<!doctype html><html><head><link rel="stylesheet" href="/missing.css"></head><body><h1>Tip calculator</h1></body></html>',
    '/blank': '<!doctype html><html><body><div id="root"></div><script>/* the app never mounts */</script></body></html>',
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const body = pages[new URL(req.url).pathname]
      return body ? new Response(body, { headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  try {
    const run = (path: string) => verifyPageRender(`${base}${path}`, undefined, {}, { enabled: true })
    const good = await run('/good')
    expect(good).toMatchObject({ ok: true, depth: 'browser' })
    const throws = await run('/throws')
    expect(throws.ok).toBe(false)
    expect(throws.reason).toContain('threw while loading')
    const nocss = await run('/nocss')
    expect(nocss.ok).toBe(false)
    expect(nocss.reason).toContain('missing.css')
    const blank = await run('/blank')
    expect(blank.ok).toBe(false)
    expect(blank.reason).toContain('nothing is visible')
  } finally {
    server.stop(true)
    const { resetOwnedBrowserForTests } = await import('../tools/browserOwned.ts')
    resetOwnedBrowserForTests()
  }
}, 60_000)
