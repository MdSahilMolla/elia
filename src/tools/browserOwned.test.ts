import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findChromePath } from '../preview/launchChrome.ts'
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

// Real Chrome is installed on machines that exercise the launch path below for
// real — but a machine without Chrome must skip, not fail, the suite.
const hasChrome = () => Boolean(findChromePath())
const withChrome = hasChrome() ? test : test.skip

withChrome('ownedBrowserEndpoint launches a real headless browser and its DevTools endpoint answers /json/version', async () => {
  const origin = await ownedBrowserEndpoint()
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const response = await fetch(`${origin}/json/version`)
  expect(response.ok).toBe(true)
  const info = await response.json()
  expect(typeof info.webSocketDebuggerUrl).toBe('string')
  expect(String(info.Browser)).toMatch(/Chrome|Chromium|Edge|Brave/i)
}, 20_000)

withChrome('ownedBrowserEndpoint reuses the same instance across calls instead of launching a second browser', async () => {
  const first = await ownedBrowserEndpoint()
  const second = await ownedBrowserEndpoint()
  expect(second).toBe(first)
}, 20_000)

withChrome('two concurrent callers during first launch both get the same instance, not two separate browsers', async () => {
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

// A scribe in an `elia auto` run opened a file in this browser, and the finished
// run then never exited: the Chrome child kept the process alive, and its
// cleanup is an 'exit' hook that could therefore never fire. Only visible from
// outside the process, so this takes a real child with no process.exit of its own.
test.skipIf(!findChromePath())('the owned browser never keeps a finished process alive, and goes down with it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-owned-browser-exit-'))
  try {
    const script = join(dir, 'child.ts')
    const browserModule = pathToFileURL(join(import.meta.dir, 'browserOwned.ts')).href
    const shutdownModule = pathToFileURL(join(import.meta.dir, '..', 'ui', 'shutdown.ts')).href
    writeFileSync(
      script,
      [
        `const { installShutdownHandlers } = await import(${JSON.stringify(shutdownModule)})`,
        `const { ownedBrowserEndpoint } = await import(${JSON.stringify(browserModule)})`,
        `installShutdownHandlers()`,
        `console.log('ORIGIN ' + await ownedBrowserEndpoint())`,
      ].join('\n'),
    )
    const child = Bun.spawn([process.execPath, script], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(30_000).then(() => false)])
    if (!exited) child.kill()
    const origin = /ORIGIN (\S+)/.exec(await new Response(child.stdout).text())?.[1]
    expect(origin).toBeDefined()
    expect(exited).toBe(true)
    // The exit hook took the browser down: nothing answers on its DevTools port.
    // SIGTERM lets Chrome shut down gracefully, which takes a moment after the
    // child is gone (about a second on macOS), so poll rather than ask once.
    let stillUp = true
    for (let attempt = 0; attempt < 20 && stillUp; attempt++) {
      stillUp = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(1_000) }).then(() => true, () => false)
      if (stillUp) await Bun.sleep(250)
    }
    expect(stillUp).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
