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

export const LSP_CLIENT_INFO = { name: 'elia', version: '0.1.2' }
