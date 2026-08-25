import { existsSync, readFileSync } from 'node:fs'
import { projectMcpConfigPath, userMcpConfigPath } from './paths.ts'

/**
 * One configured MCP server, spawned over stdio — same shape Claude Desktop and
 * most other MCP hosts use for `mcpServers`, so an existing config can be copied
 * in with no translation.
 */
export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
}

const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/i

/**
 * Reads `.elia/mcp.json` (project) and `~/.elia/mcp.json` (user), each shaped
 * `{ "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }`.
 * Project entries override user entries with the same name, so a repo can pin or
 * disable a server a user has configured globally.
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
    if (typeof value !== 'object' || value === null || typeof (value as { command?: unknown }).command !== 'string') {
      errors.push(`${layer} MCP config ${path}: skipping server "${name}" — missing string "command"`)
      continue
    }
    const entry = value as { command: string; args?: unknown; env?: unknown; disabled?: unknown }
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : undefined
    const env =
      typeof entry.env === 'object' && entry.env !== null
        ? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
        : undefined
    servers.push({ name, command: entry.command, args, env, disabled: entry.disabled === true })
  }
  return servers
}
