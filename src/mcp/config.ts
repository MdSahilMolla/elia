import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { projectMcpConfigPath, userMcpConfigPath } from './paths.ts'

/**
 * One configured MCP server. Two shapes:
 *  - **stdio** (`command` [+ `args`, `env`]) — a local process spawned over stdio,
 *    the same shape Claude Desktop and most other MCP hosts use for `mcpServers`,
 *    so an existing config can be copied in with no translation.
 *  - **remote / connector** (`url` [+ `headers`, `transport`]) — a hosted MCP
 *    endpoint reached over HTTP (Streamable HTTP by default, `"transport": "sse"`
 *    for a legacy SSE endpoint). `headers` carries auth (e.g. `Authorization`).
 */
export interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  transport?: 'stdio' | 'http' | 'sse'
  disabled?: boolean
}

export type McpConfigScope = 'project' | 'user'

const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/i

/** True for a name safe to use as a config key and in a `mcp_<server>_<tool>` id. */
export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name)
}

/** stdio vs. remote, derived from which fields are set. */
export function mcpTransportKind(server: McpServerConfig): 'stdio' | 'http' | 'sse' {
  if (server.transport === 'sse') return 'sse'
  if (typeof server.url === 'string') return 'http'
  return 'stdio'
}

/** A connector is any server reached over the network rather than spawned locally. */
export function isConnector(server: McpServerConfig): boolean {
  return typeof server.url === 'string'
}

function scopePath(scope: McpConfigScope, cwd: string): string {
  return scope === 'project' ? projectMcpConfigPath(cwd) : userMcpConfigPath()
}

/**
 * Reads `.elia/mcp.json` (project) and `~/.elia/mcp.json` (user), each shaped
 * `{ "mcpServers": { "<name>": { ... } } }`. Project entries override user
 * entries with the same name, so a repo can pin or disable a server a user has
 * configured globally.
 */
export function loadMcpServerConfigs(cwd = process.cwd(), userPath = userMcpConfigPath()): { servers: McpServerConfig[]; errors: string[] } {
  const errors: string[] = []
  const byName = new Map<string, McpServerConfig>()

  for (const [path, layer] of [[userPath, 'user'], [projectMcpConfigPath(cwd), 'project']] as const) {
    if (!existsSync(path)) continue
    const parsed = parseConfigFile(path, layer, errors)
    for (const server of parsed) byName.set(server.name, server)
  }

  return { servers: [...byName.values()], errors }
}

/** Which layer a server named `name` is defined in, if any — needed before toggling or removing it. */
export function findMcpServerScope(name: string, cwd = process.cwd(), userPath = userMcpConfigPath()): McpConfigScope | null {
  for (const [path, scope] of [[projectMcpConfigPath(cwd), 'project'], [userPath, 'user']] as const) {
    if (!existsSync(path)) continue
    const parsed = parseConfigFile(path, scope, [])
    if (parsed.some((server) => server.name === name)) return scope
  }
  return null
}

function parseConfigFile(path: string, layer: string, errors: string[]): McpServerConfig[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    errors.push(`${layer} MCP config ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    errors.push(`${layer} MCP config ${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
    return []
  }

  if (typeof json !== 'object' || json === null || !('mcpServers' in json)) {
    errors.push(`${layer} MCP config ${path}: expected a top-level "mcpServers" object`)
    return []
  }

  const serversRaw = (json as { mcpServers: unknown }).mcpServers
  if (typeof serversRaw !== 'object' || serversRaw === null) {
    errors.push(`${layer} MCP config ${path}: "mcpServers" must be an object`)
    return []
  }

  const servers: McpServerConfig[] = []
  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      errors.push(`${layer} MCP config ${path}: skipping server "${name}" — name must be alphanumeric/underscore/dash`)
      continue
    }
    if (typeof value !== 'object' || value === null) {
      errors.push(`${layer} MCP config ${path}: skipping server "${name}" — entry must be an object`)
      continue
    }
    const entry = value as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; transport?: unknown; disabled?: unknown }
    const hasUrl = typeof entry.url === 'string'
    const hasCommand = typeof entry.command === 'string'
    if (!hasUrl && !hasCommand) {
      errors.push(`${layer} MCP config ${path}: skipping server "${name}" — needs a string "command" (stdio) or "url" (connector)`)
      continue
    }

    const disabled = entry.disabled === true
    if (hasUrl) {
      const server: McpServerConfig = { name, url: entry.url as string, disabled }
      if (entry.transport === 'sse' || entry.transport === 'http') server.transport = entry.transport
      const headers = parseStringMap(entry.headers)
      if (headers) server.headers = headers
      servers.push(server)
      continue
    }

    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : undefined
    const env = parseStringMap(entry.env)
    servers.push({ name, command: entry.command as string, args, env, disabled })
  }
  return servers
}

function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  )
}

// ---------- writes ----------

function readConfigObject(path: string): { mcpServers: Record<string, Record<string, unknown>> } {
  if (!existsSync(path)) return { mcpServers: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      const servers = (parsed as { mcpServers?: unknown }).mcpServers
      return { ...(parsed as object), mcpServers: servers && typeof servers === 'object' ? (servers as Record<string, Record<string, unknown>>) : {} }
    }
  } catch {
    // A corrupt file is replaced rather than merged — the caller is explicitly asking to write.
  }
  return { mcpServers: {} }
}

function writeConfigObject(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/** Turns a McpServerConfig into the minimal on-disk entry (no `name`, no empty maps). */
export function serverConfigToEntry(server: Omit<McpServerConfig, 'name'>): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  if (server.url) {
    entry.url = server.url
    if (server.transport && server.transport !== 'http') entry.transport = server.transport
    if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers
  } else {
    entry.command = server.command
    if (server.args && server.args.length > 0) entry.args = server.args
    if (server.env && Object.keys(server.env).length > 0) entry.env = server.env
  }
  if (server.disabled) entry.disabled = true
  return entry
}

/** Adds or replaces one server in the given layer. Returns the file it wrote. */
export function upsertMcpServer(scope: McpConfigScope, server: McpServerConfig, cwd = process.cwd()): string {
  if (!isValidMcpServerName(server.name)) throw new Error(`invalid server name "${server.name}" — use letters, digits, "_" or "-"`)
  const path = scopePath(scope, cwd)
  const data = readConfigObject(path)
  const { name, ...rest } = server
  data.mcpServers[name] = serverConfigToEntry(rest)
  writeConfigObject(path, data)
  return path
}

/** Removes one server from the given layer. Returns whether it was there. */
export function removeMcpServer(scope: McpConfigScope, name: string, cwd = process.cwd()): { path: string; removed: boolean } {
  const path = scopePath(scope, cwd)
  const data = readConfigObject(path)
  const removed = name in data.mcpServers
  delete data.mcpServers[name]
  if (removed) writeConfigObject(path, data)
  return { path, removed }
}

/** Flips `disabled` on one server in the given layer. Returns the new state, or null if the server isn't in that layer. */
export function setMcpServerDisabled(scope: McpConfigScope, name: string, disabled: boolean, cwd = process.cwd()): { path: string; disabled: boolean } | null {
  const path = scopePath(scope, cwd)
  const data = readConfigObject(path)
  const entry = data.mcpServers[name]
  if (!entry) return null
  if (disabled) entry.disabled = true
  else delete entry.disabled
  writeConfigObject(path, data)
  return { path, disabled }
}
