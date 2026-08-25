import { homedir } from 'node:os'
import { join } from 'node:path'

/** Project-level MCP server config — checked into the repo, shared with the team. */
export function projectMcpConfigPath(cwd = process.cwd()): string {
  return join(cwd, '.elia', 'mcp.json')
}

/** User-level MCP server config — personal servers (credentials, local paths) not meant for the repo. */
export function userMcpConfigPath(): string {
  return join(homedir(), '.elia', 'mcp.json')
}
