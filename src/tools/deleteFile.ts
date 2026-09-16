import { rm, stat } from 'node:fs/promises'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { isSensitivePath } from '../autonomy/sensitivePaths.ts'

/**
 * Remove one file the agent is responsible for.
 *
 * elia could create files but not remove one: deleting took a shell command,
 * and an unattended run with nobody to ask refuses shell commands outside the
 * read-only set. So when a reviewer asked for a leftover duplicate test file or a
 * scratch script to go, the run could never comply and burned its repair budget
 * on it (run 2026-09-16-fgbo-oq50). This is the narrow version: one regular file,
 * inside the workspace, never a protected path or anything under .git, and
 * checkpointed first exactly as write_file is — so a deletion is as reversible
 * as an overwrite.
 */
export const deleteFileTool: Tool = {
  name: 'delete_file',
  description:
    'Delete one file inside the workspace — a leftover duplicate, a scratch script, a file a reviewer asked you to remove. Only regular files (not directories), never protected files such as .env, never anything under .git. The file is checkpointed first, so the deletion can be rewound. Use this instead of rm/del shell commands.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to delete' },
    },
    required: ['path'],
  },
  async execute(input) {
    if (typeof input.path !== 'string' || input.path.trim().length === 0) {
      throw new Error('delete_file requires a non-empty "path" string argument.')
    }
    const path = resolveWorkspacePath(input.path)
    if (/(^|[\\/])\.git([\\/]|$)/.test(path)) {
      throw new Error(`${input.path} is inside .git — elia does not delete repository internals.`)
    }
    if (isSensitivePath(path)) {
      throw new Error(`${input.path} is a protected path, so elia will not delete it. Tell the user if it should go.`)
    }
    let info
    try {
      info = await stat(path)
    } catch {
      throw new Error(`${input.path} does not exist — nothing to delete.`)
    }
    if (!info.isFile()) {
      throw new Error(`${input.path} is not a regular file. delete_file removes one file at a time; it never removes directories.`)
    }
    await captureBeforeWrite(path)
    await rm(path)
    return `Deleted ${input.path} (${info.size} bytes; checkpointed, so it can be rewound).`
  },
}
