import type { McpToolCallResult, McpToolsListResult } from './protocol.ts'

/**
 * The shared surface `registry.ts` drives, so a locally spawned stdio server
 * (`McpClient`) and a hosted connector reached over HTTP (`McpHttpClient`) are
 * interchangeable from the loader's point of view.
 */
export interface McpTransport {
  readonly name: string
  connect(): Promise<void>
  listTools(): Promise<McpToolsListResult>
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>
  /** Fire-and-forget teardown — safe to use as a shutdown-cleanup callback. */
  close(): void
  /** Teardown that waits for resources to actually be released (used by tests). */
  closeAndWait(): Promise<void>
}
