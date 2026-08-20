import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { resolvePath } from '../autonomy/context.ts'

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
    if (typeof input.path !== 'string' || input.path.length === 0) {
      throw new Error('edit_file requires a non-empty "path" string argument.')
    }
    if (typeof input.old_string !== 'string' || input.old_string.length === 0) {
      throw new Error('edit_file requires a non-empty "old_string" string argument.')
    }
    if (typeof input.new_string !== 'string') {
      throw new Error('edit_file requires a "new_string" string argument (use an empty string to delete old_string).')
    }
    const path = resolvePath(input.path)
    const oldString = input.old_string
    const newString = input.new_string

    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${input.path}`)
    }
    const text = await file.text()

    const firstIndex = text.indexOf(oldString)
    if (firstIndex === -1) {
      throw new Error(`old_string not found in ${input.path}`)
    }
    const lastIndex = text.lastIndexOf(oldString)
    if (firstIndex !== lastIndex) {
      throw new Error(
        `old_string matches multiple locations in ${input.path} — include more surrounding context to make it unique`,
      )
    }

    const updated = text.slice(0, firstIndex) + newString + text.slice(firstIndex + oldString.length)
    await captureBeforeWrite(path)
    await Bun.write(path, updated)
    return `Edited ${input.path}`
  },
}
