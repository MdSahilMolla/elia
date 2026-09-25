/**
 * Boundary timeouts shared by both MCP transports — the local stdio `McpClient`
 * and the streamable-HTTP `McpHttpClient`. A timeout value is defined exactly
 * once here; duplicating it in the two clients let the copies drift (the http
 * client once used 20s for connect where the stdio client used 30s) and left
 * nobody able to see, from one place, what a dead server is allowed to pin a
 * call for.
 */
export const MCP_CONNECT_TIMEOUT_MS = 30_000
export const MCP_CALL_TIMEOUT_MS = 120_000