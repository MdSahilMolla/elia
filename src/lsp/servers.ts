import { extname } from 'node:path'

export interface LanguageServerSpec {
  languageId: string
  command: string
  args: string[]
  /**
   * Full `npx` argv (package spec, bin name if it differs from the package
   * name, and the server's own flags) to fall back to when `command` isn't
   * found on PATH — npx fetches and runs it for just this one subprocess,
   * with no separate global-install step and no lasting system mutation, so
   * a missing server degrades to "one slightly slower cold start" instead of
   * silently-no-diagnostics. Only set for servers actually distributed as an
   * npm package; a server with no safe unattended install path
   * (rust-analyzer's rustup component, jdtls' JDK+jar, clangd's system
   * package) is left to the existing fail-soft "not installed" path instead
   * of guessing at one.
   */
  npxArgs?: string[]
}

// One well-known server per language, matching what's actually installed most
// often in practice (opencode, Claude Code's own editor integrations, and most
// IDEs default to the same handful). elia doesn't install these — a missing
// binary just means diagnostics are silently unavailable for that language
// (see lsp/registry.ts's fail-soft connect).
const EXTENSION_MAP: Record<string, LanguageServerSpec> = {
  '.ts': { languageId: 'typescript', command: 'typescript-language-server', args: ['--stdio'], npxArgs: ['-y', 'typescript-language-server', '--stdio'] },
  '.tsx': { languageId: 'typescriptreact', command: 'typescript-language-server', args: ['--stdio'], npxArgs: ['-y', 'typescript-language-server', '--stdio'] },
  '.mts': { languageId: 'typescript', command: 'typescript-language-server', args: ['--stdio'], npxArgs: ['-y', 'typescript-language-server', '--stdio'] },
  '.js': { languageId: 'javascript', command: 'typescript-language-server', args: ['--stdio'], npxArgs: ['-y', 'typescript-language-server', '--stdio'] },
  '.jsx': { languageId: 'javascriptreact', command: 'typescript-language-server', args: ['--stdio'], npxArgs: ['-y', 'typescript-language-server', '--stdio'] },
  '.mjs': { languageId: 'javascript', command: 'typescript-language-server', args: ['--stdio'], npxArgs: ['-y', 'typescript-language-server', '--stdio'] },
  '.cjs': { languageId: 'javascript', command: 'typescript-language-server', args: ['--stdio'], npxArgs: ['-y', 'typescript-language-server', '--stdio'] },
  '.py': { languageId: 'python', command: 'pyright-langserver', args: ['--stdio'], npxArgs: ['-y', '-p', 'pyright', 'pyright-langserver', '--stdio'] },
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
