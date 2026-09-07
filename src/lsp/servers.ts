import { extname } from 'node:path'

export interface LanguageServerSpec {
  languageId: string
  command: string
  args: string[]
}

// One well-known server per language, matching what's actually installed most
// often in practice (opencode, Claude Code's own editor integrations, and most
// IDEs default to the same handful). elia doesn't install these — a missing
// binary just means diagnostics are silently unavailable for that language
// (see lsp/registry.ts's fail-soft connect).
const EXTENSION_MAP: Record<string, LanguageServerSpec> = {
  '.ts': { languageId: 'typescript', command: 'typescript-language-server', args: ['--stdio'] },
  '.tsx': { languageId: 'typescriptreact', command: 'typescript-language-server', args: ['--stdio'] },
  '.mts': { languageId: 'typescript', command: 'typescript-language-server', args: ['--stdio'] },
  '.js': { languageId: 'javascript', command: 'typescript-language-server', args: ['--stdio'] },
  '.jsx': { languageId: 'javascriptreact', command: 'typescript-language-server', args: ['--stdio'] },
  '.mjs': { languageId: 'javascript', command: 'typescript-language-server', args: ['--stdio'] },
  '.cjs': { languageId: 'javascript', command: 'typescript-language-server', args: ['--stdio'] },
  '.py': { languageId: 'python', command: 'pyright-langserver', args: ['--stdio'] },
  '.go': { languageId: 'go', command: 'gopls', args: [] },
  '.rs': { languageId: 'rust', command: 'rust-analyzer', args: [] },
  '.java': { languageId: 'java', command: 'jdtls', args: [] },
  // clangd resolves flags from compile_commands.json / compile_flags.txt when
  // present; without one it still parses and reports syntax and obvious semantic
  // errors, which is the point here.
  '.c': { languageId: 'c', command: 'clangd', args: ['--background-index'] },
  '.h': { languageId: 'c', command: 'clangd', args: ['--background-index'] },
  '.cc': { languageId: 'cpp', command: 'clangd', args: ['--background-index'] },
  '.cpp': { languageId: 'cpp', command: 'clangd', args: ['--background-index'] },
  '.cxx': { languageId: 'cpp', command: 'clangd', args: ['--background-index'] },
  '.hpp': { languageId: 'cpp', command: 'clangd', args: ['--background-index'] },
  '.hh': { languageId: 'cpp', command: 'clangd', args: ['--background-index'] },
  '.hxx': { languageId: 'cpp', command: 'clangd', args: ['--background-index'] },
}

export function languageServerFor(path: string): LanguageServerSpec | undefined {
  return EXTENSION_MAP[extname(path).toLowerCase()]
}
