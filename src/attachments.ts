import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'
import type { ImageMediaType } from './providers/types.ts'

/**
 * Image attachments for a prompt. Elia's message model has always been
 * text-only; this module is the seam that lets a user hand the model a
 * screenshot — either explicitly (`/attach <path>`) or by pasting / dragging an
 * image file into the terminal, which every OS turns into a path string in the
 * input line. It reads the file, checks it really is one of the four image
 * types the vision-capable providers accept, and base64-encodes it into an
 * `image` content block. Providers that can't take images fall back to a text
 * marker built from `alt` (see the provider adapters).
 */

/** One resolved, encoded image ready to become an `image` content block. */
export interface ImageAttachment {
  mediaType: ImageMediaType
  /** Raw file bytes, base64-encoded. */
  data: string
  /** Human label — the original filename — kept for the transcript and text-only providers. */
  alt: string
  /** Decoded byte length, for the "attached (1.2 MB)" notice. */
  bytes: number
}

/**
 * The Anthropic Messages API rejects an image over 5 MB and the other adapters
 * inline it as a data URL, so keep the ceiling here. A screenshot that large is
 * almost always a mistake (an un-cropped 5K capture); the caller surfaces the
 * error rather than silently sending something that will 400.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const
const EXT = String.raw`\.(?:png|jpe?g|gif|webp)`
/**
 * Matches a path-ish token ending in an image extension, covering the forms a
 * terminal produces when a file is pasted or dragged in: a double- or
 * single-quoted path, a `file://` URI, or a bare path (with POSIX
 * backslash-escaped spaces). Used both as a cheap disk-free pre-check and to
 * pull the tokens out for loading.
 */
const IMAGE_TOKEN = new RegExp(
  [
    String.raw`"[^"]*${EXT}"`,
    String.raw`'[^']*${EXT}'`,
    String.raw`file:\/\/[^\s"']*${EXT}`,
    String.raw`(?:[^\s"']|\\ )+${EXT}(?=$|[\s"'),])`,
  ].join('|'),
  'gi',
)

/** Sniffs the media type from the file's magic bytes — never trusts the extension. */
export function sniffMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (
    b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp'
  }
  return undefined
}

/** Quick, disk-free check: does this line contain something that looks like an image-file path? */
export function looksLikeImageAttachmentLine(line: string): boolean {
  IMAGE_TOKEN.lastIndex = 0
  return IMAGE_TOKEN.test(line)
}

/** `~` / `~/…` → the user's home directory; everything else is left to `path.resolve`. */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2))
  return p
}

/** Turns whatever the terminal dropped into the line — `file://` URI, quoted, backslash-escaped spaces — into a real path. */
function normalizeToken(token: string): string {
  let t = token.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1)
  if (t.startsWith('file://')) {
    try {
      t = decodeURIComponent(new URL(t).pathname)
      // file:///C:/x -> /C:/x on Windows; strip the leading slash.
      if (/^\/[a-z]:/i.test(t)) t = t.slice(1)
    } catch {
      /* fall through with the raw token */
    }
  }
  // POSIX drag-and-drop escapes spaces as "\ "; Windows uses "\" as a separator, so only unescape elsewhere.
  if (process.platform !== 'win32') t = t.replace(/\\ /g, ' ')
  return expandHome(t)
}

function hasImageExtension(p: string): boolean {
  const lower = p.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Reads and encodes one image path. Returns a string on failure — a message fit to show the user. */
export async function loadImageAttachment(rawPath: string, cwd = process.cwd()): Promise<ImageAttachment | string> {
  const normalized = normalizeToken(rawPath)
  if (!hasImageExtension(normalized)) return `${rawPath}: not a .png/.jpg/.gif/.webp file`
  const absolute = isAbsolute(normalized) ? normalized : resolve(cwd, normalized)

  let bytes: Buffer
  try {
    bytes = await readFile(absolute)
  } catch {
    return `${rawPath}: no such file`
  }
  if (bytes.byteLength === 0) return `${rawPath}: file is empty`
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return `${rawPath}: ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit — crop or downscale it first`
  }
  const mediaType = sniffMediaType(bytes)
  if (!mediaType) return `${rawPath}: not a PNG, JPEG, GIF, or WebP image`

  return { mediaType, data: bytes.toString('base64'), alt: basename(absolute), bytes: bytes.byteLength }
}

/** The result of pulling image paths out of a submitted prompt line. */
export interface ResolvedAttachments {
  /** The line with every successfully-attached path token removed. */
  text: string
  images: ImageAttachment[]
  /** One line per path that looked like an image but could not be attached — surfaced to the user, left in `text`. */
  errors: string[]
}

/**
 * Scans a prompt line for image-path tokens, loads the ones that resolve to a
 * real image, and strips only those from the text. A token that looks like an
 * image path but fails to load is left in place (it might be a genuine typo the
 * user wants to see) and reported in `errors`.
 *
 * `scanRegion`, when given, is the substring to look for paths in (e.g. only
 * the part the user actually typed, excluding machine-generated context that
 * was prepended to the turn); tokens are still stripped from the full `line`.
 */
export async function resolveInlineAttachments(
  line: string,
  cwd = process.cwd(),
  scanRegion = line,
): Promise<ResolvedAttachments> {
  const matches = scanRegion.match(IMAGE_TOKEN)
  if (!matches) return { text: line, images: [], errors: [] }

  const images: ImageAttachment[] = []
  const errors: string[] = []
  let text = line
  for (const token of matches) {
    const loaded = await loadImageAttachment(token, cwd)
    if (typeof loaded === 'string') {
      errors.push(loaded)
      continue
    }
    images.push(loaded)
    text = text.replace(token, '')
  }
  return { text: text.replace(/[ \t]{2,}/g, ' ').trim(), images, errors }
}

/** "1.2 MB", "840 KB" — for the attach confirmation notice. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
