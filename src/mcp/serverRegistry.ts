import { createContextBridgeTools } from './adapters/context-bridge.ts'
import type {
  McpPromptDescriptor,
  McpPromptGetResult,
  McpProtocolBackend,
  McpResourceContents,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpToolFilter,
} from './protocol.ts'
import { createMemoryTools } from './tools/memory.ts'
import { createSelfImprovementTools } from './tools/selfImprovement.ts'
import { createSessionTools } from './tools/sessions.ts'
import { createSpecialistTools } from './tools/specialist.ts'
import { createCoreLoopTools } from './tools/core.ts'
import { createGovernanceTools } from './tools/governance.ts'
import {
  COST_TIERS,
  ELIA_MODES,
  ToolCategory,
  assertMcpToolName,
  type EliaMode,
  type McpClientCapabilities,
  type McpToolDefinition,
  type McpToolExecutionContext,
  type McpToolRequiredCapability,
} from './serverTypes.ts'

export interface McpResourceRegistration {
  descriptor: McpResourceDescriptor
  read: (context: McpToolExecutionContext) => McpResourceContents | McpResourceContents[] | Promise<McpResourceContents | McpResourceContents[]>
}

export interface McpResourceTemplateRegistration {
  descriptor: McpResourceTemplateDescriptor
  matches: (uri: string) => boolean
  read: (uri: string, context: McpToolExecutionContext) => McpResourceContents | McpResourceContents[] | Promise<McpResourceContents | McpResourceContents[]>
}

export interface McpPromptRegistration {
  descriptor: McpPromptDescriptor
  get: (arguments_: Record<string, string>, context: McpToolExecutionContext) => McpPromptGetResult | Promise<McpPromptGetResult>
}

export interface McpResourceProvider {
  listResources: (context: McpToolExecutionContext) => readonly McpResourceDescriptor[]
  listResourceTemplates: (context: McpToolExecutionContext) => readonly McpResourceTemplateDescriptor[]
  readResource: (uri: string, context: McpToolExecutionContext) => McpResourceContents | McpResourceContents[] | Promise<McpResourceContents | McpResourceContents[]>
}

export interface McpPromptProvider {
  listPrompts: (context: McpToolExecutionContext) => readonly McpPromptDescriptor[]
  getPrompt: (name: string, arguments_: Record<string, string>, context: McpToolExecutionContext) => McpPromptGetResult | Promise<McpPromptGetResult>
}

export interface CreateMcpServerRegistryOptions {
  context: McpToolExecutionContext
  tools?: readonly McpToolDefinition[]
  resources?: readonly McpResourceRegistration[]
  resourceTemplates?: readonly McpResourceTemplateRegistration[]
  prompts?: readonly McpPromptRegistration[]
  resourceProvider?: McpResourceProvider
  promptProvider?: McpPromptProvider
}

export interface McpServerRegistry extends McpProtocolBackend {
  readonly tools: readonly McpToolDefinition[]
  readonly toolCount: number
  readonly resourceCount: number
  readonly resourceTemplateCount: number
  readonly promptCount: number
  listTools: (filter?: McpToolFilter) => readonly McpToolDefinition[]
  getTool: (name: string, filter?: McpToolFilter) => McpToolDefinition | undefined
  callTool: (name: string, input: Record<string, unknown>, context: McpToolExecutionContext, signal?: AbortSignal) => unknown | Promise<unknown>
  listResources: (context: McpToolExecutionContext) => readonly McpResourceDescriptor[]
  listResourceTemplates: (context: McpToolExecutionContext) => readonly McpResourceTemplateDescriptor[]
  readResource: (uri: string, context: McpToolExecutionContext) => McpResourceContents | McpResourceContents[] | Promise<McpResourceContents | McpResourceContents[]>
  listPrompts: (context: McpToolExecutionContext) => readonly McpPromptDescriptor[]
  getPrompt: (name: string, arguments_: Record<string, string>, context: McpToolExecutionContext) => McpPromptGetResult | Promise<McpPromptGetResult>
}

const TOOL_CATEGORIES = new Set<string>(Object.values(ToolCategory))
const COST_TIER_VALUES = new Set<string>(COST_TIERS)
const MODE_VALUES = new Set<string>(ELIA_MODES)

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return undefined
}

export function validateServerToolDefinitions(tools: readonly McpToolDefinition[]): readonly McpToolDefinition[] {
  const names = tools.map((tool) => tool.name)
  const repeated = duplicate(names)
  if (repeated) throw new Error(`Duplicate MCP tool name: ${repeated}`)
  for (const tool of tools) {
    assertMcpToolName(tool.name)
    if (!tool.description.trim()) throw new Error(`MCP tool ${tool.name} requires a description`)
    if (!TOOL_CATEGORIES.has(tool.category)) throw new Error(`MCP tool ${tool.name} has an unknown category`)
    if (!COST_TIER_VALUES.has(tool.costTier)) throw new Error(`MCP tool ${tool.name} has an unknown cost tier`)
    if (!tool.inventoryId.trim()) throw new Error(`MCP tool ${tool.name} requires an inventoryId`)
    if (!tool.supportedModes.length) throw new Error(`MCP tool ${tool.name} requires at least one supported mode`)
    if (tool.supportedModes.some((mode) => !MODE_VALUES.has(mode))) throw new Error(`MCP tool ${tool.name} has an unsupported mode`)
    if (tool.inputSchema.type !== 'object') throw new Error(`MCP tool ${tool.name} inputSchema must be an object schema`)
    if (tool.outputSchema.type !== 'object') throw new Error(`MCP tool ${tool.name} outputSchema must be an object schema`)
    if (typeof tool.execute !== 'function') throw new Error(`MCP tool ${tool.name} requires an execute function`)
  }
  return [...tools]
}

function capabilityEnabled(capabilities: McpClientCapabilities | undefined, capability: McpToolRequiredCapability): boolean {
  if (!capabilities) return false
  if (capability === 'tools') return capabilities.tools !== undefined
  if (capability === 'resources') return capabilities.resources !== undefined
  if (capability === 'resources.subscribe') return capabilities.resources?.subscribe === true
  if (capability === 'prompts') return capabilities.prompts !== undefined
  if (capability === 'logging') return capabilities.logging !== undefined
  return capabilities.completions !== undefined
}

function operationEnabled(tool: McpToolDefinition, allowedOperations: readonly string[]): boolean {
  return allowedOperations.some((operation) => operation === '*' || operation === tool.name || operation === tool.inventoryId)
}

function toolVisible(tool: McpToolDefinition, filter: McpToolFilter | undefined, allowedOperations: readonly string[]): boolean {
  if (!operationEnabled(tool, allowedOperations)) return false
  const mode = filter?.mode
  if (mode !== undefined && !tool.supportedModes.includes(mode)) return false
  return (tool.requiredCapabilities ?? []).every((capability) => capabilityEnabled(filter?.clientCapabilities, capability))
}

function defaultTools(context: McpToolExecutionContext): McpToolDefinition[] {
  return [
    ...createCoreLoopTools(context),
    ...createSessionTools(context),
    ...createMemoryTools(context),
    ...createSelfImprovementTools(context),
    ...createSpecialistTools(context),
    ...createGovernanceTools(context),
    ...createContextBridgeTools(context),
  ]
}

function matchesResourceTemplate(template: string, uri: string): boolean {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = escaped.replace(/\\\{[^}]+\\\}/gu, '[^/]+')
  return new RegExp(`^${pattern}$`, 'u').test(uri)
}

function assertResourceRegistrations(resources: readonly McpResourceRegistration[], templates: readonly McpResourceTemplateRegistration[]): void {
  const resourceUris = resources.map((entry) => entry.descriptor.uri)
  const templateUris = templates.map((entry) => entry.descriptor.uriTemplate)
  const repeatedResource = duplicate(resourceUris)
  const repeatedTemplate = duplicate(templateUris)
  if (repeatedResource) throw new Error(`Duplicate MCP resource URI: ${repeatedResource}`)
  if (repeatedTemplate) throw new Error(`Duplicate MCP resource template URI: ${repeatedTemplate}`)
  if (new Set([...resourceUris, ...templateUris]).size !== resourceUris.length + templateUris.length) {
    throw new Error('MCP resource URI templates must not collide with concrete resource URIs')
  }
}

export function createMcpServerRegistry(options: CreateMcpServerRegistryOptions): McpServerRegistry {
  const tools = validateServerToolDefinitions(options.tools ?? defaultTools(options.context))
  const resourceProvider = options.resourceProvider
  const resources = options.resources
    ? [...options.resources]
    : resourceProvider
      ? resourceProvider.listResources(options.context).map((descriptor) => ({
          descriptor,
          read: (context: McpToolExecutionContext) => resourceProvider.readResource(descriptor.uri, context),
        }))
      : []
  const resourceTemplates = options.resourceTemplates
    ? [...options.resourceTemplates]
    : resourceProvider
      ? resourceProvider.listResourceTemplates(options.context).map((descriptor) => ({
          descriptor,
          matches: (uri: string) => matchesResourceTemplate(descriptor.uriTemplate, uri),
          read: (uri: string, context: McpToolExecutionContext) => resourceProvider.readResource(uri, context),
        }))
      : []
  const promptProvider = options.promptProvider
  const prompts = options.prompts
    ? [...options.prompts]
    : promptProvider
      ? promptProvider.listPrompts(options.context).map((descriptor) => ({
          descriptor,
          get: (arguments_: Record<string, string>, context: McpToolExecutionContext) => promptProvider.getPrompt(descriptor.name, arguments_, context),
        }))
      : []
  assertResourceRegistrations(resources, resourceTemplates)
  const promptName = duplicate(prompts.map((entry) => entry.descriptor.name))
  if (promptName) throw new Error(`Duplicate MCP prompt name: ${promptName}`)
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool] as const))
  const resourcesByUri = new Map(resources.map((entry) => [entry.descriptor.uri, entry] as const))
  const promptsByName = new Map(prompts.map((entry) => [entry.descriptor.name, entry] as const))
  const allowedOperations = options.context.config.allowedOperations
  const listTools = (filter?: McpToolFilter): readonly McpToolDefinition[] => tools.filter((tool) => toolVisible(tool, filter, allowedOperations))
  const getTool = (name: string, filter?: McpToolFilter): McpToolDefinition | undefined => {
    const tool = toolsByName.get(name)
    return tool && toolVisible(tool, filter, allowedOperations) ? tool : undefined
  }
  return {
    tools,
    toolCount: tools.length,
    resourceCount: resources.length,
    resourceTemplateCount: resourceTemplates.length,
    promptCount: prompts.length,
    listTools,
    getTool,
    callTool(name, input, context, signal) {
      const tool = toolsByName.get(name)
      if (!tool) throw new Error(`Unknown MCP tool: ${name}`)
      if (!operationEnabled(tool, allowedOperations)) throw new Error(`MCP tool ${name} is not allowed by the operator allowlist`)
      const mode = context.mode as EliaMode
      if (!tool.supportedModes.includes(mode)) throw new Error(`MCP tool ${name} is not available in mode ${mode}`)
      return tool.execute(input, signal ? { ...context, signal } : context)
    },
    listResources() {
      return resources.map((entry) => entry.descriptor)
    },
    listResourceTemplates() {
      return resourceTemplates.map((entry) => entry.descriptor)
    },
    readResource(uri, context) {
      const resource = resourcesByUri.get(uri)
      if (resource) return resource.read(context)
      const matches = resourceTemplates.filter((entry) => {
        try {
          return entry.matches(uri)
        } catch {
          return false
        }
      })
      if (matches.length === 0) throw new Error(`Unknown MCP resource: ${uri}`)
      if (matches.length > 1) throw new Error(`Ambiguous MCP resource template: ${uri}`)
      return matches[0]!.read(uri, context)
    },
    listPrompts() {
      return prompts.map((entry) => entry.descriptor)
    },
    getPrompt(name, arguments_, context) {
      const prompt = promptsByName.get(name)
      if (!prompt) throw new Error(`Unknown MCP prompt: ${name}`)
      return prompt.get(arguments_, context)
    },
  }
}

export const createServerRegistry = createMcpServerRegistry
