import type { SessionBus } from '../session/types.ts'

export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

export interface JsonSchema {
  type?: JsonSchemaType
  description?: string
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  prefixItems?: readonly JsonSchema[]
  enum?: readonly unknown[]
  const?: unknown
  default?: unknown
  examples?: readonly unknown[]
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minProperties?: number
  maxProperties?: number
  format?: string
  anyOf?: readonly JsonSchema[]
  oneOf?: readonly JsonSchema[]
  allOf?: readonly JsonSchema[]
  not?: JsonSchema
  nullable?: boolean
}

export const ToolCategory = {
  AGENT_LOOP: 'AGENT_LOOP',
  SESSION: 'SESSION',
  MEMORY: 'MEMORY',
  SELF_IMPROVEMENT: 'SELF_IMPROVEMENT',
  SPECIALIST: 'SPECIALIST',
  GOVERNANCE: 'GOVERNANCE',
  CONFIG: 'CONFIG',
  OBSERVABILITY: 'OBSERVABILITY',
  DOMAIN_GENERAL: 'DOMAIN_GENERAL',
} as const

export type ToolCategory = (typeof ToolCategory)[keyof typeof ToolCategory]

export type EliaMode = 'dev' | 'research' | 'data' | 'finance' | 'security' | 'battmann' | 'presentation' | 'general'

export type CostTier = 'free' | 'cheap' | 'model-call' | 'expensive'

export const ELIA_MODES = ['dev', 'research', 'data', 'finance', 'security', 'battmann', 'presentation', 'general'] as const
export const COST_TIERS = ['free', 'cheap', 'model-call', 'expensive'] as const

export type McpProgressStatus = 'starting' | 'progress' | 'completed' | 'failed' | 'cancelled'

export interface McpProgressEvent {
  type: string
  runId?: string
  sessionId?: string
  tool?: string
  status?: McpProgressStatus
  progress?: number
  total?: number
  message?: string
  data?: unknown
  at?: number
}

export type McpPlanStatus = 'proposed' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface McpPlanRecord {
  id: string
  goal: string
  status: McpPlanStatus
  steps: string[]
  createdAt: number
  updatedAt: number
  approvedAt?: number
  mode?: EliaMode
  runId?: string
  metadata?: Record<string, unknown>
}

export type McpRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'aborted'

export interface McpRunState {
  runId: string
  status: McpRunStatus
  startedAt: number
  updatedAt: number
  completedAt?: number
  sessionId?: string
  planId?: string
  mode?: EliaMode
  costUsd?: number
  error?: string
  result?: unknown
}

export interface McpImportedContext {
  id: string
  source: string
  content: string
  importedAt: number
  mimeType?: string
  metadata?: Record<string, unknown>
}

export interface McpGovernedMutationRequest {
  name: string
  input: Record<string, unknown>
}

export interface McpGovernedMutation {
  <T>(name: string, input: Record<string, unknown>, mutate: () => T | Promise<T>): Promise<T>
  <T>(request: McpGovernedMutationRequest, mutate: () => T | Promise<T>): Promise<T>
}

export interface McpToolExecutionContext {
  cwd: string
  config: McpServerRuntimeConfig
  sessionBus: SessionBus
  mode: EliaMode
  signal?: AbortSignal
  emit: (event: McpProgressEvent) => void
  governedMutation: McpGovernedMutation
  plans: Map<string, McpPlanRecord>
  runStates: Map<string, McpRunState>
  importedContexts: Map<string, McpImportedContext>
  activeModes: Map<string, EliaMode>
  sessionCostUsd: Map<string, number>
  assertSessionCostWithinLimit: (sessionId: string | undefined) => void
  recordSessionCost: (sessionId: string | undefined, usd: number) => void
  memory?: {
    project?: string
    user?: string
  }
  lessons?: readonly string[]
}

export interface McpClientCapabilities {
  tools?: {
    listChanged?: boolean
  }
  resources?: {
    subscribe?: boolean
    listChanged?: boolean
  }
  prompts?: {
    listChanged?: boolean
  }
  logging?: Record<string, unknown>
  completions?: Record<string, unknown>
  experimental?: Record<string, unknown>
}

export interface McpServerRuntimeConfig {
  cwd: string
  mode: EliaMode
  transport?: 'stdio' | 'http'
  host?: string
  port?: number
  allowedOperations: readonly string[]
  approvalMode: 'auto' | 'always' | 'never'
  streamProgress: boolean
  domainAutoDetect: boolean
  maxConcurrentSessions: number
  costLimitPerSessionUsd: number | null
}

export type McpToolRequiredCapability = 'tools' | 'resources' | 'resources.subscribe' | 'prompts' | 'logging' | 'completions'

export interface McpToolDefinition {
  name: string
  description: string
  category: ToolCategory
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  requiresApproval: boolean
  supportedModes: readonly EliaMode[]
  idempotent: boolean
  costTier: CostTier
  inventoryId: string
  execute: (input: Record<string, unknown>, context: McpToolExecutionContext) => unknown | Promise<unknown>
  requiredCapabilities?: readonly McpToolRequiredCapability[]
}

export type McpFeatureMetadata = Omit<McpToolDefinition, 'execute'>

const MCP_TOOL_NAME_PATTERN = /^elia_[a-z0-9]+(?:_[a-z0-9]+)*$/

export function defineMcpTool<const T extends McpToolDefinition>(definition: T): T {
  assertMcpToolName(definition.name)
  return definition
}

export function assertMcpToolName(name: string): asserts name is string {
  if (!MCP_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid MCP tool name "${name}": expected elia_ followed by lowercase snake_case segments`)
  }
}

export function isValidMcpToolName(name: string): boolean {
  return MCP_TOOL_NAME_PATTERN.test(name)
}
