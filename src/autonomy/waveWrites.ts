import { isAbsolute, relative, resolve } from 'node:path'
import type { ToolEvent } from '../agentLoop.ts'
import { changedFilesFromResult } from '../tools/lspRefactor.ts'

/**
 * Which files a tool call wrote, as paths relative to `root`.
 *
 * The per-wave commit needs to know what *this run* changed, as opposed to what
 * changed in the tree while it was running. Those used to be treated as the
 * same thing: a wave committed the files its steps *declared*, and when no step
 * declared any it committed everything staged — which is how another session's
 * in-flight work got swept into a commit titled for somebody else's goal. The
 * tree cannot tell you who wrote a file. The tool calls can, because every
 * change a worker makes to a file goes through one.
 *
 * Only successful calls count: a failed write changed nothing, and an edit that
 * missed its target left the file as it was. Anything that resolves outside
 * `root` is dropped — the workspace guard should already have refused it, and a
 * wave commit must never reach past the project it belongs to.
 *
 * Files produced by a shell command — a lockfile from an install, generated
 * code — are not attributable this way, so they are left in the working tree
 * rather than committed. Leaving a file uncommitted is recoverable; committing
 * someone else's is not.
 */
export function filesWrittenBy(event: ToolEvent, root: string): string[] {
  if (event.isError) return []
  let written: string[] = []
  if (event.name === 'write_file' || event.name === 'edit_file') {
    if (typeof event.input.path === 'string' && event.input.path.trim()) written = [event.input.path.trim()]
  } else if (event.name === 'lsp_refactor') {
    // A rename edits every file that references the symbol, not just the one
    // named in the input — committing only that one would leave a checkpoint
    // that does not compile.
    written = changedFilesFromResult(event.result)
  }
  const inside: string[] = []
  for (const file of written) {
    const rel = relative(root, isAbsolute(file) ? file : resolve(root, file)).replace(/\\/g, '/')
    if (!rel || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) continue
    inside.push(rel)
  }
  return inside
}
