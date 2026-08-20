import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { resolvePath } from '../autonomy/context.ts'

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create a file or overwrite it entirely with new content. Creates parent directories as needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write' },
      content: { type: 'string', description: 'Full content to write to the file' },
    },
    required: ['path', 'content'],
  },
  async execute(input) {
    if (typeof input.path !== 'string' || input.path.length === 0) {
      throw new Error('write_file requires a non-empty "path" string argument.')
    }
    if (typeof input.content !== 'string') {
      throw new Error('write_file requires a "content" string argument (use an empty string for an empty file).')
    }
    const path = resolvePath(input.path)
    const content = input.content
    await captureBeforeWrite(path)
    await Bun.write(path, content)
    return `Wrote ${content.length} bytes to ${input.path}`
  },
}
