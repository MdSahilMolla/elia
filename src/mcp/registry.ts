import type { Tool } from '../tools/types.ts'
import { registerMcpTool, clearMcpTools } from '../tools/registry.ts'
import { loadMcpServerConfigs, mcpTransportKind, type McpServerConfig } from './config.ts'
import { McpClient } from './client.ts'
import { McpHttpClient } from './httpClient.ts'
import type { McpTransport } from './transport.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { clearBrowserMcpToolsForTests, registerBrowserMcpTool } from './browserRegistry.ts'

export interface McpLoadReport {
  servers: string[]
  loaded: { name: string; server: string }[]
  failed: { server: string; reason: string }[]
  configErrors: string[]
  /** Every configured server and how it's doing right now — drives `/mcp` and `/connector`. */
  status: McpServerStatus[]
}

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  connector: boolean
  disabled: boolean
  connected: boolean
  toolCount: number
  tools: string[]
  error?: string
}

let loadedOnce = false
let lastReport: McpLoadReport = emptyReport()
const liveClients: McpTransport[] = []
let shutdownRegistered = false

function emptyReport(): McpLoadReport {
  return { servers: [], loaded: [], failed: [], configErrors: [], status: [] }
}

function makeClient(config: McpServerConfig): McpTransport {
  return mcpTransportKind(config) === 'stdio' ? new McpClient(config) : new McpHttpClient(config)
}

/**
 * Connects to every configured MCP server (`.elia/mcp.json` / `~/.elia/mcp.json`),
 * lists its tools, and registers each as an elia Tool via `registerMcpTool`.
 * Local `command` servers connect over stdio; `url` servers ("connectors")
 * connect over HTTP. One server failing to start or handshake is logged and
 * skipped — matching the skill loader's philosophy: a bad extension costs elia
 * one capability, not the whole startup.
 *
 * Idempotent per process: repeat calls (loadRuntimeSkills runs on nearly every
 * command path) return the cached report instead of respawning every server.
 * Use `reloadMcpTools` to force a reconnect after editing the config.
 */
export async function loadMcpTools(cwd = process.cwd()): Promise<McpLoadReport> {
  if (loadedOnce) return lastReport
  loadedOnce = true

  const { servers, errors: configErrors } = loadMcpServerConfigs(cwd)
  const report: McpLoadReport = { ...emptyReport(), configErrors }

  const statusByName = new Map<string, McpServerStatus>()
  for (const server of servers) {
    statusByName.set(server.name, {
      name: server.name,
      transport: mcpTransportKind(server),
      connector: typeof server.url === 'string',
      disabled: server.disabled === true,
      connected: false,
      toolCount: 0,
      tools: [],
      error: server.disabled ? 'disabled' : undefined,
    })
  }

  const enabled = servers.filter((server) => !server.disabled)
  await Promise.all(enabled.map((server) => connectServer(server, report, statusByName.get(server.name)!)))

  if (liveClients.length > 0 && !shutdownRegistered) {
    shutdownRegistered = true
    registerShutdownCleanup(() => {
      for (const client of liveClients) client.close()
    })
  }

  report.status = [...statusByName.values()]
  lastReport = report
  return report
}

/** Tears down every live connection and reconnects from the current config on disk. */
export async function reloadMcpTools(cwd = process.cwd()): Promise<McpLoadReport> {
  await Promise.all(liveClients.splice(0).map((client) => client.closeAndWait().catch(() => {})))
  clearMcpTools()
  clearBrowserMcpToolsForTests()
  loadedOnce = false
  lastReport = emptyReport()
  return loadMcpTools(cwd)
}

/** Await live transport teardown so a completed one-shot CLI command can exit cleanly. */
export async function shutdownMcpTools(): Promise<void> {
  await Promise.all(liveClients.splice(0).map((client) => client.closeAndWait().catch(() => {})))
}

/** The last load/reload result — what `/mcp` and `/connector` render without reconnecting. */
export function mcpStatusReport(): McpLoadReport {
  return lastReport
}

async function connectServer(config: McpServerConfig, report: McpLoadReport, status: McpServerStatus): Promise<void> {
  const client = makeClient(config)
  try {
    await client.connect()
    const { tools } = await client.listTools()
    for (const descriptor of tools) {
      const tool = wrapMcpTool(client, config.name, descriptor)
      registerMcpTool(tool)
      registerBrowserMcpTool(config.name, descriptor.name, tool)
      report.loaded.push({ name: tool.name, server: config.name })
      status.tools.push(tool.name)
    }
    status.connected = true
    status.toolCount = tools.length
    status.error = undefined
    liveClients.push(client)
    report.servers.push(config.name)
  } catch (err) {
    client.close()
    const reason = err instanceof Error ? err.message : String(err)
    report.failed.push({ server: config.name, reason })
    status.error = reason
  }
}

const NAME_SANITIZE_PATTERN = /[^a-z0-9_]/g

function toolName(server: string, toolName: string): string {
  const raw = `mcp_${server}_${toolName}`.toLowerCase().replace(NAME_SANITIZE_PATTERN, '_').replace(/_+/g, '_')
  return raw.slice(0, 64).replace(/_+$/, '') || `mcp_${server}_tool`
}

function wrapMcpTool(client: McpTransport, server: string, descriptor: { name: string; description?: string; inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] } }): Tool {
  const schema = descriptor.inputSchema
  const input_schema: Tool['input_schema'] = {
    type: 'object',
    properties: schema && typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {},
    required: schema?.required,
  }

  return {
    name: toolName(server, descriptor.name),
    description: `[MCP: ${server}] ${descriptor.description ?? descriptor.name}`,
    input_schema,
    async execute(input) {
      const result = await client.callTool(descriptor.name, input)
      const text = flattenContent(result.content)
      return result.isError ? `MCP tool error: ${text}` : text
    },
  }
}

function flattenContent(content: { type: string; text?: string }[] | undefined): string {
  if (!content || content.length === 0) return '(no content returned)'
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[non-text content: ${block.type}]`))
    .join('\n')
}

/** Test-only: resets the load-once guard so a fresh loadMcpTools() call reconnects. */
export async function resetMcpLoadStateForTests(): Promise<void> {
  loadedOnce = false
  lastReport = emptyReport()
  // Wait for each subprocess to actually be reaped, not just signaled — otherwise
  // bun test's cross-file dangling-process sweep can race a still-tearing-down
  // pipe and surface a stray EPIPE attributed to some unrelated later file.
  await Promise.all(liveClients.splice(0).map((client) => client.closeAndWait()))
  clearMcpTools()
  clearBrowserMcpToolsForTests()
}
