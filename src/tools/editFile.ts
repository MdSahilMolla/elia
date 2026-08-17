import type { Tool } from './types.ts'

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact, unique substring within a file with new text. Fails if old_string is not found or matches more than once — include enough surrounding context to make it unique.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
      new_string: { type: 'string', description: 'Text to replace it with' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input) {
    const path = input.path as string
    const oldString = input.old_string as string
    const newString = input.new_string as string

    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`)
    }
    const text = await file.text()

    const firstIndex = text.indexOf(oldString)
    if (firstIndex === -1) {
      throw new Error(`old_string not found in ${path}`)
    }
    const lastIndex = text.lastIndexOf(oldString)
    if (firstIndex !== lastIndex) {
      throw new Error(
        `old_string matches multiple locations in ${path} — include more surrounding context to make it unique`,
      )
    }

    const updated = text.slice(0, firstIndex) + newString + text.slice(firstIndex + oldString.length)
    await Bun.write(path, updated)
    return `Edited ${path}`
  },
}
