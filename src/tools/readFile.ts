import type { Tool } from './types.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess } from '../autonomy/sensitivePaths.ts'
import { noteFileRead } from './fileAccess.ts'

const MAX_READ_BYTES = 5_000_000
const DEFAULT_LIMIT = 2000
/** A windowed read of an over-limit file never buffers more than this. */
const WINDOW_BYTE_CEILING = 512 * 1024
const WINDOW_LINE_CEILING = 2000

/**
 * Streams `path` and returns the lines `[offset, offset+limit)` (1-indexed),
 * without ever holding more than WINDOW_BYTE_CEILING in memory. Used to let the
 * model inspect a slice of a file too large to read whole.
 */
async function readLineWindow(
  path: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; startLine: number; reachedByteCeiling: boolean }> {
  const cappedLimit = Math.min(limit, WINDOW_LINE_CEILING)
  const stream = Bun.file(path).stream()
  const decoder = new TextDecoder()
  let carry = ''
  let lineNo = 0
  let collectedBytes = 0
  const collected: string[] = []
  let reachedByteCeiling = false

  const consider = (line: string): boolean => {
    lineNo += 1
    if (lineNo < offset) return true
    if (collected.length >= cappedLimit) return false
    if (collectedBytes + line.length > WINDOW_BYTE_CEILING) {
      reachedByteCeiling = true
      return false
    }
    collected.push(line)
    collectedBytes += line.length + 1
    return true
  }

  outer: for await (const chunk of stream) {
    // Streaming to the offset is cheap; only the returned window is capped.
    carry += decoder.decode(chunk, { stream: true })
    const parts = carry.split('\n')
    carry = parts.pop() ?? ''
    for (const line of parts) {
      if (!consider(line)) break outer
    }
  }
  if (carry.length > 0 && collected.length < cappedLimit && !reachedByteCeiling) consider(carry)

  return { lines: collected, startLine: Math.max(offset, 1), reachedByteCeiling }
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a file, returned with 1-indexed line numbers prefixed to each line. Returns the whole file by default (up to 2000 lines); pass offset/limit to window into one section of a large file rather than paying for all of it. A file over 5 MB can only be read in windows — pass both offset and limit.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read' },
      offset: { type: 'number', description: 'First line to return, 1-indexed (default: 1)' },
      limit: { type: 'number', description: `Maximum number of lines to return (default: ${DEFAULT_LIMIT})` },
    },
    required: ['path'],
  },
  async execute(input) {
    if (typeof input.path !== 'string' || input.path.trim().length === 0) throw new Error('path must be a non-empty string')
    if (input.offset !== undefined && (typeof input.offset !== 'number' || !Number.isInteger(input.offset) || input.offset < 1)) throw new Error('offset must be a positive integer when provided')
    if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1)) throw new Error('limit must be a positive integer when provided')
    const path = resolveWorkspacePath(input.path)
    assertSafeFileAccess(path)
    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`)
    }
    const offset = (input.offset as number | undefined) ?? 1
    const limit = (input.limit as number | undefined) ?? DEFAULT_LIMIT

    if (file.size > MAX_READ_BYTES) {
      // A bare read of a huge file is still refused — dumping it would blow the
      // context window — but an explicit window into it is served by streaming.
      if (input.offset === undefined || input.limit === undefined) {
        throw new Error(
          `file is ${file.size} bytes (over the ${MAX_READ_BYTES}-byte whole-file limit); ` +
            `pass both offset and limit to read a window of it, or narrow with grep`,
        )
      }
      const { lines, startLine, reachedByteCeiling } = await readLineWindow(path, offset, limit)
      noteFileRead(path)
      if (lines.length === 0) throw new Error(`offset ${offset} is past the readable window of this ${file.size}-byte file`)
      const body = lines.map((line, i) => `${startLine + i}\t${line}`).join('\n')
      const note = reachedByteCeiling
        ? `\n\n[window stopped at ${WINDOW_BYTE_CEILING} bytes; pass a larger offset to continue past line ${startLine + lines.length - 1}]`
        : `\n\n[windowed read of a ${file.size}-byte file; pass offset ${startLine + lines.length} to continue]`
      return `${body}${note}`
    }

    const text = await file.text()
    noteFileRead(path)
    const allLines = text.split('\n')
    const start = offset - 1
    const window = allLines.slice(start, start + limit)
    if (start > 0 && window.length === 0) throw new Error(`offset ${offset} is past the end of the file (${allLines.length} lines)`)

    const rendered = window.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
    const remaining = allLines.length - (start + window.length)
    // Tell the model how to continue rather than letting it assume it saw everything.
    return remaining > 0 ? `${rendered}\n\n[${remaining} more line(s); pass offset ${start + window.length + 1} to continue]` : rendered
  },
}
