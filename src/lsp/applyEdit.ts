import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { atomicWrite } from '../tools/atomicWrite.ts'
import type { Position, TextEdit, WorkspaceEdit } from './protocol.ts'

/**
 * Applies a server-proposed rename/code-action edit to disk.
 *
 * `rename()`/`codeActions()` on {@link LspClient} only ever return the edit a
 * server *proposes* — this is the separate step that actually writes it,
 * kept apart so a caller can show the edit for approval before it touches
 * anything (the governor treats `edit_file` as the write boundary; this is
 * effectively a multi-file `edit_file` and should go through the same path).
 */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, beforeWrite?: (path: string) => Promise<void>): Promise<{ applied: string[] }> {
  const applied: string[] = []
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    if (!Array.isArray(edits) || edits.length === 0) continue
    const path = fileURLToPath(uri)
    const content = await readFile(path, 'utf8')
    const next = applyTextEdits(content, edits)
    if (next === content) continue
    await beforeWrite?.(path)
    await atomicWrite(path, next)
    applied.push(path)
  }
  return { applied }
}

/**
 * Applies a set of LSP `TextEdit`s to one document's content. Processed in
 * descending document-position order so an earlier edit's offset — recomputed
 * against the progressively-edited string on each step — is never shifted by
 * an edit that came after it; this is what makes multiple edits from one
 * response composable without a diff/offset-mapping library. Assumes
 * non-overlapping ranges, as the LSP spec requires of a compliant server.
 */
export function applyTextEdits(content: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    const byLine = b.range.start.line - a.range.start.line
    return byLine !== 0 ? byLine : b.range.start.character - a.range.start.character
  })
  let result = content
  for (const edit of sorted) {
    const start = positionToOffset(result, edit.range.start)
    const end = positionToOffset(result, edit.range.end)
    result = result.slice(0, start) + edit.newText + result.slice(end)
  }
  return result
}

/** LSP positions are 0-based line + UTF-16-code-unit character offsets — the same units a JS string already uses, so `character` indexes directly once the line's start offset is found. */
function positionToOffset(content: string, position: Position): number {
  let offset = 0
  for (let line = 0; line < position.line; line++) {
    const newline = content.indexOf('\n', offset)
    if (newline === -1) return content.length
    offset = newline + 1
  }
  return Math.min(offset + position.character, content.length)
}
