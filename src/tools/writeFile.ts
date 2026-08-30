import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { resolveWorkspacePath, currentAgent } from '../autonomy/context.ts'
import { diagnosticsForFile, formatDiagnostics } from '../lsp/registry.ts'
import { addOnlyDiff, diffStat, fencedDiff, unifiedDiff } from '../ui/diff.ts'
import { hasReadFile, noteFileRead } from './fileAccess.ts'

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create a file, or overwrite one entirely with new content. Creates parent directories as needed. To overwrite an existing non-empty file you must read_file it first (or use edit_file for a targeted change).',
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
    const path = resolveWorkspacePath(input.path)
    const content = input.content

    const existing = Bun.file(path)
    const priorText = (await existing.exists()) ? await existing.text() : undefined

    // Guard against clobbering a file the agent never looked at. An empty file
    // has nothing to lose; a file it has already read (or written) is fair game.
    if (priorText !== undefined && priorText.trim().length > 0 && !hasReadFile(path)) {
      throw new Error(
        `${input.path} already exists (${priorText.split('\n').length} lines) and has not been read this session. read_file it first so you overwrite it deliberately, or use edit_file for a targeted change.`,
      )
    }

    await captureBeforeWrite(path)
    await Bun.write(path, content)
    noteFileRead(path)

    const root = currentAgent().cwd ?? process.cwd()
    const diagnostics = await diagnosticsForFile(path, content, root)
    // Overwrites get a real before/after patch; new files get a capped add-only
    // hunk so the model (and the terminal) can see what landed without a full dump.
    const diff = priorText === undefined
      ? addOnlyDiff(content, input.path)
      : unifiedDiff(priorText.replace(/\r\n/g, '\n'), content.replace(/\r\n/g, '\n'), input.path)
    const verb = priorText === undefined ? 'Created' : 'Overwrote'
    const body = diff.hunks.length > 0 ? `\n${fencedDiff(diff)}` : ''
    return `${verb} ${input.path} (${diffStat(diff)})${body}${diagnostics ? formatDiagnostics(diagnostics, input.path) : ''}`
  },
}
