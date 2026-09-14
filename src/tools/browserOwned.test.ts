import { afterEach, expect, test } from 'bun:test'
import { ownedBrowserEndpoint, ownedBrowserRequested, resetOwnedBrowserForTests, useOwnedBrowserByDefault } from './browserOwned.ts'

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

// --- The built-in browser is the default, not an opt-in ----------------------

const chromium = () => true
const noChromium = () => false

test('with nothing configured, the built-in browser is used whenever a Chromium-family browser is installed', () => {
  // It used to need ELIA_BROWSER=owned, which left most sessions with no
  // browser at all — every call failed with "no browser bridge is configured".
  expect(useOwnedBrowserByDefault({}, chromium)).toBe(true)
})

test('with nothing configured and no Chromium installed, there is no built-in browser to fall back to', () => {
  expect(useOwnedBrowserByDefault({}, noChromium)).toBe(false)
})

test('ELIA_BROWSER=off turns the fallback off, however it is spelled', () => {
  for (const off of ['off', 'OFF', ' none ', 'false', '0', 'no']) {
    expect(useOwnedBrowserByDefault({ ELIA_BROWSER: off }, chromium)).toBe(false)
  }
})

test('ELIA_BROWSER=owned still asks for it explicitly', () => {
  // Explicit wins over detection: the launch reports a missing browser itself,
  // rather than being silently skipped.
  expect(useOwnedBrowserByDefault({ ELIA_BROWSER: 'owned' }, noChromium)).toBe(true)
})
