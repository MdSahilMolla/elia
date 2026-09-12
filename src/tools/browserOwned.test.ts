import { afterEach, expect, test } from 'bun:test'
import { ownedBrowserEndpoint, ownedBrowserRequested, resetOwnedBrowserForTests } from './browserOwned.ts'

const originalMode = process.env.ELIA_BROWSER

afterEach(() => {
  if (originalMode === undefined) delete process.env.ELIA_BROWSER
  else process.env.ELIA_BROWSER = originalMode
  resetOwnedBrowserForTests()
})

test('ownedBrowserRequested is false unless ELIA_BROWSER is exactly "owned"', () => {
  delete process.env.ELIA_BROWSER
  expect(ownedBrowserRequested()).toBe(false)
  process.env.ELIA_BROWSER = 'mcp'
  expect(ownedBrowserRequested()).toBe(false)
  process.env.ELIA_BROWSER = 'owned'
  expect(ownedBrowserRequested()).toBe(true)
  process.env.ELIA_BROWSER = 'Owned' // case-insensitive
  expect(ownedBrowserRequested()).toBe(true)
})

// This machine has a real Chrome install (verified before writing this test),
// so the launch path below is exercised for real — not just its error path.
test('ownedBrowserEndpoint launches a real headless browser and its DevTools endpoint answers /json/version', async () => {
  const origin = await ownedBrowserEndpoint()
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const response = await fetch(`${origin}/json/version`)
  expect(response.ok).toBe(true)
  const info = await response.json()
  expect(typeof info.webSocketDebuggerUrl).toBe('string')
  expect(String(info.Browser)).toMatch(/Chrome|Chromium|Edge|Brave/i)
}, 20_000)

test('ownedBrowserEndpoint reuses the same instance across calls instead of launching a second browser', async () => {
  const first = await ownedBrowserEndpoint()
  const second = await ownedBrowserEndpoint()
  expect(second).toBe(first)
}, 20_000)

test('two concurrent callers during first launch both get the same instance, not two separate browsers', async () => {
  const [a, b] = await Promise.all([ownedBrowserEndpoint(), ownedBrowserEndpoint()])
  expect(a).toBe(b)
}, 20_000)
