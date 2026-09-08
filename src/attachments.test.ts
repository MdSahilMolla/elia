import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatBytes,
  loadImageAttachment,
  looksLikeImageAttachmentLine,
  MAX_IMAGE_BYTES,
  resolveInlineAttachments,
  sniffMediaType,
} from './attachments.ts'

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const GIF_HEADER = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
const WEBP_HEADER = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

test('sniffMediaType reads the magic bytes, not the extension', () => {
  expect(sniffMediaType(PNG_HEADER)).toBe('image/png')
  expect(sniffMediaType(JPEG_HEADER)).toBe('image/jpeg')
  expect(sniffMediaType(GIF_HEADER)).toBe('image/gif')
  expect(sniffMediaType(WEBP_HEADER)).toBe('image/webp')
  expect(sniffMediaType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeUndefined()
})

test('looksLikeImageAttachmentLine spots the terminal paste/drag forms', () => {
  expect(looksLikeImageAttachmentLine('/home/me/Pictures/shot.png')).toBe(true)
  expect(looksLikeImageAttachmentLine('look at "C:\\Users\\me\\a screenshot.jpg"')).toBe(true)
  expect(looksLikeImageAttachmentLine('file:///tmp/x.webp')).toBe(true)
  expect(looksLikeImageAttachmentLine('/home/me/Desktop/Screen\\ Shot.png')).toBe(true)
  expect(looksLikeImageAttachmentLine('just a normal sentence about a png file')).toBe(false)
  expect(looksLikeImageAttachmentLine('/model')).toBe(false)
})

test('resolveInlineAttachments loads a real image and strips its path from the text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elia-attach-'))
  const file = join(dir, 'diagram.png')
  await writeFile(file, PNG_HEADER)

  // A quoted path is what a terminal produces when a file with spaces in its
  // path is dragged in (and quoting is the only unambiguous inline form).
  const result = await resolveInlineAttachments(`what is wrong in "${file}" exactly?`)
  expect(result.images).toHaveLength(1)
  expect(result.images[0]).toMatchObject({ mediaType: 'image/png', alt: 'diagram.png' })
  expect(result.images[0]!.data).toBe(Buffer.from(PNG_HEADER).toString('base64'))
  expect(result.text).toBe('what is wrong in exactly?')
  expect(result.errors).toEqual([])
})

test('a path that looks like an image but does not exist is reported and left in the text', async () => {
  const result = await resolveInlineAttachments('check /no/such/file/nope.png please')
  expect(result.images).toEqual([])
  expect(result.text).toContain('nope.png')
  expect(result.errors[0]).toMatch(/no such file/)
})

test('a non-image file with an image extension is rejected by the magic-byte check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elia-attach-'))
  const file = join(dir, 'fake.png')
  await writeFile(file, 'this is plain text, not a PNG')

  const loaded = await loadImageAttachment(file)
  expect(typeof loaded).toBe('string')
  expect(loaded as string).toMatch(/not a PNG, JPEG, GIF, or WebP/)
})

test('an oversized image is refused with a helpful message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elia-attach-'))
  const file = join(dir, 'huge.png')
  const big = Buffer.concat([Buffer.from(PNG_HEADER), Buffer.alloc(MAX_IMAGE_BYTES)])
  await writeFile(file, big)

  const loaded = await loadImageAttachment(file)
  expect(loaded as string).toMatch(/exceeds the 5 MB limit/)
})

test('scanRegion confines the path search to what the user typed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elia-attach-'))
  const real = join(dir, 'real.png')
  await writeFile(real, PNG_HEADER)

  // The carried `!ls` output mentions other .png names that are not attachments.
  const line = `<output>\nold.png\nother.png\n</output>\n\ncompare with "${real}"`
  const typed = `compare with "${real}"`
  const result = await resolveInlineAttachments(line, process.cwd(), typed)

  expect(result.images).toHaveLength(1)
  expect(result.errors).toEqual([])
  expect(result.text).toContain('old.png') // untouched — outside the scan region
  expect(result.text).not.toContain('real.png')
})

test('formatBytes is human readable', () => {
  expect(formatBytes(500)).toBe('500 B')
  expect(formatBytes(2048)).toBe('2 KB')
  expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
})
