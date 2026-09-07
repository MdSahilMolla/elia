import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { resolveWorkspacePath, currentAgent } from '../autonomy/context.ts'
import { diagnosticsForFile, formatDiagnostics } from '../lsp/registry.ts'
import { addOnlyDiff, diffStat, fencedDiff, unifiedDiff } from '../ui/diff.ts'
import { hasReadFile, noteFileRead } from './fileAccess.ts'
import { isSensitivePath } from '../autonomy/sensitivePaths.ts'
import { atomicWrite } from './atomicWrite.ts'
import { preflightStructuralCheck } from '../native/parseCheck.ts'

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

    // A protected file that already has content is never overwritten, and the
    // refusal has to say so plainly.
    //
    // The read-before-overwrite guard below used to catch these and answer
    // "read_file it first" — but read_file *denies* a sensitive path, so the
    // agent was told to do the one thing it could not do. Observed live: a run
    // burned four actions bouncing between a write it could not make and a read
    // it was not allowed, on a .env holding the user's real API keys. Creating a
    // .env that does not exist yet is still fine; destroying one that does is
    // not.
    if (priorText !== undefined && priorText.trim().length > 0 && isSensitivePath(path)) {
      throw new Error(
        `${input.path} is a protected path that already has content, so elia will not overwrite it — and cannot read it first to merge, by the same rule. Do not retry this write. If a value needs to go in there, finish the rest of the work and tell the user exactly what to add.`,
      )
    }

    // Guard against clobbering a file the agent never looked at. An empty file
    // has nothing to lose; a file it has already read (or written) is fair game.
    if (priorText !== undefined && priorText.trim().length > 0 && !hasReadFile(path)) {
      throw new Error(
        `${input.path} already exists (${priorText.split('\n').length} lines) and has not been read this session. read_file it first so you overwrite it deliberately, or use edit_file for a targeted change.`,
      )
    }

    if (currentAgent().signal?.aborted) {
      throw new Error('Write cancelled before writing — the run was aborted.')
    }

    // Reject content that is structurally broken (unbalanced brackets, an
    // unterminated string/comment) when the file it replaces was fine — a
    // sub-ms native check in place of a failed build. No-ops without the daemon.
    const structural = await preflightStructuralCheck(path, priorText, content)
    if (structural) throw new Error(structural)

    await captureBeforeWrite(path)
    await atomicWrite(path, content)
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
    // State the absolute path so "where did the file go?" is never ambiguous —
    // relative paths resolve against the run's cwd, which is not always what the
    // model (or the user) assumes, especially for scratch projects.
    const at = path !== input.path ? `\n  at ${path}` : ''
    return `${verb} ${input.path} (${diffStat(diff)})${at}${body}${diagnostics ? formatDiagnostics(diagnostics, input.path) : ''}`
  },
}
