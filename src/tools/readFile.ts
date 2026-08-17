import type { Tool } from './types.ts'

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
    const path = input.path as string
    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`)
    }
    const text = await file.text()
    const lines = text.split('\n')
    return lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
  },
}
