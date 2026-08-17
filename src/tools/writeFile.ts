import type { Tool } from './types.ts'

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
    const path = input.path as string
    const content = input.content as string
    await Bun.write(path, content)
    return `Wrote ${content.length} bytes to ${path}`
  },
}
