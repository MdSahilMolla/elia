import type { Tool } from '../tools/types.ts'
import { registerMcpTool, clearMcpToolsForTests } from '../tools/registry.ts'
import { loadMcpServerConfigs, type McpServerConfig } from './config.ts'
import { McpClient } from './client.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'

export interface McpLoadReport {
  servers: string[]
  loaded: { name: string; server: string }[]
  failed: { server: string; reason: string }[]
  configErrors: string[]
}

let loadedOnce = false
let lastReport: McpLoadReport = { servers: [], loaded: [], failed: [], configErrors: [] }
const liveClients: McpClient[] = []

/**
 * Connects to every configured MCP server (`.elia/mcp.json` / `~/.elia/mcp.json`),
 * lists its tools, and registers each as an elia Tool via `registerMcpTool`. One
 * server failing to start or handshake is logged and skipped — matching the
 * skill loader's philosophy (skills/loader.ts): a bad extension costs elia one
 * capability, not the whole startup.
 *
 * Idempotent per process: repeat calls (loadRuntimeSkills runs on nearly every
 * command path) return the cached report instead of respawning every server.
 */
export async function loadMcpTools(cwd = process.cwd()): Promise<McpLoadReport> {
  if (loadedOnce) return lastReport
  loadedOnce = true

  const { servers, errors: configErrors } = loadMcpServerConfigs(cwd)
  const report: McpLoadReport = { servers: [], loaded: [], failed: [], configErrors }

  const enabled = servers.filter((server) => !server.disabled)
  await Promise.all(enabled.map((server) => connectServer(server, report)))

  if (liveClients.length > 0) {
    registerShutdownCleanup(() => {
      for (const client of liveClients) client.close()
    })
  }

  lastReport = report
  return report
}

async function connectServer(config: McpServerConfig, report: McpLoadReport): Promise<void> {
  const client = new McpClient(config)
  try {
    await client.connect()
    const { tools } = await client.listTools()
    for (const descriptor of tools) {
      const tool = wrapMcpTool(client, config.name, descriptor)
      registerMcpTool(tool)
      report.loaded.push({ name: tool.name, server: config.name })
    }
    liveClients.push(client)
    report.servers.push(config.name)
  } catch (err) {
    client.close()
    report.failed.push({ server: config.name, reason: err instanceof Error ? err.message : String(err) })
  }
}

const NAME_SANITIZE_PATTERN = /[^a-z0-9_]/g

function toolName(server: string, toolName: string): string {
  const raw = `mcp_${server}_${toolName}`.toLowerCase().replace(NAME_SANITIZE_PATTERN, '_').replace(/_+/g, '_')
  return raw.slice(0, 64).replace(/_+$/, '') || `mcp_${server}_tool`
}

function wrapMcpTool(client: McpClient, server: string, descriptor: { name: string; description?: string; inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] } }): Tool {
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
  lastReport = { servers: [], loaded: [], failed: [], configErrors: [] }
  // Wait for each subprocess to actually be reaped, not just signaled — otherwise
  // bun test's cross-file dangling-process sweep can race a still-tearing-down
  // pipe and surface a stray EPIPE attributed to some unrelated later file.
  await Promise.all(liveClients.splice(0).map((client) => client.closeAndWait()))
  clearMcpToolsForTests()
}
