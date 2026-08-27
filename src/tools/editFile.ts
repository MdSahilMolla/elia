import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { resolveWorkspacePath, currentAgent } from '../autonomy/context.ts'
import { diagnosticsForFile, formatDiagnostics } from '../lsp/registry.ts'

function detectLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** The model virtually always writes \n in tool-call strings, even when the file on disk is \r\n (common on Windows) — normalize to the file's real line ending so a semantically-identical old_string still matches. */
function toLineEnding(text: string, ending: '\n' | '\r\n'): string {
  const normalized = text.replace(/\r\n/g, '\n')
  return ending === '\n' ? normalized : normalized.replace(/\n/g, '\r\n')
}

function diffPreview(oldString: string, newString: string): string {
  const shorten = (line: string) => (line.length > 240 ? `${line.slice(0, 240)}...` : line)
  const removed = oldString.split('\n').slice(0, 6).map((line) => `-${shorten(line)}`)
  const added = newString.split('\n').slice(0, 6).map((line) => `+${shorten(line)}`)
  return ['```diff', ...removed, ...added, '```'].join('\n')
}

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
    if (input.old_string === input.new_string) {
      throw new Error('old_string and new_string are identical — nothing to change.')
    }
    const path = resolveWorkspacePath(input.path)

    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${input.path}`)
    }
    const text = await file.text()
    const ending = detectLineEnding(text)
    const oldString = toLineEnding(input.old_string, ending)
    const newString = toLineEnding(input.new_string, ending)

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

    // Re-read immediately before writing and compare to what this edit was
    // computed from. Elia's own repo is routinely edited by a concurrent
    // process mid-session — a naive read-then-write can silently discard
    // someone else's change. Narrow, not perfect: still a real race between
    // this check and the write below, but it closes the actually-observed
    // window (minutes of "thinking" time) rather than the theoretical one
    // (microseconds).
    const current = await file.text()
    if (current !== text) {
      throw new Error(`${input.path} changed on disk since it was read — read it again before editing.`)
    }

    await captureBeforeWrite(path)
    await Bun.write(path, updated)

    const root = currentAgent().cwd ?? process.cwd()
    const diagnostics = await diagnosticsForFile(path, updated, root)
    return `Edited ${input.path}\n${diffPreview(oldString, newString)}${diagnostics ? formatDiagnostics(diagnostics, input.path) : ''}`
  },
}
