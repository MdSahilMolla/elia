import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureFile } from './securePersistence.ts'
import { clampOutput } from './shell.ts'
import { paths } from './statePaths.ts'

/**
 * The most one tool result may put into the conversation.
 *
 * Tools bound their own output, but for their own reasons — `run_command` keeps
 * 200 KB of stdout *and* 200 KB of stderr, `read_file` returns up to 5 MB — and
 * none of those bounds is about the model's context window. Seen live (session
 * mu0t6bvd-urf6i6, 2026-09-14): `git add .` in a project with no .gitignore
 * printed one CRLF warning per file in node_modules (201 KB), then two
 * `git diff --cached` calls dumped 205 KB each. Three results, ~600 KB, and a
 * 260k-token window was gone — the turn died, and so did every prompt after it,
 * because that history was saved with the session.
 *
 * 40k characters is ~10k tokens: plenty for any build log or file window the
 * model actually reads, small enough that a handful of them cannot sink a turn.
 */
export const MAX_TOOL_RESULT_CHARS = 40_000

/** Spilled outputs kept on disk; older ones are pruned. */
const MAX_SPILL_FILES = 50

/**
 * Bounds `text` for the conversation. Over budget, the full output is written
 * to `.elia/tool-output/` and the model gets both ends (where a command's error
 * and its summary live) plus the path to read the middle from — so nothing is
 * lost, it just stops costing context until it is actually needed.
 */
export function boundToolResult(text: string, toolName: string, spillDir = join(paths.state, 'tool-output')): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  const spilled = spill(text, toolName, spillDir)
  const how = spilled
    ? `The full output was saved to ${spilled} — read_file it with offset/limit if you need the omitted part.`
    : 'Re-run it with narrower output (a path filter, --stat, a grep) if you need the omitted part.'
  return `${clampOutput(text, MAX_TOOL_RESULT_CHARS)}\n[elia: this ${toolName} result was ${text.length} characters, over the ${MAX_TOOL_RESULT_CHARS}-character budget for one result, so the middle was left out to keep the conversation inside the model's context window. ${how}]`
}

function spill(text: string, toolName: string, dir: string): string | undefined {
  try {
    const file = join(dir, `${Date.now()}-${toolName.replace(/[^a-z0-9_-]/gi, '_')}-${Math.random().toString(36).slice(2, 8)}.txt`)
    writeSecureFile(file, text)
    prune(dir)
    return file
  } catch {
    return undefined
  }
}

function prune(dir: string): void {
  const files = readdirSync(dir).filter((name) => name.endsWith('.txt')).sort()
  for (const name of files.slice(0, Math.max(0, files.length - MAX_SPILL_FILES))) {
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // Another process may have pruned it first.
    }
  }
}
