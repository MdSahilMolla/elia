// Architecture engine: shared types for the drift detection and repair engine.
// Phase 1 primitives (parsing, resolution, module graph).

/** How an import edge was created in source. */
export type EdgeKind = 'static' | 'type-only' | 'dynamic' | 'reexport'

/** A raw import/export reference extracted from source, before path resolution. */
export interface RawImport {
  specifier: string
  kind: EdgeKind
  isTypeOnly: boolean
  /** Extracted exports carried by the import statement (for re-exports). */
  names: string[]
  line: number
  column: number
}

/** A fully resolved dependency between two files (or to an external location). */
export interface ImportEdge {
  /** Normalized absolute path of the importing file. */
  source: string
  /** Resolved absolute path for in-project targets, else the external specifier. */
  target: string
  /** The raw module specifier as written in source. */
  specifier: string
  kind: EdgeKind
  isTypeOnly: boolean
  /** Imported/exported names carried by this statement (available for repair checks). */
  names: string[]
  /** True when the target resolved to a real file on disk. */
  resolved: boolean
  /** True when the target lives outside the analyzed project (node_modules, etc.). */
  external: boolean
  /** True when the specifier could not be resolved at all. */
  unresolved: boolean
  line: number
  column: number
}

/** A file's exported surface. */
export interface ExportInfo {
  /** Normalized absolute path of the exporting file. */
  filePath: string
  kind: 'named' | 'default' | 'star' | 'namespace' | 'export-assign'
  /** Exported names (local symbols or re-export targets); '*' for `export *`. */
  names: string[]
  /** Raw specifier for re-exports (`export { x } from './y'`). */
  specifier?: string
  isTypeOnly: boolean
  line: number
}

/** Output of the parser for a single source file. */
export interface ParsedFile {
  /** Normalized absolute path, posix separators. */
  path: string
  imports: RawImport[]
  exports: ExportInfo[]
  /** True when the file is a program external library (node_modules). */
  externalLibrary: boolean
  /** True when the file is a default library (lib.d.ts). */
  defaultLibrary: boolean
}

/** A single analyzed module (node in the dependency graph). */
export interface ModuleNode {
  /** Normalized absolute path, posix separators. */
  path: string
  /** Path relative to the project root, posix separators. */
  relativePath: string
  imports: ImportEdge[]
  exports: ExportInfo[]
}

/** Options controlling the analysis run. */
export interface ParserOptions {
  /** Absolute path of the project root. */
  projectRoot: string
  /** Absolute path of the tsconfig.json to load. */
  tsconfigPath: string
  includeTests: boolean
  /** Maximum project files to include in the graph (sorted by path). */
  maxFiles: number
}

export type ViolationType =
  | 'import_direction'
  | 'circular_dependency'
  | 'unresolved_import'
  | 'forbidden_import'
  | 'package_boundary_violation'
  | 'abstraction_leakage'
  | 'dependency_inversion'
  | 'god_module'
  | 'excessive_coupling'
  | 'orphan_module'
  | 'deep_dependency_chain'

export type Severity = 'info' | 'warning' | 'error' | 'critical'

/** A single detected architectural violation. */
export interface Violation {
  type: ViolationType
  severity: Severity
  /** Relative path of the offending module ('' when not module-scoped). */
  source: string
  /** Relative path of the target ('' when not applicable). */
  target: string
  /** Raw module specifier when the violation involves an import. */
  specifier?: string
  /** 1-based line when the violation is import-scoped. */
  line?: number
  description: string
  suggestion: string
  /** Rule explanation filled by the explain module. */
  why: string
}

/** Handle to an opened native TypeScript project; must be closed by the caller. */
export interface OpenProjectResult {
  api: import('typescript/unstable/sync').API
  snapshot: import('typescript/unstable/sync').Snapshot
  project: import('typescript/unstable/sync').Project
  program: import('typescript/unstable/sync').Program
}