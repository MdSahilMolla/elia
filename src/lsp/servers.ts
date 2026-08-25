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
}

export function languageServerFor(path: string): LanguageServerSpec | undefined {
  return EXTENSION_MAP[extname(path).toLowerCase()]
}
