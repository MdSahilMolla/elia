import { readFile } from 'node:fs/promises'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { resolveWorkspacePath, currentAgent } from '../autonomy/context.ts'
import { diagnosticsForFile, formatDiagnostics } from '../lsp/registry.ts'
import { diffStat, fencedDiff, unifiedDiff } from '../ui/diff.ts'
import { multipleMatchMessage, notFoundMessage } from './editMatch.ts'
import { noteFileRead } from './fileAccess.ts'
import { atomicWrite } from './atomicWrite.ts'
import { preflightStructuralCheck } from '../native/parseCheck.ts'
import { isSensitivePath } from '../autonomy/sensitivePaths.ts'

/** The file's dominant line ending — used as a fallback when a matched span has no embedded newline of its own to infer a local convention from (e.g. a single-line change). */
function detectLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Maps every offset in the `\r\n`→`\n`-folded view of `text` back to the real
 * offset in `text` itself, so a match found in that normalized view can be
 * translated back into untouched, real byte positions.
 */
function normalizeWithOffsets(text: string): { normalized: string; toOriginal: number[] } {
  let normalized = ''
  const toOriginal: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') {
      normalized += '\n'
      toOriginal.push(i)
      i++ // the \n we just folded into the normalized \n
    } else {
      normalized += text[i]
      toOriginal.push(i)
    }
  }
  toOriginal.push(text.length) // sentinel: end of text
  return { normalized, toOriginal }
}

/** The line ending actually used inside `text.slice(origStart, origEnd)`, or `fallback` when that span has no newline to go by. */
function localLineEnding(text: string, origStart: number, origEnd: number, fallback: '\n' | '\r\n'): '\n' | '\r\n' {
  const span = text.slice(origStart, origEnd)
  if (span.includes('\r\n')) return '\r\n'
  if (span.includes('\n')) return '\n'
  return fallback
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

    // Same rule write_file uses to refuse overwriting a protected path — edit_file
    // is just as capable of silently rewriting a .env or an authorized_keys.
    if (isSensitivePath(path)) {
      throw new Error(
        `${input.path} is a protected path, so elia will not edit it. Do not retry this edit. If a value needs to change there, finish the rest of the work and tell the user exactly what to change.`,
      )
    }

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

    // The model virtually always writes \n in tool-call strings, even when the
    // file on disk uses \r\n — or, after a partial Windows edit or a pasted
    // snippet, a mix of both within the same file. Matching happens in a
    // \n-normalized view of the whole file so a real match is never missed just
    // because one file-wide guess about its line ending was wrong for the
    // region the match is actually in; the match is then translated back to its
    // real offsets and the replacement is given *that region's own* line
    // ending (falling back to the file's dominant ending when the region has no
    // newline of its own to go by).
    const fallbackEnding = detectLineEnding(text)
    const { normalized, toOriginal } = normalizeWithOffsets(text)
    const oldNormalized = input.old_string.replace(/\r\n/g, '\n')
    const newNormalized = input.new_string.replace(/\r\n/g, '\n')

    const replaceAll = input.replace_all === true
    const matchStarts: number[] = []
    {
      let from = 0
      for (;;) {
        const at = normalized.indexOf(oldNormalized, from)
        if (at === -1) break
        matchStarts.push(at)
        from = at + Math.max(1, oldNormalized.length)
      }
    }
    if (matchStarts.length === 0) {
      throw new Error(notFoundMessage(text, input.old_string, input.path))
    }
    if (!replaceAll && matchStarts.length > 1) {
      throw new Error(multipleMatchMessage(text, input.old_string, input.path))
    }

    let updated = ''
    let cursor = 0
    for (const normStart of matchStarts) {
      const normEnd = normStart + oldNormalized.length
      const origStart = toOriginal[normStart]!
      const origEnd = toOriginal[normEnd]!
      const ending = localLineEnding(text, origStart, origEnd, fallbackEnding)
      updated += text.slice(cursor, origStart) + newNormalized.replace(/\n/g, ending)
      cursor = origEnd
    }
    updated += text.slice(cursor)

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

    // Reject an edit that would leave the file's brackets/strings/comments
    // broken (when they were fine before) — a sub-ms native check in place of a
    // failed build. No-ops unless the daemon is enabled.
    const structural = await preflightStructuralCheck(path, text, updated)
    if (structural) throw new Error(structural)

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
