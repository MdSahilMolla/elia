/**
 * Shared connection plumbing for workspace clients — resolving which server to
 * talk to and opening an authenticated WebSocket to it.
 *
 * Both `elia workspace ...` (see cli.ts) and the in-REPL `/eliaspace` panel use
 * this. The CLI opts into auto-spawning a local server; the REPL panel never
 * does — glancing at status shouldn't fork a daemon as a side effect.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { paths } from '../statePaths.ts'
import { WorkspaceClient } from './client.ts'
import type { WorkspaceServerInfo } from './server.ts'
import type { PersistedEvent } from './events.ts'

/** Read the address a locally running server advertised for auto-attach. */
export function readServerInfo(): WorkspaceServerInfo | undefined {
  if (!existsSync(paths.workspaceServerInfo)) return undefined
  try {
    const info = JSON.parse(readFileSync(paths.workspaceServerInfo, 'utf8')) as WorkspaceServerInfo
    return typeof info.url === 'string' && info.url.startsWith('ws') ? info : undefined
  } catch {
    return undefined
  }
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed.includes('/workspace') ? trimmed : `${trimmed.replace(/\/$/, '')}/workspace`
  }
  return `ws://${trimmed.replace(/\/$/, '')}/workspace`
}

export function workspaceTokenFromEnv(): string | undefined {
  return process.env.ELIA_WORKSPACE_TOKEN?.trim() || undefined
}

export interface ResolvedServer {
  url: string
  /** How the address was found: an explicit override, a locally advertised server, one we started, or nothing yet. */
  source: 'explicit' | 'advertised' | 'spawned' | 'none'
  spawned: boolean
}

export interface ResolveOptions {
  /** An explicit `--server` / `$ELIA_WORKSPACE_SERVER` value. */
  explicit?: string
  /** Start a detached local server if none is reachable (CLI only). */
  autoSpawn?: boolean
}

export async function resolveServer(options: ResolveOptions = {}): Promise<ResolvedServer> {
  const explicit = options.explicit?.trim() || process.env.ELIA_WORKSPACE_SERVER?.trim()
  if (explicit) return { url: normalizeUrl(explicit), source: 'explicit', spawned: false }

  const advertised = readServerInfo()
  if (advertised) return { url: advertised.url, source: 'advertised', spawned: false }

  if (!options.autoSpawn) return { url: normalizeUrl('127.0.0.1:0'), source: 'none', spawned: false }

  // Auto-spawn a local server and wait for it to advertise its address.
  const entry = fileURLToPath(new URL('../../bin/elia.ts', import.meta.url))
  const child = Bun.spawn([process.execPath, entry, 'workspace', 'serve'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true,
    env: { ...process.env, NO_COLOR: '1' },
  })
  child.unref()
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const info = readServerInfo()
    if (info) return { url: info.url, source: 'spawned', spawned: true }
    await Bun.sleep(120)
  }
  throw new Error('auto-started workspace server did not come up within 8s; start it with "elia workspace serve"')
}

export interface OpenClientOptions extends ResolveOptions {
  token?: string
  onEvent?: (event: PersistedEvent) => void
}

/** Resolve a server and open an authenticated client to it. The caller closes it. */
export async function openWorkspaceClient(
  options: OpenClientOptions = {},
): Promise<{ client: WorkspaceClient; server: ResolvedServer }> {
  const token = options.token?.trim() || workspaceTokenFromEnv()
  if (!token) throw new Error('a workspace token is required — set $ELIA_WORKSPACE_TOKEN or pass --token')
  const server = await resolveServer(options)
  if (server.source === 'none') {
    throw new Error('no workspace server is running — start one with "elia workspace serve"')
  }
  const client = await WorkspaceClient.connect({ url: server.url, token, onEvent: options.onEvent })
  return { client, server }
}
