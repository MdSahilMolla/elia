import { dirname, resolve } from 'node:path'
import type { Tool } from './types.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess } from '../autonomy/sensitivePaths.ts'
import { readBoundedOutput } from '../shell.ts'
import { decodeEntities, fetchFollowingRedirects, htmlToText, stylesheetUrls } from './webFetch.ts'

/**
 * Says how close a copy of a web page is to the original, from their source.
 *
 * "Recreate their website exactly" was reported done four times in a row on a
 * copy that shared the original's words and little else: the check behind
 * "pass" was only that the preview opened. Judging a likeness needs eyes the
 * model may not have (mercury reads no images), so this compares what the
 * look is made of — colours, fonts, the heading outline, navigation, calls to
 * action, images, and the text — and names each thing the copy is missing.
 *
 * It reads source, not pixels: spacing, layout geometry and anything a script
 * draws at run time are outside it, and the report says so.
 */

const FETCH_TIMEOUT_MS = 15_000
const MAX_PAGE_CHARS = 2_000_000
const MAX_STYLESHEET_CHARS = 1_000_000
/** Colours closer than this (RGB distance) are the same colour written differently. */
const COLOR_TOLERANCE = 24
const SHOWN = 8

export interface PageFeatures {
  colors: string[]
  fonts: string[]
  headings: string[]
  links: string[]
  actions: string[]
  images: number
  sentences: string[]
}

export interface Dimension {
  name: string
  matched: number
  total: number
  missing: string[]
  note?: string
}

// ---------------------------------------------------------------------------
// What a page's look is made of
// ---------------------------------------------------------------------------

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

/** Every literal colour in the CSS, most used first, as #rrggbb. */
export function cssColors(css: string): string[] {
  const counts = new Map<string, number>()
  const add = (color: string) => counts.set(color, (counts.get(color) ?? 0) + 1)
  for (const match of css.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})(?![0-9a-f])/gi)) {
    const value = match[1]!.toLowerCase()
    add(value.length === 3 ? `#${[...value].map((c) => c + c).join('')}` : `#${value}`)
  }
  for (const match of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) add(hex(Number(match[1]), Number(match[2]), Number(match[3])))
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([color]) => color)
}

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'emoji'])

/** Named font families the CSS asks for (generic fallbacks left out), plus Google Fonts the page links. */
export function cssFonts(css: string, html: string): string[] {
  const fonts = new Set<string>()
  for (const match of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().replace(/^["']|["']$/g, '').replace(/\s*!important$/i, '').toLowerCase()
      if (name && !GENERIC_FONTS.has(name) && !name.startsWith('var(')) fonts.add(name)
    }
  }
  for (const match of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi)) {
    for (const family of decodeEntities(match[1]!).matchAll(/family=([^&:]+)/g)) fonts.add(decodeURIComponent(family[1]!.replace(/\+/g, ' ')).toLowerCase())
  }
  return [...fonts]
}

function clean(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function elementTexts(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi'))].map((match) => clean(match[1]!)).filter(Boolean)
}

/** The parts of a page its look and content are made of. `css` is every stylesheet and inline style, concatenated. */
export function pageFeatures(html: string, css: string): PageFeatures {
  const body = html.replace(/<(script|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
  const styleAttributes = [...body.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((match) => match[1]).join(';')
  const allCss = `${css}\n${styleAttributes}`
  const headings = [...body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)].map((match) => clean(match[2]!)).filter(Boolean)
  const links = elementTexts(body, 'a').filter((text) => text.length <= 40)
  const buttons = elementTexts(body, 'button')
  const actionLinks = [...body.matchAll(/<a\b[^>]*class\s*=\s*["'][^"']*\b(?:btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/a\s*>/gi)].map((match) => clean(match[1]!))
  const sentences = htmlToText(body)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length >= 20)
  return {
    colors: cssColors(allCss),
    fonts: cssFonts(allCss, html),
    headings,
    links: [...new Set(links)],
    actions: [...new Set([...buttons, ...actionLinks].filter(Boolean))],
    images: (body.match(/<img\b/gi) ?? []).length,
    sentences: [...new Set(sentences)],
  }
}

// ---------------------------------------------------------------------------
// How close the copy is
// ---------------------------------------------------------------------------

function rgb(color: string): [number, number, number] {
  return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16)) as [number, number, number]
}

function near(a: string, b: string): boolean {
  const [r1, g1, b1] = rgb(a)
  const [r2, g2, b2] = rgb(b)
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2) <= COLOR_TOLERANCE
}

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function coverage(name: string, original: string[], copy: string[], same: (a: string, b: string) => boolean = (a, b) => norm(a) === norm(b)): Dimension {
  const missing = original.filter((item) => !copy.some((other) => same(item, other)))
  return { name, matched: original.length - missing.length, total: original.length, missing }
}

/** The order the copy's headings come in, against the original's, for the headings both have. */
function outOfOrder(original: string[], copy: string[]): boolean {
  const shared = original.map(norm).filter((heading) => copy.some((other) => norm(other) === heading))
  const positions = shared.map((heading) => copy.findIndex((other) => norm(other) === heading))
  return positions.some((position, index) => index > 0 && position < positions[index - 1]!)
}

export function compareFeatures(original: PageFeatures, copy: PageFeatures): Dimension[] {
  // The palette is the colours that carry the design, not every one-off shade.
  const palette = original.colors.slice(0, 12)
  const headings = coverage('headings', original.headings, copy.headings)
  if (outOfOrder(original.headings, copy.headings)) headings.note = 'the headings both pages share come in a different order'
  const textCopy = copy.sentences.map(norm).join(' \n ')
  const text = coverage('text', original.sentences, copy.sentences, (sentence) => textCopy.includes(norm(sentence)))
  const images: Dimension = { name: 'images', matched: Math.min(original.images, copy.images), total: original.images, missing: original.images > copy.images ? [`${original.images - copy.images} fewer <img> than the original's ${original.images}`] : [] }
  return [
    coverage('colors', palette, copy.colors, near),
    coverage('fonts', original.fonts, copy.fonts),
    headings,
    coverage('navigation and links', original.links, copy.links),
    coverage('buttons and calls to action', original.actions, copy.actions),
    images,
    text,
  ]
}

export function renderComparison(originalLabel: string, copyLabel: string, dimensions: Dimension[], original: PageFeatures): string {
  const scored = dimensions.filter((dimension) => dimension.total > 0)
  const overall = scored.length === 0 ? 0 : Math.round((100 * scored.reduce((sum, dimension) => sum + dimension.matched / dimension.total, 0)) / scored.length)
  const lines = [`Likeness of ${copyLabel} to ${originalLabel}: ${overall}% (average over ${scored.length} measured parts)`]
  for (const dimension of dimensions) {
    if (dimension.total === 0) {
      lines.push(`- ${dimension.name}: the original has none`)
      continue
    }
    const shown = dimension.missing.slice(0, SHOWN).map((item) => (item.length > 80 ? `${item.slice(0, 77)}...` : item))
    const more = dimension.missing.length > SHOWN ? ` (+${dimension.missing.length - SHOWN} more)` : ''
    const missing = shown.length > 0 ? ` — missing: ${shown.join(' | ')}${more}` : ''
    lines.push(`- ${dimension.name}: ${dimension.matched}/${dimension.total}${missing}${dimension.note ? ` — ${dimension.note}` : ''}`)
  }
  if (original.sentences.length === 0 && original.headings.length === 0) {
    lines.push('The original has almost no text in its HTML: it is probably drawn by JavaScript, so this comparison sees little of it. Use the browser tool to look at the rendered page.')
  }
  lines.push('Compared from source: colours, fonts, headings, links, buttons, image count and text. Spacing, layout and anything drawn by scripts are not measured — check those in the preview.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Reading both sides
// ---------------------------------------------------------------------------

async function fetchText(url: URL, limit: number): Promise<{ text: string; url: URL; html: boolean }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const fetched = await fetchFollowingRedirects(url, controller.signal)
    const text = fetched.response.body ? await readBoundedOutput(fetched.response.body, limit) : ''
    return { text, url: fetched.url, html: (fetched.response.headers.get('content-type') ?? '').includes('html') }
  } finally {
    clearTimeout(timeout)
  }
}

function inlineStyles(html: string): string {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((match) => match[1]).join('\n')
}

async function readOriginal(raw: string): Promise<{ html: string; css: string; label: string; unread: string[] }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`original must be an http(s) URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`original must be an http(s) URL: ${raw}`)
  const page = await fetchText(url, MAX_PAGE_CHARS)
  if (!page.html) throw new Error(`${raw} did not return an HTML page`)
  const sheets = stylesheetUrls(page.text, page.url)
  const unread: string[] = []
  const css = await Promise.all(sheets.map(async (sheet) => {
    try {
      return (await fetchText(new URL(sheet), MAX_STYLESHEET_CHARS)).text
    } catch {
      unread.push(sheet)
      return ''
    }
  }))
  return { html: page.text, css: [inlineStyles(page.text), ...css].join('\n'), label: page.url.toString(), unread }
}

async function readLocalFile(path: string): Promise<string> {
  assertSafeFileAccess(path)
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`${path} does not exist`)
  return (await file.text()).slice(0, MAX_PAGE_CHARS)
}

async function readCopy(raw: string): Promise<{ html: string; css: string; label: string; unread: string[] }> {
  const path = resolveWorkspacePath(raw)
  const html = await readLocalFile(path)
  const unread: string[] = []
  const css: string[] = [inlineStyles(html)]
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) continue
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    const value = href?.[1] ?? href?.[2] ?? href?.[3]
    // A sheet from the web (a font, a CDN framework) is not part of what was written here.
    if (!value || /^(?:[a-z]+:)?\/\//i.test(value)) continue
    const sheet = resolve(dirname(path), decodeEntities(value).split(/[?#]/)[0]!)
    try {
      css.push((await readLocalFile(resolveWorkspacePath(sheet))).slice(0, MAX_STYLESHEET_CHARS))
    } catch {
      unread.push(value)
    }
  }
  return { html, css: css.join('\n'), label: raw, unread }
}

export const comparePageTool: Tool = {
  name: 'compare_page',
  description:
    'Measure how closely a local copy of a web page matches the original: colours, fonts, the heading outline and its order, navigation, buttons and calls to action, images, and text, each scored with what the copy is missing. ' +
    'Use it whenever you copy, recreate, clone or match an existing site, before saying the copy is done, and again after each fix. It compares source, not pixels.',
  input_schema: {
    type: 'object',
    properties: {
      original: { type: 'string', description: 'The original page, an http(s) URL.' },
      copy: { type: 'string', description: 'The local HTML file of the copy (its linked local stylesheets are read too).' },
    },
    required: ['original', 'copy'],
  },
  async execute(input) {
    if (typeof input.original !== 'string' || !input.original.trim()) throw new Error('original must be a non-empty URL')
    if (typeof input.copy !== 'string' || !input.copy.trim()) throw new Error('copy must be a non-empty file path')
    let original: Awaited<ReturnType<typeof readOriginal>>
    try {
      original = await readOriginal(input.original.trim())
    } catch (error) {
      throw new Error(`compare_page could not read the original: ${error instanceof Error ? error.message : String(error)}`)
    }
    const copy = await readCopy(input.copy.trim())
    const originalFeatures = pageFeatures(original.html, original.css)
    const report = renderComparison(original.label, copy.label, compareFeatures(originalFeatures, pageFeatures(copy.html, copy.css)), originalFeatures)
    const unread = [...original.unread.map((sheet) => `original ${sheet}`), ...copy.unread.map((sheet) => `copy ${sheet}`)]
    return unread.length > 0 ? `${report}\nStylesheets that could not be read (their colours and fonts are not counted): ${unread.join(', ')}` : report
  },
}
