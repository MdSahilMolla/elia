/**
 * Delegates stdio MCP servers to the `eliad` daemon.
 *
 * The daemon keeps each `command`-style server spawned and handshaken across
 * `elia` invocations, so a cold `elia agent` skips the spawn + `initialize` +
 * `tools/list` round-trip that a `npx some-mcp-server` costs. HTTP connectors
 * are unaffected — they stay on the in-process client.
 *
 * Every function throws {@link DaemonUnavailable} when the daemon is off or
 * unreachable; `registry.ts` then falls back to connecting the servers itself.
 */

import { daemonClient, daemonEnabled, DaemonUnavailable } from '../daemon/index.ts'
import type { McpServerConfig } from './config.ts'

export interface DaemonMcpToolDescriptor {
  server: string
  name: string
  description?: string
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] }
}

export interface DaemonMcpEnsureResult {
  tools: DaemonMcpToolDescriptor[]
  failed: { server: string; reason: string }[]
}

export interface DaemonMcpCallResult {
  content?: { type: string; text?: string }[]
  isError?: boolean
}

export function daemonMcpEnabled(): boolean {
  return daemonEnabled()
}

/** Ensure the daemon has these stdio servers resident; returns the union of
 * their tools plus any that failed to start. */
export async function daemonEnsureMcp(servers: McpServerConfig[]): Promise<DaemonMcpEnsureResult> {
  if (!daemonEnabled()) throw new DaemonUnavailable('ELIA_DAEMON=off')
  const payload = servers
    .filter((s) => typeof s.command === 'string' && s.command.length > 0)
    .map((s) => ({ name: s.name, command: s.command as string, args: s.args ?? [], env: s.env ?? {} }))
  const { result } = await daemonClient().call('mcp.ensure', { servers: payload }, 45_000)
  return result as DaemonMcpEnsureResult
}

/** Proxy one `tools/call` through the daemon to a resident server. */
export async function daemonCallMcp(
  server: string,
  tool: string,
  args: unknown,
): Promise<DaemonMcpCallResult> {
  if (!daemonEnabled()) throw new DaemonUnavailable('ELIA_DAEMON=off')
  const { result } = await daemonClient().call(
    'mcp.call',
    { server, tool, arguments: args ?? {} },
    130_000,
  )
  return result as DaemonMcpCallResult
}
