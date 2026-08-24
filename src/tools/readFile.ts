import type { Tool } from './types.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess } from '../autonomy/sensitivePaths.ts'

const MAX_READ_BYTES = 5_000_000
const DEFAULT_LIMIT = 2000

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a file, returned with 1-indexed line numbers prefixed to each line. Returns the whole file by default (up to 2000 lines); pass offset/limit to window into one section of a large file rather than paying for all of it.',
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
    if (file.size > MAX_READ_BYTES) throw new Error(`file exceeds ${MAX_READ_BYTES} bytes; use a narrower search or inspect it with a specialized tool`)
    const text = await file.text()
    const allLines = text.split('\n')
    const offset = (input.offset as number | undefined) ?? 1
    const limit = (input.limit as number | undefined) ?? DEFAULT_LIMIT
    const start = offset - 1
    const window = allLines.slice(start, start + limit)
    if (start > 0 && window.length === 0) throw new Error(`offset ${offset} is past the end of the file (${allLines.length} lines)`)

    const rendered = window.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
    const remaining = allLines.length - (start + window.length)
    // Tell the model how to continue rather than letting it assume it saw everything.
    return remaining > 0 ? `${rendered}\n\n[${remaining} more line(s); pass offset ${start + window.length + 1} to continue]` : rendered
  },
}
