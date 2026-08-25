import { LspClient } from './client.ts'
import { languageServerFor } from './servers.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import type { Diagnostic } from './protocol.ts'

// null = tried once and the server isn't available (missing binary, failed
// handshake) — cached so a missing typescript-language-server install doesn't
// re-attempt a slow spawn+timeout on every single edit for the rest of the run.
const clients = new Map<string, LspClient | null>()
let shutdownRegistered = false

async function getClient(spec: { languageId: string; command: string; args: string[] }, root: string): Promise<LspClient | undefined> {
  if (clients.has(spec.languageId)) return clients.get(spec.languageId) ?? undefined

  const client = new LspClient(spec.command, spec.args, spec.languageId, root)
  try {
    await client.connect()
  } catch {
    clients.set(spec.languageId, null)
    client.close()
    return undefined
  }
  clients.set(spec.languageId, client)
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
 */
export async function diagnosticsForFile(path: string, text: string, root = process.cwd()): Promise<Diagnostic[] | undefined> {
  if (process.env.ELIA_LSP === 'off') return undefined
  const spec = languageServerFor(path)
  if (!spec) return undefined
  const client = await getClient(spec, root)
  if (!client) return undefined
  try {
    return await client.diagnosticsFor(path, text)
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
