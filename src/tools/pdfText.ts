import { inflateSync } from 'node:zlib'

/**
 * Best-effort text out of a PDF.
 *
 * `web_fetch` used to return any non-HTML body verbatim, so a PDF arrived as
 * undecoded binary and the model tried to read it. Research papers are almost
 * always PDFs, which made "read this paper" fail in the least useful way
 * available — a page of mojibake that looks like content.
 *
 * This is a deliberately small extractor, not a PDF implementation. It finds
 * content streams, inflates the Flate-compressed ones (Bun ships zlib, so no
 * dependency), and pulls the operands of the text-showing operators. That covers
 * the ordinary case — a LaTeX or word-processor PDF with embedded text — and
 * cleanly does not cover scanned images (no text to find), unusual filters, or
 * encryption. Those return little or nothing, and the caller is expected to say
 * so rather than present emptiness as an empty document.
 */

/** Streams past this many are almost certainly a pathological file, not a paper. */
const MAX_STREAMS = 5_000
/** Inflated bytes to accept in total, so a zip-bomb-shaped PDF cannot exhaust memory. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024

export function looksLikePdf(bytes: Uint8Array): boolean {
  // %PDF- at the head. Some files carry leading junk, so allow a small offset.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  return head.includes('%PDF-')
}

/** Every `stream`…`endstream` payload, inflated when it is Flate-compressed. */
function contentStreams(buffer: Buffer): string[] {
  const out: string[] = []
  let inflatedTotal = 0
  let cursor = 0
  while (out.length < MAX_STREAMS) {
    const start = buffer.indexOf('stream', cursor, 'latin1')
    if (start === -1) break
    const end = buffer.indexOf('endstream', start, 'latin1')
    if (end === -1) break

    // The dictionary immediately before `stream` says how the payload is encoded.
    const dictionary = buffer.toString('latin1', Math.max(0, start - 600), start)
    // Skip the EOL that must follow the `stream` keyword.
    let from = start + 'stream'.length
    if (buffer[from] === 0x0d) from += 1
    if (buffer[from] === 0x0a) from += 1
    const payload = buffer.subarray(from, end)
    cursor = end + 'endstream'.length

    if (/\/FlateDecode/.test(dictionary)) {
      try {
        const inflated = inflateSync(payload)
        inflatedTotal += inflated.byteLength
        if (inflatedTotal > MAX_INFLATED_BYTES) break
        out.push(inflated.toString('latin1'))
      } catch {
        // A stream that will not inflate is not text we can use — an image, a
        // font, or a filter chain this does not implement. Skip it silently;
        // failing the whole document over one stream would lose the rest.
      }
      continue
    }
    // Only uncompressed streams are usable as-is; anything else is binary.
    if (!/\/Filter/.test(dictionary)) {
      inflatedTotal += payload.byteLength
      if (inflatedTotal > MAX_INFLATED_BYTES) break
      out.push(payload.toString('latin1'))
    }
  }
  return out
}

/** Decode a PDF literal string body, resolving backslash escapes and octal codes. */
function decodeLiteral(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) break
    if (next === 'n') { out += '\n'; i += 1; continue }
    if (next === 'r') { out += '\r'; i += 1; continue }
    if (next === 't') { out += '\t'; i += 1; continue }
    if (next === 'b' || next === 'f') { i += 1; continue }
    if (next === '\n') { i += 1; continue } // line continuation
    if (next >= '0' && next <= '7') {
      const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1))?.[0] ?? ''
      out += String.fromCharCode(Number.parseInt(octal, 8))
      i += octal.length
      continue
    }
    out += next
    i += 1
  }
  return out
}

function decodeHex(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16))
  return out
}

/**
 * Text-showing operators in one content stream, in order.
 *
 * `Tj` and `'`/`"` show one string; `TJ` shows an array of strings interleaved
 * with kerning numbers. A large negative kern is how PDFs represent a word
 * space, so it is turned back into one — without that, extracted text comes out
 * asasinglerunofwords.
 */
function textFromStream(stream: string): string {
  let out = ''
  const operator = /\[((?:[^\][\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]*)>\s*(?:Tj|TJ)|(T\*|Td|TD)/g
  let match: RegExpExecArray | null
  while ((match = operator.exec(stream)) !== null) {
    if (match[1] !== undefined) {
      const parts = /\(((?:[^()\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g
      let piece: RegExpExecArray | null
      while ((piece = parts.exec(match[1])) !== null) {
        if (piece[1] !== undefined) out += decodeLiteral(piece[1])
        else if (piece[2] !== undefined && Number.parseFloat(piece[2]) <= -120) out += ' '
      }
      continue
    }
    if (match[2] !== undefined) { out += decodeLiteral(match[2]); continue }
    if (match[3] !== undefined) { out += decodeHex(match[3]); continue }
    // A positioning operator ends the current line.
    out += '\n'
  }
  return out
}

export interface PdfExtraction {
  text: string
  /** Content streams found, for reporting why a result is thin. */
  streams: number
}

export function pdfToText(bytes: Uint8Array): PdfExtraction {
  const buffer = Buffer.from(bytes)
  const streams = contentStreams(buffer)
  const text = streams
    .map(textFromStream)
    .join('\n')
    // Hyphenated line breaks from justified text put half-words on each line.
    .replace(/-\n(\p{Ll})/gu, '$1')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, streams: streams.length }
}

/**
 * Why an extraction came back thin, in words the caller can pass on.
 *
 * Returning "" for a scanned paper and "" for a network failure would look the
 * same to the model, which then reports an empty document as an empty document.
 */
export function thinExtractionReason(result: PdfExtraction): string | undefined {
  if (result.text.length >= 200) return undefined
  if (result.streams === 0) return 'no readable content streams — the file may be encrypted, or not really a PDF'
  return 'its pages carry no extractable text — this is almost certainly a scanned or image-only PDF, which needs OCR rather than text extraction'
}
