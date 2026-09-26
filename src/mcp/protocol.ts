import { ELIA_MODES } from './serverTypes.ts'
import type {
  EliaMode,
  JsonSchema,
  McpClientCapabilities,
  McpToolDefinition,
  McpToolExecutionContext,
} from './serverTypes.ts'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcId = number | string | null

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  if (raw.jsonrpc !== '2.0' || !('id' in raw) || (typeof raw.id !== 'number' && typeof raw.id !== 'string')) return false
  if (typeof raw.id === 'number' && !Number.isFinite(raw.id)) return false
  return 'result' in raw || 'error' in raw
}

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  [key: string]: unknown
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
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const MCP_CLIENT_INFO = { name: 'elia', version: '0.1.2' }
export const MCP_SERVER_INFO = { name: 'elia-mcp', version: '0.1.2' }

export interface McpResourceDescriptor {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  [key: string]: unknown
}

export interface McpResourceTemplateDescriptor {
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  [key: string]: unknown
}

export interface McpResourceContents extends McpResourceDescriptor {
  text?: string
  blob?: string
}

export interface McpPromptArgumentDescriptor {
  name: string
  description?: string
  required?: boolean
}

export interface McpPromptDescriptor {
  name: string
  title?: string
  description?: string
  arguments?: McpPromptArgumentDescriptor[]
}

export interface McpPromptMessage {
  role: 'user' | 'assistant'
  content: McpContentBlock
}

export interface McpPromptGetResult {
  description?: string
  messages: McpPromptMessage[]
}

export interface McpToolFilter {
  clientCapabilities?: McpClientCapabilities
  mode?: EliaMode
}

export interface McpProtocolBackend {
  listTools(filter?: McpToolFilter): readonly McpToolDefinition[]
  getTool(name: string, filter?: McpToolFilter): McpToolDefinition | undefined
  callTool(name: string, input: Record<string, unknown>, context: McpToolExecutionContext, signal?: AbortSignal): unknown | Promise<unknown>
  listResources(context: McpToolExecutionContext): readonly McpResourceDescriptor[]
  listResourceTemplates(context: McpToolExecutionContext): readonly McpResourceTemplateDescriptor[]
  readResource(uri: string, context: McpToolExecutionContext): McpResourceContents | McpResourceContents[] | Promise<McpResourceContents | McpResourceContents[]>
  listPrompts(context: McpToolExecutionContext): readonly McpPromptDescriptor[]
  getPrompt(name: string, arguments_: Record<string, string>, context: McpToolExecutionContext): McpPromptGetResult | Promise<McpPromptGetResult>
}

export interface McpProtocolRequestOptions {
  context: McpToolExecutionContext
  clientCapabilities?: McpClientCapabilities
  signal?: AbortSignal
}

export class McpProtocolError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'McpProtocolError'
    this.code = code
    this.data = data
  }
}

const JSON_RPC_PARSE_ERROR = -32_700
const JSON_RPC_INVALID_REQUEST = -32_600
const JSON_RPC_METHOD_NOT_FOUND = -32_601
const JSON_RPC_INVALID_PARAMS = -32_602
const JSON_RPC_INTERNAL_ERROR = -32_603

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || (typeof value === 'string' && value.length <= 256) || (typeof value === 'number' && Number.isFinite(value))
}

function requestId(value: unknown): JsonRpcId {
  return isJsonRpcId(value) ? value : null
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id: id as number, result }
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: '2.0', id: id as number, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function isSameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((entry, index) => isSameValue(entry, right[index]))
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord)
    const rightKeys = Object.keys(rightRecord)
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && isSameValue(leftRecord[key], rightRecord[key]))
  }
  return false
}

function schemaType(value: unknown, type: JsonSchema['type'], nullable: boolean): boolean {
  if (value === null) return nullable === true || type === 'null'
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function validateSchemaValue(value: unknown, schema: JsonSchema, path: string, errors: string[], depth: number): void {
  if (depth > 32) {
    errors.push(`${path}: schema nesting exceeds 32 levels`)
    return
  }
  if (schema.const !== undefined && !isSameValue(value, schema.const)) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some((entry) => isSameValue(entry, value))) errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`)
  if (schema.type && !schemaType(value, schema.type, schema.nullable === true)) {
    errors.push(`${path}: must be ${schema.type}`)
    return
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: must contain at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: must contain at most ${schema.maxLength} characters`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: must match ${schema.pattern}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be at most ${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: must be greater than ${schema.exclusiveMinimum}`)
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${path}: must be less than ${schema.exclusiveMaximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: must contain at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: must contain at most ${schema.maxItems} items`)
    if (schema.uniqueItems === true) {
      const serialized = value.map((entry) => JSON.stringify(entry))
      if (new Set(serialized).size !== serialized.length) errors.push(`${path}: items must be unique`)
    }
    if (schema.items) value.forEach((entry, index) => validateSchemaValue(entry, schema.items!, `${path}[${index}]`, errors, depth + 1))
    if (schema.prefixItems) {
      schema.prefixItems.forEach((itemSchema, index) => {
        if (index < value.length) validateSchemaValue(value[index], itemSchema, `${path}[${index}]`, errors, depth + 1)
      })
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const keys = Object.keys(object)
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${path}: must contain at least ${schema.minProperties} properties`)
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${path}: must contain at most ${schema.maxProperties} properties`)
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(object, required)) errors.push(`${path}.${required}: required property is missing`)
    }
    for (const [key, entry] of Object.entries(object)) {
      const propertySchema = schema.properties?.[key]
      if (propertySchema) validateSchemaValue(entry, propertySchema, `${path}.${key}`, errors, depth + 1)
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property is not allowed`)
      else if (isRecord(schema.additionalProperties)) validateSchemaValue(entry, schema.additionalProperties, `${path}.${key}`, errors, depth + 1)
    }
  }
  if (schema.allOf) schema.allOf.forEach((entry) => validateSchemaValue(value, entry, path, errors, depth + 1))
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((entry) => matchesMcpSchema(value, entry, depth + 1)).length
    if (matches < 1) errors.push(`${path}: must match one allowed schema`)
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((entry) => matchesMcpSchema(value, entry, depth + 1)).length
    if (matches !== 1) errors.push(`${path}: must match exactly one allowed schema`)
  }
  if (schema.not && matchesMcpSchema(value, schema.not, depth + 1)) errors.push(`${path}: must not match the forbidden schema`)
}

function matchesMcpSchema(value: unknown, schema: JsonSchema, depth: number): boolean {
  const errors: string[] = []
  validateSchemaValue(value, schema, '$', errors, depth)
  return errors.length === 0
}

export interface McpSchemaValidationResult {
  valid: boolean
  errors: string[]
}

export function validateMcpSchema(value: unknown, schema: JsonSchema): McpSchemaValidationResult {
  const errors: string[] = []
  validateSchemaValue(value, schema, '$', errors, 0)
  return { valid: errors.length === 0, errors }
}

function requireParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, 'Request params must be an object')
  return value
}

function toolDescriptor(tool: McpToolDefinition): McpToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: {
      title: tool.inventoryId,
      readOnlyHint: !tool.requiresApproval && tool.idempotent,
      destructiveHint: tool.requiresApproval,
      idempotentHint: tool.idempotent,
      openWorldHint: tool.costTier !== 'free' || tool.category === 'DOMAIN_GENERAL',
    },
  }
}

function stringContent(value: unknown): McpContentBlock {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return { type: 'text', text }
}

function structuredContent(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (value === undefined) return { ok: true }
  return { result: value }
}

function toolFailure(error: unknown, code = 'TOOL_EXECUTION_FAILED'): McpToolCallResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [stringContent(message)],
    structuredContent: { error: { code, message } },
    isError: true,
  }
}

async function callTool(backend: McpProtocolBackend, params: unknown, options: McpProtocolRequestOptions): Promise<McpToolCallResult> {
  const call = requireParams(params)
  if (typeof call.name !== 'string') throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, 'tools/call requires params.name')
  if (call.arguments !== undefined && !isRecord(call.arguments)) throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, 'tools/call arguments must be an object')
  const input = call.arguments === undefined ? {} : call.arguments as Record<string, unknown>
  if (call.mode !== undefined && (typeof call.mode !== 'string' || !(ELIA_MODES as readonly string[]).includes(call.mode))) throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, 'tools/call mode must be a supported Elia mode')
  if (call.mode !== undefined && call.mode !== options.context.mode) throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, `tools/call mode "${call.mode}" does not match this server's active mode "${options.context.mode}"; call elia_set_mode to change it`)
  const mode = options.context.mode
  const tool = backend.getTool(call.name, { clientCapabilities: options.clientCapabilities, mode })
  if (!tool) throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, `Tool is unavailable: ${call.name}`)
  const inputValidation = validateMcpSchema(input, tool.inputSchema)
  if (!inputValidation.valid) return toolFailure(new Error(`Invalid input: ${inputValidation.errors.join('; ')}`), 'INVALID_INPUT')
  try {
    const result = await backend.callTool(tool.name, input, options.context, options.signal)
    const structured = structuredContent(result)
    const outputValidation = validateMcpSchema(structured, tool.outputSchema)
    if (!outputValidation.valid) return toolFailure(new Error(`Invalid tool output: ${outputValidation.errors.join('; ')}`), 'INVALID_OUTPUT')
    return { content: [stringContent(result)], structuredContent: structured }
  } catch (error) {
    return toolFailure(error)
  }
}

async function readResource(backend: McpProtocolBackend, params: unknown, context: McpToolExecutionContext): Promise<{ contents: McpResourceContents[] }> {
  const request = requireParams(params)
  if (typeof request.uri !== 'string' || !request.uri) throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, 'resources/read requires params.uri')
  try {
    const result = await backend.readResource(request.uri, context)
    return { contents: Array.isArray(result) ? result : [result] }
  } catch (error) {
    throw new McpProtocolError(JSON_RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
  }
}

function promptArguments(request: Record<string, unknown>): Record<string, string> {
  const raw = request.arguments
  if (raw !== undefined && !isRecord(raw)) throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, 'prompts/get arguments must be an object')
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw === undefined ? {} : raw as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, `Prompt argument ${key} must be a string`)
    result[key] = value
  }
  return result
}

export async function handleMcpRequest(
  requestValue: unknown,
  backend: McpProtocolBackend,
  options: McpProtocolRequestOptions,
): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(requestValue) || requestValue.jsonrpc !== '2.0' || typeof requestValue.method !== 'string' || requestValue.method.length === 0) {
    return failure(requestId(isRecord(requestValue) ? requestValue.id : null), JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC request')
  }
  const isNotification = !Object.hasOwn(requestValue, 'id')
  if (!isNotification && !isJsonRpcId(requestValue.id)) {
    return failure(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC request id')
  }
  const id: JsonRpcId = isNotification ? null : requestValue.id as JsonRpcId
  const method = requestValue.method
  if (method === 'notifications/initialized' || method === 'initialized') {
    return isNotification ? undefined : success(id, {})
  }
  if (isNotification && (method === 'notifications/cancelled' || method.startsWith('notifications/'))) return undefined
  let result: unknown
  try {
    switch (method) {
      case 'initialize': {
        const params = requireParams(requestValue.params)
        if (params.protocolVersion !== undefined && typeof params.protocolVersion !== 'string') throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, 'initialize protocolVersion must be a string')
        result = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
            logging: {},
          },
          serverInfo: MCP_SERVER_INFO,
        }
        break
      }
      case 'ping':
        result = {}
        break
      case 'tools/list':
        result = { tools: backend.listTools({ clientCapabilities: options.clientCapabilities, mode: options.context.mode }).map(toolDescriptor) }
        break
      case 'tools/call':
        result = await callTool(backend, requestValue.params, options)
        break
      case 'resources/list':
        result = { resources: backend.listResources(options.context) }
        break
      case 'resources/templates/list':
        result = { resourceTemplates: backend.listResourceTemplates(options.context) }
        break
      case 'resources/read':
        result = await readResource(backend, requestValue.params, options.context)
        break
      case 'prompts/list':
        result = { prompts: backend.listPrompts(options.context) }
        break
      case 'prompts/get': {
        const promptRequest = requireParams(requestValue.params)
        if (typeof promptRequest.name !== 'string' || !promptRequest.name) throw new McpProtocolError(JSON_RPC_INVALID_PARAMS, 'prompts/get requires params.name')
        const args = promptArguments(promptRequest)
        try {
          result = await backend.getPrompt(promptRequest.name, args, options.context)
        } catch (error) {
          throw new McpProtocolError(JSON_RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
        }
        break
      }
      default:
        throw new McpProtocolError(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  } catch (error) {
    if (isNotification) return undefined
    if (error instanceof McpProtocolError) return failure(id, error.code, error.message, error.data)
    return failure(id, JSON_RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
  }
  return isNotification ? undefined : success(id, result)
}

export async function handleMcpMessage(message: unknown, backend: McpProtocolBackend, options: McpProtocolRequestOptions): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (Array.isArray(message)) {
    if (message.length === 0) return failure(null, JSON_RPC_INVALID_REQUEST, 'A JSON-RPC batch cannot be empty')
    const responses: JsonRpcResponse[] = []
    for (const request of message) {
      const response = await handleMcpRequest(request, backend, options)
      if (response) responses.push(response)
    }
    return responses.length > 0 ? responses : undefined
  }
  return handleMcpRequest(message, backend, options)
}

export function mcpParseError(message: string): JsonRpcFailure {
  return failure(null, JSON_RPC_PARSE_ERROR, 'Parse error', { message })
}
