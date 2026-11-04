import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { publicFetchTestHooks } from '../networkPolicy.ts'
import { compareFeatures, comparePageTool, cssColors, cssFonts, pageFeatures } from './comparePage.ts'

const ORIGINAL = `<html><head>
<link rel="stylesheet" href="/site.css">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap" rel="stylesheet">
</head><body>
<nav><a href="#c">Categories</a><a href="#m">Our Mission</a><a href="#s">Store</a></nav>
<h1>Fresh. Hygienic. Trusted.</h1>
<a class="btn primary" href="https://wa.me/1">Order on WhatsApp</a>
<h2>Our Mission</h2><p>Make fresh, hygienic meat easy to order for every home in Agra.</p>
<h2>Why Meat Us</h2><img src="a.jpg"><img src="b.jpg">
</body></html>`
const ORIGINAL_CSS = ':root{--red:#B22222}body{font-family:"Poppins",sans-serif;background:#fff8f0;color:#222}.btn{background:#b22222;color:#fff}'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'elia-compare-')))
  publicFetchTestHooks.transport = async (url) => {
    const path = url.toString()
    if (path.endsWith('/site.css')) return new Response(ORIGINAL_CSS, { headers: { 'content-type': 'text/css' } })
    if (path.includes('fonts.googleapis')) return new Response('', { headers: { 'content-type': 'text/css' } })
    return new Response(ORIGINAL, { headers: { 'content-type': 'text/html' } })
  }
})
afterEach(() => {
  publicFetchTestHooks.transport = undefined
  rmSync(dir, { recursive: true, force: true })
})

function run(input: Record<string, unknown>) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => comparePageTool.execute(input))
}

test('colours are read in every notation and ranked by use', () => {
  expect(cssColors('a{color:#B22222}b{color:#b22222;background:#fff}c{border-color:rgb(0, 128, 255)}')).toEqual(['#b22222', '#ffffff', '#0080ff'])
})

test('fonts skip generic fallbacks and include linked Google Fonts', () => {
  expect(cssFonts('body{font-family:"Inter", system-ui, sans-serif}', '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700">')).toEqual(['inter', 'playfair display'])
})

test('an exact copy scores 100%; a words-only copy is told what it lacks', async () => {
  writeFileSync(join(dir, 'site.css'), ORIGINAL_CSS)
  writeFileSync(join(dir, 'exact.html'), ORIGINAL.replace('/site.css', 'site.css'))
  expect(await run({ original: 'https://example.com/', copy: 'exact.html' })).toContain(': 100%')

  writeFileSync(join(dir, 'plain.css'), 'body{font-family:system-ui;color:#1a1a1a;background:#fff}.cta{background:#c44536}')
  writeFileSync(join(dir, 'plain.html'), '<link rel="stylesheet" href="plain.css"><h1>Fresh. Hygienic. Trusted.</h1><h2>Why Meat Us</h2><h2>Our Mission</h2><p>Make fresh, hygienic meat easy to order for every home in Agra.</p><button>Order Now</button>')
  const report = await run({ original: 'https://example.com/', copy: 'plain.html' })
  expect(report).toMatch(/Likeness of plain\.html to https:\/\/example\.com\/: \d+%/)
  expect(report).toContain('fonts: 0/1 — missing: poppins')
  expect(report).toContain('#b22222')
  expect(report).toContain('Order on WhatsApp')
  expect(report).toContain('different order')
  expect(report).toContain('2 fewer <img>')
  expect(report).toContain('Spacing, layout and anything drawn by scripts are not measured')
})

test('a near shade counts as the same colour', () => {
  const original = pageFeatures('<p>x</p>', 'a{color:#b22222}')
  const copy = pageFeatures('<p>x</p>', 'a{color:#b42424}')
  expect(compareFeatures(original, copy).find((dimension) => dimension.name === 'colors')?.matched).toBe(1)
})

test('a missing copy, a non-URL original, and a private original are refused', async () => {
  await expect(run({ original: 'https://example.com/', copy: 'nope.html' })).rejects.toThrow('does not exist')
  await expect(run({ original: 'meatusindia.com', copy: 'x.html' })).rejects.toThrow('http(s) URL')
  writeFileSync(join(dir, 'x.html'), '<p>x</p>')
  await expect(run({ original: 'http://127.0.0.1:8080/', copy: 'x.html' })).rejects.toThrow('could not read the original')
})
