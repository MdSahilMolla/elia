import { extname, join } from 'node:path'
import { ELIA_ROOT } from '../statePaths.ts'

/**
 * A structural, AST-backed symbol index — a different query shape from
 * grep's regex-over-text search or the Go sidecar's accelerated version of
 * the same thing. `grep` finds text that matches a pattern; this finds
 * function/class/method/struct *definitions*, by parsing the file with the
 * real grammar for its language rather than guessing from indentation or
 * keyword position.
 *
 * Backed by `web-tree-sitter` + `tree-sitter-wasms` (prebuilt grammar
 * binaries — no native build step, no per-machine compilation). Both are
 * ordinary npm dependencies, not an optional sidecar: unlike the Go index or
 * a language server, there is no separate binary to install or version-check
 * at runtime, so (unlike goindex's own `off`/`auto`/`require` modes) this has
 * no "not installed" failure mode to design around.
 */

export interface SymbolInfo {
  name: string
  /** The grammar's own node type — 'function_declaration', 'class_declaration', 'struct_item', etc. */
  kind: string
  /** 1-based. */
  line: number
  column: number
}

interface LanguageSpec {
  /** Filename under node_modules/tree-sitter-wasms/out/. */
  wasmFile: string
  /** Node types considered a symbol definition worth indexing. */
  symbolTypes: string[]
}

const EXTENSION_MAP: Record<string, LanguageSpec> = {
  '.ts': { wasmFile: 'tree-sitter-typescript.wasm', symbolTypes: ['function_declaration', 'class_declaration', 'method_definition', 'interface_declaration'] },
  '.tsx': { wasmFile: 'tree-sitter-tsx.wasm', symbolTypes: ['function_declaration', 'class_declaration', 'method_definition', 'interface_declaration'] },
  '.mts': { wasmFile: 'tree-sitter-typescript.wasm', symbolTypes: ['function_declaration', 'class_declaration', 'method_definition', 'interface_declaration'] },
  '.js': { wasmFile: 'tree-sitter-javascript.wasm', symbolTypes: ['function_declaration', 'class_declaration', 'method_definition'] },
  '.jsx': { wasmFile: 'tree-sitter-javascript.wasm', symbolTypes: ['function_declaration', 'class_declaration', 'method_definition'] },
  '.mjs': { wasmFile: 'tree-sitter-javascript.wasm', symbolTypes: ['function_declaration', 'class_declaration', 'method_definition'] },
  '.cjs': { wasmFile: 'tree-sitter-javascript.wasm', symbolTypes: ['function_declaration', 'class_declaration', 'method_definition'] },
  '.py': { wasmFile: 'tree-sitter-python.wasm', symbolTypes: ['function_definition', 'class_definition'] },
  '.go': { wasmFile: 'tree-sitter-go.wasm', symbolTypes: ['function_declaration', 'method_declaration', 'type_spec'] },
  '.rs': { wasmFile: 'tree-sitter-rust.wasm', symbolTypes: ['function_item', 'struct_item', 'enum_item', 'trait_item'] },
  '.java': { wasmFile: 'tree-sitter-java.wasm', symbolTypes: ['class_declaration', 'interface_declaration', 'method_declaration'] },
  '.c': { wasmFile: 'tree-sitter-c.wasm', symbolTypes: ['function_definition', 'struct_specifier'] },
  '.h': { wasmFile: 'tree-sitter-c.wasm', symbolTypes: ['function_definition', 'struct_specifier'] },
  '.cc': { wasmFile: 'tree-sitter-cpp.wasm', symbolTypes: ['function_definition', 'class_specifier', 'struct_specifier'] },
  '.cpp': { wasmFile: 'tree-sitter-cpp.wasm', symbolTypes: ['function_definition', 'class_specifier', 'struct_specifier'] },
  '.cxx': { wasmFile: 'tree-sitter-cpp.wasm', symbolTypes: ['function_definition', 'class_specifier', 'struct_specifier'] },
  '.hpp': { wasmFile: 'tree-sitter-cpp.wasm', symbolTypes: ['function_definition', 'class_specifier', 'struct_specifier'] },
}

export function symbolLanguageFor(path: string): LanguageSpec | undefined {
  return EXTENSION_MAP[extname(path).toLowerCase()]
}

export function symbolIndexSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP)
}

/** The slice of web-tree-sitter's SyntaxNode this module actually uses — kept local so the rest of the file doesn't depend on getting its exact (CJS-interop, namespace-nested) type export shape right. */
interface MinimalSyntaxNode {
  type: string
  text: string
  startPosition: { row: number; column: number }
  namedChildren: (MinimalSyntaxNode | null)[]
  childForFieldName(field: string): MinimalSyntaxNode | null
}

// web-tree-sitter is pinned to exactly 0.22.6 in package.json, and cannot be
// bumped on its own. Its grammars come prebuilt from `tree-sitter-wasms`, whose
// latest release (0.1.13, last published 2025-10) is built with the tree-sitter
// 0.20-era toolchain. web-tree-sitter 0.25+ both changed its API — named
// `Parser`/`Language` exports instead of a default export with
// `Parser.Language.load` — and cannot load those grammars: tried against 0.27.0
// on 2026-09-15, the API migration typechecked cleanly and `Language.load` still
// failed on the first grammar. Upgrading means replacing the grammar source (for
// example per-language grammar packages that ship current-format .wasm) at the
// same time, not accepting a Dependabot bump.
//
// Lazily imported: nothing here pays web-tree-sitter's WASM-runtime init cost
// unless a symbol query actually runs. Typed via a type-only import (accurate
// for this package's `export =` CJS shape under esModuleInterop); the value
// itself still has to come from a dynamic import, whose runtime shape — a
// namespace object with a `.default` pointing at the Parser class — needs an
// explicit cast to that same type, verified against the real installed
// package rather than assumed.
import type ParserCtor from 'web-tree-sitter'

type LanguageInstance = Awaited<ReturnType<typeof ParserCtor.Language.load>>

let parserModulePromise: Promise<typeof ParserCtor> | undefined
let initPromise: Promise<void> | undefined
const languageCache = new Map<string, LanguageInstance>()

async function loadParserCtor(): Promise<typeof ParserCtor> {
  parserModulePromise ??= import('web-tree-sitter').then((mod) => (mod as unknown as { default: typeof ParserCtor }).default)
  return parserModulePromise
}

async function ensureInitialized(): Promise<typeof ParserCtor> {
  const Parser = await loadParserCtor()
  initPromise ??= Parser.init()
  await initPromise
  return Parser
}

async function loadLanguage(spec: LanguageSpec, Parser: typeof ParserCtor): Promise<LanguageInstance> {
  const cached = languageCache.get(spec.wasmFile)
  if (cached) return cached
  const wasmPath = join(ELIA_ROOT, 'node_modules', 'tree-sitter-wasms', 'out', spec.wasmFile)
  const language = await Parser.Language.load(wasmPath)
  languageCache.set(spec.wasmFile, language)
  return language
}

/**
 * A node's own name, following each grammar's convention: most declarations
 * expose it directly as a `name` field; C/C++'s nested declarator grammar
 * (`function_definition` -> `function_declarator` -> `identifier`) needs one
 * more hop through a `declarator` field instead. Verified against real
 * parses of every extension in {@link EXTENSION_MAP} before relying on it —
 * tree-sitter node-type/field names are grammar-version-specific and do not
 * generalize from documentation alone.
 */
function findDeclaredName(node: MinimalSyntaxNode): string | undefined {
  if (node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
    return node.text
  }
  const named = node.childForFieldName('name')
  if (named) return findDeclaredName(named)
  const declarator = node.childForFieldName('declarator')
  if (declarator) return findDeclaredName(declarator)
  return undefined
}

const MAX_SYMBOLS_PER_FILE = 500

/**
 * Parses `content` (already read by the caller — this never touches the
 * filesystem itself) and returns every symbol definition found, or undefined
 * when `path`'s extension has no configured grammar — the same "unsupported,
 * not merely absent" convention `diagnosticsForFile` already uses.
 */
export async function symbolsInFile(path: string, content: string): Promise<SymbolInfo[] | undefined> {
  const spec = symbolLanguageFor(path)
  if (!spec) return undefined

  const Parser = await ensureInitialized()
  const language = await loadLanguage(spec, Parser)
  const parser = new Parser()
  parser.setLanguage(language)
  try {
    const tree = parser.parse(content)
    if (!tree) return []
    const symbols: SymbolInfo[] = []
    const symbolTypes = new Set(spec.symbolTypes)

    const walk = (node: MinimalSyntaxNode | null): void => {
      if (!node) return
      if (symbolTypes.has(node.type) && symbols.length < MAX_SYMBOLS_PER_FILE) {
        const name = findDeclaredName(node)
        if (name) symbols.push({ name, kind: node.type, line: node.startPosition.row + 1, column: node.startPosition.column + 1 })
      }
      for (const child of node.namedChildren) walk(child)
    }
    walk(tree.rootNode as unknown as MinimalSyntaxNode)
    return symbols
  } finally {
    parser.delete()
  }
}
