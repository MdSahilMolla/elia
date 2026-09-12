import { LspClient } from './client.ts'
import { languageServerFor, type LanguageServerSpec } from './servers.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import type { CodeAction, Command, Diagnostic, Range, WorkspaceEdit } from './protocol.ts'

// null = tried once and the server isn't available (missing binary, failed
// handshake) — cached so a missing typescript-language-server install doesn't
// re-attempt a slow spawn+timeout on every single edit for the rest of the run.
// Keyed by languageId *and* whether the npx fallback was allowed for that
// attempt (see getClient) so the two paths never share a cache entry.
const clients = new Map<string, LspClient | null>()
let shutdownRegistered = false

/**
 * The command+args this run should actually spawn: `spec.command` directly
 * when it's on PATH (the common case, and always the faster start), or —
 * only when the caller explicitly opted in — an `npx` fallback for the
 * handful of servers distributed as an npm package. npx's own
 * fetch-and-run-once behavior IS the "best-effort auto-install", with no
 * separate elevated install step this module has to perform or govern
 * itself, but it can mean a real first-run network fetch, so it is never the
 * default: `diagnosticsForFile` runs on the hot path of every file edit and
 * must keep failing fast when a server genuinely isn't installed, while
 * lsp_refactor's rename/code-action actions are a deliberate, occasional
 * request the model made and can reasonably accept a slower first connect
 * for.
 */
export function resolveSpawnCommand(spec: LanguageServerSpec, allowNpxFallback: boolean): { command: string; args: string[] } {
  if (Bun.which(spec.command)) return { command: spec.command, args: spec.args }
  if (allowNpxFallback && spec.npxArgs && Bun.which('npx')) return { command: 'npx', args: spec.npxArgs }
  return { command: spec.command, args: spec.args }
}

async function getClient(spec: LanguageServerSpec, root: string, allowNpxFallback: boolean): Promise<LspClient | undefined> {
  const cacheKey = `${spec.languageId}:${allowNpxFallback ? 'npx' : 'direct'}`
  if (clients.has(cacheKey)) return clients.get(cacheKey) ?? undefined

  const { command, args } = resolveSpawnCommand(spec, allowNpxFallback)
  const client = new LspClient(command, args, spec.languageId, root)
  try {
    await client.connect()
  } catch {
    clients.set(cacheKey, null)
    client.close()
    return undefined
  }
  clients.set(cacheKey, client)
  if (!shutdownRegistered) {
    shutdownRegistered = true
    registerShutdownCleanup(() => {
      for (const c of clients.values()) c?.close()
    })
  }
  return client
}

/**
 * Best-effort diagnostics for one file's current content. Returns undefined
 * (not an empty array) when no server is configured for this file type or the
 * server isn't available — callers must distinguish "clean" from "unchecked".
 * Never falls back to npx: this runs on every file edit and must fail fast.
 */
export async function diagnosticsForFile(path: string, text: string, root = process.cwd()): Promise<Diagnostic[] | undefined> {
  if (process.env.ELIA_LSP === 'off') return undefined
  const spec = languageServerFor(path)
  if (!spec) return undefined
  const client = await getClient(spec, root, false)
  if (!client) return undefined
  try {
    return await client.diagnosticsFor(path, text)
  } catch {
    return undefined
  }
}

/** Best-effort rename via the language server for `path`'s file type. Undefined (not null) means no server is configured/available — distinct from the server itself declining the rename (null). */
export async function renameSymbol(
  path: string,
  text: string,
  position: { line: number; character: number },
  newName: string,
  root = process.cwd(),
): Promise<WorkspaceEdit | null | undefined> {
  if (process.env.ELIA_LSP === 'off') return undefined
  const spec = languageServerFor(path)
  if (!spec) return undefined
  const client = await getClient(spec, root, true)
  if (!client) return undefined
  try {
    return await client.rename(path, text, position, newName)
  } catch {
    return undefined
  }
}

/** Best-effort code actions via the language server for `path`'s file type. Undefined means no server is configured/available. */
export async function listCodeActions(
  path: string,
  text: string,
  range: Range,
  diagnostics: Diagnostic[] = [],
  root = process.cwd(),
): Promise<(CodeAction | Command)[] | undefined> {
  if (process.env.ELIA_LSP === 'off') return undefined
  const spec = languageServerFor(path)
  if (!spec) return undefined
  const client = await getClient(spec, root, true)
  if (!client) return undefined
  try {
    return await client.codeActions(path, text, range, diagnostics)
  } catch {
    return undefined
  }
}

const SEVERITY_LABEL: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

export function formatDiagnostics(diagnostics: Diagnostic[], path: string): string {
  if (diagnostics.length === 0) return ''
  const sorted = [...diagnostics].sort((a, b) => (a.severity ?? 4) - (b.severity ?? 4))
  const shown = sorted.slice(0, 20)
  const lines = shown.map((d) => `  ${path}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY_LABEL[d.severity ?? 4]}: ${d.message}`)
  const more = diagnostics.length > shown.length ? `\n  ...and ${diagnostics.length - shown.length} more` : ''
  return `\n\nLSP diagnostics:\n${lines.join('\n')}${more}`
}

/** Test-only: drops every cached client (available and known-unavailable) so a fresh call reconnects. */
export function resetLspStateForTests(): void {
  for (const client of clients.values()) client?.close()
  clients.clear()
  shutdownRegistered = false
}
