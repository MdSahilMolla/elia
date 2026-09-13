import { expect, test } from 'bun:test'
import { injectReloadScript, stripReloadScript } from './reloadScript.ts'

// The preview server injects a live-reload script into every HTML response.
// At ~135 bytes it is over three times the readiness check's 40-byte blank
// threshold, so measuring the *served* bytes meant no page could ever be
// judged blank — a zero-byte file passed. For a static deliverable that render
// check is the only gate there is.
test('an empty page is under the blank threshold once the injected script is removed', () => {
  for (const page of ['', '<html></html>', '   ']) {
    const served = injectReloadScript(page)
    expect(Buffer.byteLength(served)).toBeGreaterThan(40)
    expect(Buffer.byteLength(stripReloadScript(served))).toBeLessThan(40)
  }
})

test('a real page is unchanged by the round trip', () => {
  const page = '<!doctype html><html><body><h1>Hi</h1><p>Real content, long enough to count.</p></body></html>'
  expect(stripReloadScript(injectReloadScript(page))).toBe(page)
})

test('the script goes before </body> when there is one', () => {
  const served = injectReloadScript('<html><body><p>x</p></body></html>')
  expect(served).toContain('</script></body>')
  expect(stripReloadScript(served)).toBe('<html><body><p>x</p></body></html>')
})

// Stripping must be a no-op on a page served by something other than elia's
// own server, or it would corrupt the very content it is measuring.
test('a page with no injected script is left alone', () => {
  const page = '<html><body><script>console.log(1)</script></body></html>'
  expect(stripReloadScript(page)).toBe(page)
})
