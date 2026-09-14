import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { currentAgent, isPathWithinWorkspace, resolveWorkspacePath } from '../autonomy/context.ts'
import { isSensitivePath } from '../autonomy/sensitivePaths.ts'
import { listCodeActions, renameSymbol } from '../lsp/registry.ts'
import { applyWorkspaceEdit } from '../lsp/applyEdit.ts'
import { noteFileRead } from './fileAccess.ts'
import type { CodeAction, Command, WorkspaceEdit } from '../lsp/protocol.ts'

/**
 * LSP-driven refactors: a rename that follows every reference across the
 * project, and the quick-fixes/refactors a language server offers at a
 * position — the piece diagnosticsForFile's read-only integration never
 * covered. Two separate write paths (rename, apply_code_action) because a
 * rename is a single unambiguous operation the moment its target is named,
 * while code actions are a menu: list first, apply by index once one is
 * actually chosen, exactly like a human would in an editor.
 */

type Action = 'rename' | 'code_actions' | 'apply_code_action'

function oneBasedToPosition(line: unknown, column: unknown): { line: number; character: number } {
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) throw new Error('"line" must be a 1-based integer.')
  if (typeof column !== 'number' || !Number.isInteger(column) || column < 1) throw new Error('"column" must be a 1-based integer.')
  return { line: line - 1, character: column - 1 }
}

/** Every file a WorkspaceEdit touches must resolve inside the active workspace before anything is written — a server bug or a hostile response is not a license to write outside it. */
function assertEditWithinWorkspace(edit: WorkspaceEdit, cwd: string): void {
  for (const uri of Object.keys(edit.changes ?? {})) {
    const path = fileURLToPath(uri)
    if (!isPathWithinWorkspace(path, cwd) || isSensitivePath(path)) {
      throw new Error(`Refusing to apply an edit outside the active workspace or to a protected path: ${path}`)
    }
  }
}

function describeAction(action: CodeAction | Command, index: number): string {
  if ('edit' in action || 'title' in action) {
    const title = action.title
    const kind = 'kind' in action && action.kind ? ` [${action.kind}]` : ''
    const applicable = 'edit' in action && action.edit ? '' : 'command' in action && action.command ? ' (server command, not directly applicable here)' : ''
    return `${index}. ${title}${kind}${applicable}`
  }
  return `${index}. (unrecognized action)`
}

const CHANGED_FILE_INDENT = '  '

/**
 * The files a refactor changed, as the indented list both results end with.
 *
 * Paired with `changedFilesFromResult`, and the two live together on purpose:
 * the autonomous loop reads this list back to know which files a wave wrote, so
 * a rename that touches ten files is committed as ten files rather than the one
 * named in the tool's input. Keeping the writer and the reader side by side is
 * what stops a rewording of the message from silently breaking that.
 */
export function listChangedFiles(files: string[]): string {
  return files.map((file) => `\n${CHANGED_FILE_INDENT}${file}`).join('')
}

/** The files an `lsp_refactor` result reports it changed; empty for a result that changed nothing. */
export function changedFilesFromResult(result: string): string[] {
  return result
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.startsWith(CHANGED_FILE_INDENT) && line.trim().length > 0)
    .map((line) => line.slice(CHANGED_FILE_INDENT.length).trim())
}

export const lspRefactorTool: Tool = {
  name: 'lsp_refactor',
  description: `Language-server-driven refactors, distinct from edit_file's plain text substitution: a rename that follows every reference across the project, and the quick-fixes/refactors a language server can offer at a position. Requires a language server configured for the file type (see lsp/servers.ts) — when none is available, say so plainly rather than guessing at a manual edit.

Actions:
- rename: rename the symbol at a position everywhere it's referenced. { path, line, column, newName } — line/column are 1-based.
- code_actions: list quick-fixes/refactors available at a position, numbered for apply_code_action. { path, line, column }
- apply_code_action: re-list actions at the same position and apply the one at "index" (from a prior code_actions call). Only actions that carry their own edit can be applied here — a server-command-only action is reported, not executed. { path, line, column, index }`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['rename', 'code_actions', 'apply_code_action'] },
      path: { type: 'string', description: 'File containing the position' },
      line: { type: 'number', description: '1-based line number' },
      column: { type: 'number', description: '1-based column number' },
      newName: { type: 'string', description: 'rename: the new identifier' },
      index: { type: 'number', description: 'apply_code_action: 1-based index from a prior code_actions listing' },
    },
    required: ['action', 'path', 'line', 'column'],
  },
  async execute(input) {
    const action = input.action as Action
    const path = resolveWorkspacePath(String(input.path ?? ''))
    if (isSensitivePath(path)) throw new Error(`${input.path} is a protected path, so elia will not refactor it.`)
    const position = oneBasedToPosition(input.line, input.column)
    const cwd = currentAgent().cwd ?? process.cwd()
    const text = await readFile(path, 'utf8')
    noteFileRead(path)

    if (action === 'rename') {
      const newName = typeof input.newName === 'string' ? input.newName.trim() : ''
      if (!newName) throw new Error('rename requires a non-empty "newName".')
      const edit = await renameSymbol(path, text, position, newName, cwd)
      if (edit === undefined) return `No language server is configured/available for ${input.path} — lsp_refactor cannot follow references for this file type.`
      if (edit === null || !edit.changes || Object.keys(edit.changes).length === 0) return `The language server found nothing renameable at ${input.path}:${input.line}:${input.column}.`
      if (currentAgent().signal?.aborted) throw new Error('Refactor cancelled before writing — the run was aborted.')
      assertEditWithinWorkspace(edit, cwd)
      const { applied } = await applyWorkspaceEdit(edit, captureBeforeWrite)
      const totalEdits = Object.values(edit.changes).reduce((sum, edits) => sum + edits.length, 0)
      return `Renamed to "${newName}": ${totalEdits} edit(s) across ${applied.length} file(s):${listChangedFiles(applied)}`
    }

    const actions = await listCodeActions(path, text, { start: position, end: position }, [], cwd)
    if (actions === undefined) return `No language server is configured/available for ${input.path} — lsp_refactor has no code actions for this file type.`
    if (actions.length === 0) return `No code actions available at ${input.path}:${input.line}:${input.column}.`

    if (action === 'code_actions') {
      return actions.map((a, i) => describeAction(a, i + 1)).join('\n')
    }

    // apply_code_action
    const index = typeof input.index === 'number' ? Math.floor(input.index) : Number.NaN
    if (!Number.isInteger(index) || index < 1 || index > actions.length) {
      throw new Error(`apply_code_action needs "index" between 1 and ${actions.length} (call code_actions first to see the list).`)
    }
    const chosen = actions[index - 1]!
    const edit = 'edit' in chosen ? chosen.edit : undefined
    if (!edit || !edit.changes || Object.keys(edit.changes).length === 0) {
      return `"${chosen.title}" has no directly-applicable edit ${('command' in chosen && chosen.command) ? '(it runs as a server command, which lsp_refactor does not execute)' : ''} — nothing was changed.`
    }
    if (currentAgent().signal?.aborted) throw new Error('Refactor cancelled before writing — the run was aborted.')
    assertEditWithinWorkspace(edit, cwd)
    const { applied } = await applyWorkspaceEdit(edit, captureBeforeWrite)
    return `Applied "${chosen.title}": ${applied.length} file(s) changed:${listChangedFiles(applied)}`
  },
}
