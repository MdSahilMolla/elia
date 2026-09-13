/** Minimal LSP types — only the shapes elia's client actually sends or reads. */

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export const DiagnosticSeverity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const

export interface Diagnostic {
  range: Range
  severity?: 1 | 2 | 3 | 4
  message: string
  source?: string
  code?: string | number
}

export interface PublishDiagnosticsParams {
  uri: string
  version?: number
  diagnostics: Diagnostic[]
}

export interface Location {
  uri: string
  range: Range
}

export interface TextEdit {
  range: Range
  newText: string
}

/**
 * Only the `changes` form (uri -> flat TextEdit[]), not the newer
 * `documentChanges` variant (which can also create/rename/delete files) — the
 * servers elia talks to for a same-file rename/quick-fix send `changes`, and
 * this client only ever applies edits, never file-system operations a server
 * might otherwise request.
 */
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>
}

export interface RenameParams {
  textDocument: { uri: string }
  position: Position
  newName: string
}

export interface CodeActionContext {
  diagnostics: Diagnostic[]
}

export interface CodeActionParams {
  textDocument: { uri: string }
  range: Range
  context: CodeActionContext
}

export interface Command {
  title: string
  command: string
  arguments?: unknown[]
}

export interface CodeAction {
  title: string
  kind?: string
  diagnostics?: Diagnostic[]
  isPreferred?: boolean
  edit?: WorkspaceEdit
  command?: Command
}

export const LSP_CLIENT_INFO = { name: 'elia', version: '0.1.2' }
