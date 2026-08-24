import type { Tool } from './types.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess } from '../autonomy/sensitivePaths.ts'

const MAX_READ_BYTES = 5_000_000

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a file, returned with 1-indexed line numbers prefixed to each line.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read' },
    },
    required: ['path'],
  },
  async execute(input) {
    if (typeof input.path !== 'string' || input.path.trim().length === 0) throw new Error('path must be a non-empty string')
    const path = resolveWorkspacePath(input.path)
    assertSafeFileAccess(path)
    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`)
    }
    if (file.size > MAX_READ_BYTES) throw new Error(`file exceeds ${MAX_READ_BYTES} bytes; use a narrower search or inspect it with a specialized tool`)
    const text = await file.text()
    const lines = text.split('\n')
    return lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
  },
}
