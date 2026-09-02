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
let loadPromise: Promise<McpLoadReport> | undefined
let lastReport: McpLoadReport = emptyReport()

/**
 * How long any startup path waits for MCP servers to finish connecting before it
 * proceeds. A healthy local stdio server handshakes in well under a second; a
 * cold `npx -y some-mcp-server` can take 10-30s to resolve and download. Neither
 * a one-shot `elia agent` nor the REPL should sit blocked for the slow case —
 * stragglers keep connecting in the background and their tools register (and
 * become usable on the next turn) whenever they're ready.
 */
function mcpSoftDeadlineMs(): number {
  return Number.parseInt(process.env.ELIA_MCP_CONNECT_DEADLINE_MS ?? '', 10) || 2_500
}
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
/**
 * Kicks off {@link loadMcpTools} without waiting for it, and hands back the
 * single in-flight promise so a later caller can await the same connect pass
 * instead of racing it (a second bare `loadMcpTools()` call while the first is
 * still connecting would see `loadedOnce` already set and return the empty
 * report). Call this at the very top of an interactive startup so MCP servers
 * spawn and handshake *while* the intro plays and the user reads the prompt,
 * rather than blocking the REPL for the sum of every server's startup time.
 */
export function beginMcpLoad(cwd = process.cwd()): Promise<McpLoadReport> {
  if (!loadPromise) loadPromise = loadMcpTools(cwd)
  return loadPromise
}

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
  // connectServer mutates `report` and registers tools as each server finishes,
  // whenever that is — so a straggler that lands after the deadline still becomes
  // usable, it just isn't counted in the report handed back to the startup path.
  const allConnected = Promise.all(enabled.map((server) => connectServer(server, report, statusByName.get(server.name)!)))
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, mcpSoftDeadlineMs())
  })
  await Promise.race([allConnected, deadline])
  if (deadlineTimer) clearTimeout(deadlineTimer)
  // A straggler keeps connecting and registering its tools; just make sure a
  // rejection from the abandoned wait can't surface as an unhandled rejection.
  void allConnected.catch(() => {})

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
  loadPromise = undefined
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
  loadPromise = undefined
  lastReport = emptyReport()
  // Wait for each subprocess to actually be reaped, not just signaled — otherwise
  // bun test's cross-file dangling-process sweep can race a still-tearing-down
  // pipe and surface a stray EPIPE attributed to some unrelated later file.
  await Promise.all(liveClients.splice(0).map((client) => client.closeAndWait()))
  clearMcpTools()
  clearBrowserMcpToolsForTests()
}
