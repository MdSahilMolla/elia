import { homedir } from 'node:os'
import { join } from 'node:path'

/** Project-level MCP server config — checked into the repo, shared with the team. */
export function projectMcpConfigPath(cwd = process.cwd()): string {
  return join(cwd, '.elia', 'mcp.json')
}

/**
 * User-level MCP server config — personal servers (credentials, local paths) not
 * meant for the repo. `ELIA_MCP_USER_CONFIG` overrides the location (tests point
 * it at a temp file so they never touch the real `~/.elia/mcp.json`).
 */
export function userMcpConfigPath(): string {
  return process.env.ELIA_MCP_USER_CONFIG || join(homedir(), '.elia', 'mcp.json')
}
