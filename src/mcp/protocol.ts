/** Minimal MCP/JSON-RPC 2.0 types — only the shapes elia's client actually sends or reads. */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return typeof value === 'object' && value !== null && 'id' in value && ('result' in value || 'error' in value)
}

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] }
}

export interface McpToolsListResult {
  tools: McpToolDescriptor[]
  nextCursor?: string
}

export interface McpContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface McpToolCallResult {
  content?: McpContentBlock[]
  isError?: boolean
}

export const MCP_PROTOCOL_VERSION = '2024-11-05'

export const MCP_CLIENT_INFO = { name: 'elia', version: '0.1.2' }
