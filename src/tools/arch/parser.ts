// Import/export extraction using the repository's native TypeScript 7 compiler.
//
// Opens the project through `typescript/unstable/sync` (the Go-native compiler
// that ships with `typescript@7`), retrieves real AST source files, and walks
// them for import/export constructs: static imports, `import type`, dynamic
// `import()`, `import()` types, `import x = require()`, and every export form.

import { API } from 'typescript/unstable/sync'
import type { Program } from 'typescript/unstable/sync'
import type { Node, SourceFile } from 'typescript/unstable/ast'
import { ModifierFlags, SyntaxKind } from 'typescript/unstable/ast'
import {
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportExpression,
  isImportTypeNode,
  isExportDeclaration,
  isExportAssignment,
  isNamespaceExportDeclaration,
  isCallExpression,
  isVariableStatement,
  isFunctionDeclaration,
  isClassDeclaration,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isEnumDeclaration,
  isModuleDeclaration,
} from 'typescript/unstable/ast/is'
import { join } from 'node:path'
import type { ExportInfo, OpenProjectResult, ParsedFile, ParserOptions, RawImport } from './types.ts'

const TEST_FILE = /\.(test|spec|e2e)\.(ts|tsx|js|mts|cts)$/i

/** Open a TypeScript project with the native compiler and load its program. */
export function openProject(options: ParserOptions): OpenProjectResult {
  const api = new API({})
  const snapshot = api.updateSnapshot({ openProjects: [options.tsconfigPath] })
  const project = snapshot.getProjects()[0]
  if (!project) {
    snapshot.dispose()
    api.close()
    throw new Error(`No TypeScript project found at ${options.tsconfigPath}`)
  }
  return { api, snapshot, project, program: project.program }
}

// The Go-native compiler exposes full data through per-kind typed getters, but
// `forEachChild` only returns a subset of a node's children (e.g. a Block's
// statements are NOT all enumerated, and declaration bodies are skipped). To
// walk the tree reliably we enumerate children through the strong getters for
// each syntax kind, paired with whichever children forEachChild still yields.
const KIND_CHILDREN: Partial<Record<SyntaxKind, string[]>> = {
  [SyntaxKind.SourceFile]: ['statements'],
  [SyntaxKind.Block]: ['statements'],
  [SyntaxKind.ModuleBlock]: ['statements'],
  [SyntaxKind.VariableStatement]: ['declarationList'],
  [SyntaxKind.VariableDeclarationList]: ['declarations'],
  [SyntaxKind.VariableDeclaration]: ['name', 'type', 'initializer'],
  [SyntaxKind.ExpressionStatement]: ['expression'],
  [SyntaxKind.ReturnStatement]: ['expression'],
  [SyntaxKind.ThrowStatement]: ['expression'],
  [SyntaxKind.IfStatement]: ['expression', 'thenStatement', 'elseStatement'],
  [SyntaxKind.WhileStatement]: ['expression', 'statement'],
  [SyntaxKind.DoStatement]: ['expression', 'statement'],
  [SyntaxKind.ForStatement]: ['initializer', 'condition', 'incrementor', 'statement'],
  [SyntaxKind.ForInStatement]: ['expression', 'initializer', 'statement'],
  [SyntaxKind.ForOfStatement]: ['expression', 'initializer', 'statement'],
  [SyntaxKind.SwitchStatement]: ['expression', 'caseBlock'],
  [SyntaxKind.CaseBlock]: ['clauses'],
  [SyntaxKind.CaseClause]: ['statements'],
  [SyntaxKind.DefaultClause]: ['statements'],
  [SyntaxKind.TryStatement]: ['tryBlock', 'catchClause', 'finallyBlock'],
  [SyntaxKind.CatchClause]: ['block'],
  [SyntaxKind.BinaryExpression]: ['left', 'operatorToken', 'right'],
  [SyntaxKind.PrefixUnaryExpression]: ['operand'],
  [SyntaxKind.AwaitExpression]: ['expression'],
  [SyntaxKind.CallExpression]: ['expression', 'arguments'],
  [SyntaxKind.NewExpression]: ['expression', 'arguments'],
  [SyntaxKind.PropertyAccessExpression]: ['expression', 'name'],
  [SyntaxKind.ElementAccessExpression]: ['expression', 'argumentExpression'],
  [SyntaxKind.ParenthesizedExpression]: ['expression'],
  [SyntaxKind.AsExpression]: ['expression', 'type'],
  [SyntaxKind.SatisfiesExpression]: ['expression', 'type'],
  [SyntaxKind.TypeAssertionExpression]: ['expression', 'type'],
  [SyntaxKind.NonNullExpression]: ['expression'],
  [SyntaxKind.TypeOfExpression]: ['expression'],
  [SyntaxKind.VoidExpression]: ['expression'],
  [SyntaxKind.DeleteExpression]: ['expression'],
  [SyntaxKind.ArrayLiteralExpression]: ['elements'],
  [SyntaxKind.ObjectLiteralExpression]: ['properties'],
  [SyntaxKind.PropertyAssignment]: ['name', 'initializer'],
  [SyntaxKind.ShorthandPropertyAssignment]: ['name'],
  [SyntaxKind.SpreadElement]: ['expression'],
  [SyntaxKind.SpreadAssignment]: ['expression'],
  [SyntaxKind.FunctionDeclaration]: ['name', 'typeParameters', 'parameters', 'body'],
  [SyntaxKind.FunctionExpression]: ['name', 'typeParameters', 'parameters', 'body'],
  [SyntaxKind.ClassDeclaration]: ['name', 'typeParameters', 'heritageClauses', 'members'],
  [SyntaxKind.ClassExpression]: ['name', 'typeParameters', 'heritageClauses', 'members'],
  [SyntaxKind.MethodDeclaration]: ['name', 'typeParameters', 'parameters', 'body'],
  [SyntaxKind.GetAccessor]: ['name', 'typeParameters', 'parameters', 'body'],
  [SyntaxKind.SetAccessor]: ['name', 'typeParameters', 'parameters', 'body'],
  [SyntaxKind.Constructor]: ['parameters', 'body'],
  [SyntaxKind.InterfaceDeclaration]: ['name', 'typeParameters', 'heritageClauses', 'members'],
  [SyntaxKind.TypeAliasDeclaration]: ['name', 'typeParameters', 'type'],
  [SyntaxKind.EnumDeclaration]: ['name', 'members'],
  [SyntaxKind.ModuleDeclaration]: ['name', 'body'],
  [SyntaxKind.ArrowFunction]: ['name', 'typeParameters', 'parameters', 'body'],
  [SyntaxKind.ImportEqualsDeclaration]: ['name', 'moduleReference'],
  [SyntaxKind.ImportType]: ['qualifier', 'typeArguments'],
}

/**
 * Recursively enumerate the child nodes of a native AST node, using the
 * per-kind getter map above so nothing hidden by forEachChild is missed.
 */
function childrenOf(node: Node): Node[] {
  const out: Node[] = []
  const seen = new Set<string>()
  function push(n: unknown): void {
    if (!n || typeof n !== 'object') return
    const nn = n as { kind?: number; pos?: number; end?: number }
    if (typeof nn.kind !== 'number') return
    // Skip keyword/token nodes: they have no children worth recursing into.
    const key = `${nn.kind}:${nn.pos ?? 0}:${nn.end ?? 0}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(n as Node)
  }
  node.forEachChild((child: Node) => push(child))
  for (const getter of KIND_CHILDREN[node.kind as SyntaxKind] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[getter]
    if (Array.isArray(value)) for (const item of value) push(item)
    else push(value)
  }
  return out
}

/** Extract imports and exports from a single source file. */
export function parseSourceFile(sf: SourceFile, path: string, externalLibrary: boolean, defaultLibrary: boolean): ParsedFile {
  const imports: RawImport[] = []
  const exports: ExportInfo[] = []

  function addExport(
    kind: ExportInfo['kind'],
    names: string[],
    isTypeOnly: boolean,
    pos: number,
    specifier?: string,
  ): void {
    const lac = sf.getLineAndCharacterOfPosition(pos)
    exports.push({ filePath: path, kind, names, isTypeOnly, line: lac.line + 1, specifier })
  }

  function addImport(
    spec: string,
    kind: RawImport['kind'],
    isTypeOnly: boolean,
    names: string[],
    pos: number,
  ): void {
    if (spec.length === 0) return
    const lac = sf.getLineAndCharacterOfPosition(pos)
    imports.push({ specifier: spec, kind, isTypeOnly, names, line: lac.line + 1, column: lac.character })
  }

  function namedNames(
    elements: Array<{
      isTypeOnly?: boolean
      name?: { text?: string } | null
      propertyName?: { text?: string } | null
    }> | undefined,
  ): string[] {
    if (!elements) return []
    return elements
      .map((el) => el.propertyName?.text ?? el.name?.text ?? '')
      .filter((s) => s.length > 0)
  }

  function visit(node: Node | undefined): void {
    if (!node) return
    const n = node as unknown as {
      pos: number
      modifierFlags: number
      name?: { text?: string } | null
      text?: string
      moduleSpecifier?: { text?: string } | null
      importClause?: {
        isTypeOnly?: boolean
        name?: { text?: string } | null
        namedBindings?: {
          name?: { text?: string } | null
          elements?: Array<{
            isTypeOnly?: boolean
            name?: { text?: string } | null
            propertyName?: { text?: string } | null
          }>
        } | null
      } | null
      exportClause?: {
        name?: { text?: string } | null
        elements?: Array<{
          isTypeOnly?: boolean
          name?: { text?: string } | null
          propertyName?: { text?: string } | null
        }>
      } | null
      isTypeOnly?: boolean
      isExportEquals?: boolean
      expression?: { text?: string } | null
      moduleReference?: { expression?: { text?: string } | null } | null
      argument?: { literal?: { text?: string } | null } | null
      declarationList?: { declarations?: Array<{ name?: { text?: string } | null }> } | null
      arguments?: Array<{ text?: string } | null> | null
    }
    const spec = (locale: { text?: string } | null | undefined): string => (locale?.text ?? '')

    if (isImportDeclaration(node)) {
      const raw = spec(n.moduleSpecifier)
      const clauseTypeOnly = n.importClause?.isTypeOnly === true
      const named = n.importClause?.namedBindings ?? null
      let isTypeOnly = clauseTypeOnly
      const elements = named?.elements
      if (!clauseTypeOnly && elements && elements.length > 0) {
        isTypeOnly = elements.every((el) => el.isTypeOnly === true)
      }
      const names = namedNames(elements)
      if (n.importClause?.name?.text) names.push(n.importClause.name.text)
      if (named?.name?.text) names.push(named.name.text)
      addImport(raw, isTypeOnly ? 'type-only' : 'static', isTypeOnly, names, node.pos)
      return
    }

    if (isExportDeclaration(node)) {
      const raw = n.moduleSpecifier ? spec(n.moduleSpecifier) : ''
      const isTypeOnly = n.isTypeOnly === true
      const names = namedNames(n.exportClause?.elements)
      if (raw.length > 0) {
        addImport(raw, 'reexport', isTypeOnly, names.length > 0 ? names : ['*'], node.pos)
        const nsName = n.exportClause?.name?.text
        if (nsName) {
          addExport('namespace', [nsName], isTypeOnly, node.pos, raw)
        } else if (names.length > 0) {
          addExport('named', names, isTypeOnly, node.pos, raw)
        } else {
          addExport('star', ['*'], isTypeOnly, node.pos, raw)
        }
      } else if (names.length > 0) {
        addExport('named', names, isTypeOnly, node.pos)
      }
      return
    }

    if (isExportAssignment(node)) {
      const nameText = spec(n.expression)
      addExport('export-assign', [n.isExportEquals === true ? nameText : 'default'], false, node.pos)
      return
    }

    if (isNamespaceExportDeclaration(node)) {
      addExport('namespace', [n.name?.text ?? ''], false, node.pos)
      return
    }

    if (isImportEqualsDeclaration(node)) {
      const raw = spec(n.moduleReference?.expression)
      if (raw.length > 0) addImport(raw, 'static', false, [n.name?.text ?? ''], node.pos)
      return
    }

    if (isImportExpression(node)) {
      const arg = n.arguments?.[0]
      if (arg) addImport(arg.text ?? '', 'dynamic', false, [], node.pos)
      return
    }

    if (isImportTypeNode(node)) {
      const raw = spec(n.argument?.literal)
      if (raw.length > 0) addImport(raw, 'type-only', true, [], node.pos)
      return
    }

    if (isCallExpression(node)) {
      const callee = (n.expression as { kind?: number } | null | undefined)?.kind
      if (callee === SyntaxKind.ImportKeyword) {
        const arg = n.arguments?.[0]
        if (arg && typeof arg.text === 'string' && arg.text.length > 0) {
          addImport(arg.text, 'dynamic', false, [], node.pos)
        }
      }
    }

    if (isVariableStatement(node)) {
      if ((n.modifierFlags & ModifierFlags.Export) !== 0) {
        const names: string[] = []
        for (const decl of n.declarationList?.declarations ?? []) {
          const name = decl.name
          if (name && typeof name.text === 'string' && name.text.length > 0) names.push(name.text)
        }
        if (names.length > 0) addExport('named', names, false, node.pos)
      }
    } else if (
      isFunctionDeclaration(node) ||
      isClassDeclaration(node) ||
      isInterfaceDeclaration(node) ||
      isTypeAliasDeclaration(node) ||
      isEnumDeclaration(node) ||
      isModuleDeclaration(node)
    ) {
      if ((n.modifierFlags & ModifierFlags.Export) !== 0 && n.name?.text) {
        addExport('named', [n.name.text], false, node.pos)
      }
    }

    // Declarations can contain nested constructs (dynamic import() calls inside
    // function bodies, namespace modules with their own imports); keep walking
    // children so nothing is missed.
    const children = childrenOf(node)
    for (const child of children) visit(child)
  }

  visit(sf)
  return { path, imports, exports, externalLibrary, defaultLibrary }
}

/**
 * Extract parsed modules for the project files selected by the options.
 * Files are sorted by path and capped at `maxFiles`. The caller must dispose
 * the project handle returned by {@link openProject}.
 */
export function parseProject(program: Program, options: ParserOptions): { files: ParsedFile[]; truncated: boolean } {
  const root = normalizePath(options.projectRoot)
  const names = program
    .getSourceFileNames()
    .map(normalizePath)
    .filter((p) => p.startsWith(root + '/'))
    .sort()
  const files: ParsedFile[] = []
  let counted = 0
  let truncated = false
  for (const name of names) {
    if (counted >= options.maxFiles) {
      truncated = true
      break
    }
    if (TEST_FILE.test(name) && !options.includeTests) continue
    const sf = program.getSourceFile(name)
    if (!sf) continue
    if (program.isSourceFileFromExternalLibrary(sf)) continue
    counted++
    files.push(
      parseSourceFile(
        sf,
        name,
        program.isSourceFileFromExternalLibrary(sf),
        program.isSourceFileDefaultLibrary(sf),
      ),
    )
  }
  return { files, truncated }
}

/** Normalize a path to posix separators. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Absolute join that returns normalized (posix) paths. */
export function joinPath(...parts: string[]): string {
  return normalizePath(join(...parts))
}