import { expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { looksLikePdf, pdfToText, thinExtractionReason } from './pdfText.ts'

/**
 * Synthetic PDFs rather than fixtures: the extractor scans for content streams
 * and text operators, so a hand-built file exercises exactly the paths that
 * matter and each test says which construct it is about.
 */
function pdf(streams: { body: Buffer | string; flate?: boolean }[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')]
  for (const { body, flate } of streams) {
    const payload = flate ? deflateSync(Buffer.from(body as string, 'latin1')) : Buffer.from(body as never, 'latin1')
    parts.push(Buffer.from(`<< /Length ${payload.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'))
    parts.push(payload)
    parts.push(Buffer.from('\nendstream\n', 'latin1'))
  }
  parts.push(Buffer.from('%%EOF\n', 'latin1'))
  return new Uint8Array(Buffer.concat(parts))
}

test('a PDF is recognised by its header, and other bytes are not', () => {
  expect(looksLikePdf(pdf([{ body: '' }]))).toBe(true)
  expect(looksLikePdf(new TextEncoder().encode('<html><body>not a pdf</body></html>'))).toBe(false)
})

test('text is extracted from an uncompressed content stream', () => {
  const out = pdfToText(pdf([{ body: 'BT /F1 12 Tf 72 720 Td (Attention Is All You Need) Tj ET' }]))
  expect(out.text).toBe('Attention Is All You Need')
})

test('text is extracted from a FlateDecode stream', () => {
  // The common case: essentially every real paper compresses its content.
  const out = pdfToText(pdf([{ body: 'BT (Neural networks scale predictably) Tj ET', flate: true }]))
  expect(out.text).toContain('Neural networks scale predictably')
})

test('a TJ array turns large negative kerning back into word spaces', () => {
  // Without this, justified text comes out asasinglerunofwords.
  const out = pdfToText(pdf([{ body: 'BT [(Large) -300 (language) -300 (models)] TJ ET' }]))
  expect(out.text).toBe('Large language models')
})

test('small kerning inside a word is not mistaken for a space', () => {
  const out = pdfToText(pdf([{ body: 'BT [(Trans) -20 (former)] TJ ET' }]))
  expect(out.text).toBe('Transformer')
})

test('hex strings and escaped literals decode', () => {
  expect(pdfToText(pdf([{ body: 'BT <48656C6C6F> Tj ET' }])).text).toBe('Hello')
  // \( is a literal paren; \101 is octal for "A".
  expect(pdfToText(pdf([{ body: 'BT (a \\(b\\) \\101) Tj ET' }])).text).toBe('a (b) A')
})

test('words hyphenated across a line break are rejoined', () => {
  const out = pdfToText(pdf([{ body: 'BT (transfor-) Tj T* (mer architecture) Tj ET' }]))
  expect(out.text).toContain('transformer architecture')
})

test('a stream that will not inflate is skipped without losing the rest', () => {
  const broken = { body: Buffer.from([0x78, 0x9c, 0x00, 0x01, 0x02, 0x03]) as unknown as string, flate: false }
  const out = pdfToText(pdf([broken, { body: 'BT (the readable part) Tj ET' }]))
  expect(out.text).toContain('the readable part')
})

test('an image-only PDF is reported as needing OCR, not as an empty document', () => {
  // The dangerous outcome: a scanned paper returning "" and being read as a
  // paper with no content.
  const scanned = pdfToText(pdf([{ body: 'q 612 0 0 792 0 0 cm /Im1 Do Q' }]))
  expect(scanned.streams).toBeGreaterThan(0)
  expect(thinExtractionReason(scanned)).toContain('OCR')
})

test('a file with no readable streams is reported as encrypted or not a PDF', () => {
  const empty = pdfToText(new TextEncoder().encode('%PDF-1.7\n%%EOF\n'))
  expect(empty.streams).toBe(0)
  expect(thinExtractionReason(empty)).toContain('encrypted')
})

test('a substantial extraction reports no problem', () => {
  const long = pdfToText(pdf([{ body: `BT (${'real paper text '.repeat(40)}) Tj ET` }]))
  expect(thinExtractionReason(long)).toBeUndefined()
})
