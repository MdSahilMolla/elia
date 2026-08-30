import { readFile } from 'node:fs/promises'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { resolveWorkspacePath, currentAgent } from '../autonomy/context.ts'
import { diagnosticsForFile, formatDiagnostics } from '../lsp/registry.ts'
import { diffStat, fencedDiff, unifiedDiff } from '../ui/diff.ts'
import { multipleMatchMessage, notFoundMessage } from './editMatch.ts'
import { noteFileRead } from './fileAccess.ts'
import { atomicWrite } from './atomicWrite.ts'

function detectLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** The model virtually always writes \n in tool-call strings, even when the file on disk is \r\n (common on Windows) — normalize to the file's real line ending so a semantically-identical old_string still matches. */
function toLineEnding(text: string, ending: '\n' | '\r\n'): string {
  const normalized = text.replace(/\r\n/g, '\n')
  return ending === '\n' ? normalized : normalized.replace(/\n/g, '\r\n')
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    "Replace an exact substring within a file with new text. By default old_string must be unique — include enough surrounding lines to make it so, matching the file's real indentation (copy it from a read_file). Pass replace_all:true to change every occurrence (e.g. renaming a symbol).",
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'Exact text to find (must be unique unless replace_all is true)' },
      new_string: { type: 'string', description: 'Text to replace it with' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match (default false)' },
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
    // `Bun.file().text()` silently strips a leading UTF-8 BOM, so editing a
    // BOM-prefixed file (common for Windows-authored source) through it would
    // drop the BOM on write — a change the edit never asked for. `fs.readFile`
    // preserves every byte.
    const text = await readFile(path, 'utf8')
    noteFileRead(path)
    const ending = detectLineEnding(text)
    const oldString = toLineEnding(input.old_string, ending)
    const newString = toLineEnding(input.new_string, ending)

    const replaceAll = input.replace_all === true
    const firstIndex = text.indexOf(oldString)
    if (firstIndex === -1) {
      throw new Error(notFoundMessage(text, oldString, input.path))
    }
    const lastIndex = text.lastIndexOf(oldString)
    if (!replaceAll && firstIndex !== lastIndex) {
      throw new Error(multipleMatchMessage(text, oldString, input.path))
    }

    const updated = replaceAll
      ? text.split(oldString).join(newString)
      : text.slice(0, firstIndex) + newString + text.slice(firstIndex + oldString.length)

    // Re-read immediately before writing and compare to what this edit was
    // computed from. Elia's own repo is routinely edited by a concurrent
    // process mid-session — a naive read-then-write can silently discard
    // someone else's change. Narrow, not perfect: still a real race between
    // this check and the write below, but it closes the actually-observed
    // window (minutes of "thinking" time) rather than the theoretical one
    // (microseconds).
    const current = await readFile(path, 'utf8')
    if (current !== text) {
      throw new Error(`${input.path} changed on disk since it was read — read it again before editing.`)
    }

    // Last check before the mutation: if the run was cancelled while this edit
    // was being computed, stop here rather than landing a write the operator
    // just asked to abort.
    if (currentAgent().signal?.aborted) {
      throw new Error('Edit cancelled before writing — the run was aborted.')
    }

    await captureBeforeWrite(path)
    await atomicWrite(path, updated)

    const root = currentAgent().cwd ?? process.cwd()
    const diagnostics = await diagnosticsForFile(path, updated, root)
    // A real unified patch against the whole file: correct line numbers, proper
    // hunk context, and applyable as-is — computed on \n-normalized text so the
    // patch reads cleanly regardless of the file's on-disk line ending.
    const diff = unifiedDiff(text.replace(/\r\n/g, '\n'), updated.replace(/\r\n/g, '\n'), input.path)
    return `Edited ${input.path} (${diffStat(diff)})\n${fencedDiff(diff)}${diagnostics ? formatDiagnostics(diagnostics, input.path) : ''}`
  },
}
