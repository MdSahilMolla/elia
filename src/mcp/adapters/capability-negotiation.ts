import type { EliaMode, McpClientCapabilities, McpToolRequiredCapability } from '../serverTypes.ts'

export const KNOWN_CAPABILITIES: readonly McpToolRequiredCapability[] = [
  'tools',
  'resources',
  'resources.subscribe',
  'prompts',
  'logging',
  'completions',
]

export const STRUCTURED_CONTENT_MIN_VERSION = '2025-06-18'

const UNIVERSAL_SCHEMA_KEYWORDS = new Set(['type', 'description', 'title', 'nullable', '$schema', '$id'])

const INPUT_FEATURE_KEYWORDS: ReadonlyArray<readonly [InputFeature, readonly string[]]> = [
  ['object-properties', ['properties', 'required', 'additionalProperties']],
  ['array-items', ['items', 'prefixItems']],
  ['constrained-values', ['enum', 'const']],
  ['schema-composition', ['anyOf', 'oneOf', 'allOf', 'not']],
  ['bounds', ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'format']],
  ['examples', ['examples']],
  ['defaults', ['default']],
]

export const INPUT_FEATURES = [
  'object-properties',
  'array-items',
  'constrained-values',
  'schema-composition',
  'bounds',
  'examples',
  'defaults',
] as const
export type InputFeature = (typeof INPUT_FEATURES)[number]

export const OUTPUT_FEATURES = [
  'text',
  'json-object',
  'structured-content',
  'embedded-resources',
  'resource-links',
  'image-content',
  'markdown',
] as const
export type OutputFeature = (typeof OUTPUT_FEATURES)[number]

interface FeatureGate {
  readonly baseline: boolean
  readonly requiresCapability?: McpToolRequiredCapability
  readonly experimentalKey?: string
  readonly minProtocolVersion?: string
  readonly humanOnly?: boolean
}

const FEATURE_GATES: Readonly<Record<InputFeature | OutputFeature, FeatureGate>> = {
  'object-properties': { baseline: true },
  'array-items': { baseline: true },
  'constrained-values': { baseline: true },
  'schema-composition': { baseline: true },
  bounds: { baseline: true },
  examples: { baseline: true },
  defaults: { baseline: false, experimentalKey: 'elia/schemaDefaults' },
  text: { baseline: true },
  'json-object': { baseline: true },
  'structured-content': { baseline: false, experimentalKey: 'elia/structuredContent', minProtocolVersion: STRUCTURED_CONTENT_MIN_VERSION },
  'embedded-resources': { baseline: false, requiresCapability: 'resources' },
  'resource-links': { baseline: false, requiresCapability: 'resources' },
  'image-content': { baseline: false, requiresCapability: 'resources' },
  markdown: { baseline: false, humanOnly: true },
}

const AGENT_CLIENT_MARKERS = [
  'claude-code',
  'claude code',
  'claude_code',
  'codex',
  'cursor',
  'cline',
  'continue',
  'windsurf',
  'copilot',
  'zed',
  'aider',
  'goose',
  'trae',
  'kilo',
  'roo',
  'gemini-cli',
  'gemini cli',
  'qwen',
  'openai',
  'vscode',
  'vs code',
  'visual studio code',
  'jetbrains',
  'warp',
  'mcp-cli',
  'mcp inspector',
  'llm',
  'agent',
  'bot',
  'sdk',
  'ide',
]

const HUMAN_CLIENT_MARKERS = [
  'chatgpt',
  'claude.ai',
  'claude-ai',
  'claude for chrome',
  'claude for desktop',
  'desktop',
  'web app',
  'webapp',
  'webui',
  'web ui',
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'imessage',
  'teams',
  'sms',
  'email',
  'messenger',
]

const HUMAN_WEAK_CLIENT_MARKERS = ['chat', 'conversation']

export type ClientAudience = 'agent' | 'human-chat' | 'unknown'

export type OutputVerbosity = 'minimal' | 'standard' | 'detailed'

export type ApprovalMode = 'auto' | 'always' | 'never'

export interface SchemaNode {
  type?: string
  title?: string
  description?: string
  properties?: Record<string, SchemaNode>
  required?: readonly string[]
  additionalProperties?: boolean | SchemaNode
  items?: SchemaNode
  prefixItems?: readonly SchemaNode[]
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
  anyOf?: readonly SchemaNode[]
  oneOf?: readonly SchemaNode[]
  allOf?: readonly SchemaNode[]
  not?: SchemaNode
  nullable?: boolean
}

export interface NegotiableTool {
  readonly name: string
  readonly description?: string
  readonly inventoryId?: string
  readonly inputSchema?: SchemaNode
  readonly outputSchema?: SchemaNode
  readonly requiresApproval?: boolean
  readonly supportedModes?: readonly EliaMode[]
  readonly requiredCapabilities?: readonly McpToolRequiredCapability[]
  readonly requiredInputFeatures?: readonly InputFeature[]
  readonly outputFeatures?: readonly OutputFeature[]
  readonly requiredOutputFeatures?: readonly OutputFeature[]
}

export interface McpClientInfoLike {
  readonly name?: string
  readonly title?: string
  readonly version?: string
}

export interface NegotiationInput {
  readonly clientCapabilities?: McpClientCapabilities | undefined
  readonly clientInfo?: McpClientInfoLike | undefined
  readonly protocolVersion?: string | undefined
  readonly tools: readonly NegotiableTool[]
  readonly mode?: EliaMode | undefined
  readonly allowedOperations?: readonly string[] | undefined
  readonly approvalMode?: ApprovalMode | undefined
  readonly streamProgress?: boolean | undefined
  readonly audience?: ClientAudience | undefined
}

export interface NegotiatedTool {
  readonly name: string
  readonly inventoryId?: string
  readonly supported: boolean
  readonly hiddenReason?: string
  readonly requiresApproval: boolean
  readonly requiredCapabilities: readonly McpToolRequiredCapability[]
  readonly unsupportedCapabilities: readonly McpToolRequiredCapability[]
  readonly requiredInputFeatures: readonly InputFeature[]
  readonly droppedInputFeatures: readonly InputFeature[]
  readonly requiredOutputFeatures: readonly OutputFeature[]
  readonly droppedOutputFeatures: readonly OutputFeature[]
  readonly inputFeatures: readonly InputFeature[]
  readonly outputFeatures: readonly OutputFeature[]
  readonly inputSchema?: SchemaNode
  readonly outputSchema?: SchemaNode
}

export interface SafetyEnvelope {
  readonly approvalMode: ApprovalMode
  readonly approvalEnforced: true
  readonly toolsRequiringApproval: readonly string[]
  readonly toolsOutsideAllowlist: readonly string[]
  readonly allowlistEnforced: boolean
  readonly notes: readonly string[]
}

export interface NegotiatedCapabilities {
  readonly runId?: string
  readonly audience: ClientAudience
  readonly declared: boolean
  readonly clientName?: string
  readonly clientVersion?: string
  readonly protocolVersion?: string
  readonly supportedCapabilities: readonly McpToolRequiredCapability[]
  readonly unsupportedCapabilities: readonly McpToolRequiredCapability[]
  readonly inputFeatures: readonly InputFeature[]
  readonly droppedInputFeatures: readonly InputFeature[]
  readonly outputFeatures: readonly OutputFeature[]
  readonly droppedOutputFeatures: readonly OutputFeature[]
  readonly outputVerbosity: OutputVerbosity
  readonly maxResultChars: number
  readonly streamProgress: boolean
  readonly tools: readonly NegotiatedTool[]
  readonly visibleTools: readonly string[]
  readonly hiddenTools: readonly string[]
  readonly safety: SafetyEnvelope
}

export interface NegotiationReport {
  audience: ClientAudience
  client: { name?: string; version?: string; protocolVersion?: string; declared: boolean }
  capabilities: { supported: string[]; unsupported: string[] }
  features: {
    input: { enabled: string[]; disabled: string[] }
    output: { enabled: string[]; disabled: string[] }
  }
  output: { verbosity: OutputVerbosity; maxResultChars: number; streamProgress: boolean }
  tools: Array<{
    name: string
    supported: boolean
    requiresApproval: boolean
    hiddenReason?: string
    droppedInputFeatures?: string[]
    droppedOutputFeatures?: string[]
  }>
  safety: {
    approvalMode: ApprovalMode
    approvalEnforced: true
    allowlistEnforced: boolean
    toolsRequiringApproval: string[]
    toolsOutsideAllowlist: string[]
    notes: string[]
  }
}

const VERBOSITY_LIMITS: Readonly<Record<OutputVerbosity, number>> = {
  minimal: 4_000,
  standard: 16_000,
  detailed: 64_000,
}

const APPROVAL_NOTES: readonly string[] = [
  'approval semantics are negotiated never: requiresApproval and approvalMode are carried through unchanged',
  'an allowlist only narrows the exposed tool set and is never widened by a client capability claim',
  'a hidden tool is omitted rather than offered in a reduced form when a required feature is unsupported',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function compareProtocolVersions(left: string, right: string): number {
  const normalize = (value: string): string => (value.length === 10 ? value : '0000-00-00')
  const a = normalize(left)
  const b = normalize(right)
  return a < b ? -1 : a > b ? 1 : 0
}

export function declaredCapabilities(capabilities: McpClientCapabilities | undefined): McpToolRequiredCapability[] {
  if (!isRecord(capabilities)) return ['tools']
  const declared = KNOWN_CAPABILITIES.filter((capability) => {
    switch (capability) {
      case 'tools':
        return isRecord(capabilities.tools)
      case 'resources':
        return isRecord(capabilities.resources)
      case 'resources.subscribe':
        return isRecord(capabilities.resources) && capabilities.resources?.subscribe === true
      case 'prompts':
        return isRecord(capabilities.prompts)
      case 'logging':
        return isRecord(capabilities.logging)
      case 'completions':
        return isRecord(capabilities.completions)
      default:
        return false
    }
  })
  return declared.length > 0 ? declared : ['tools']
}

function experimentalFlags(capabilities: McpClientCapabilities | undefined): Record<string, unknown> {
  const experimental = capabilities?.experimental
  return isRecord(experimental) ? experimental : {}
}

function inputFeatureEnabled(
  feature: InputFeature,
  context: { supported: readonly McpToolRequiredCapability[]; experimental: Record<string, unknown>; protocolVersion?: string | undefined },
): boolean {
  const gate = FEATURE_GATES[feature]
  if (gate.baseline) return true
  if (gate.requiresCapability && !context.supported.includes(gate.requiresCapability)) return false
  if (gate.experimentalKey && context.experimental[gate.experimentalKey] === true) return true
  if (gate.minProtocolVersion) {
    return context.protocolVersion !== undefined && compareProtocolVersions(context.protocolVersion, gate.minProtocolVersion) >= 0
  }
  return false
}

function outputFeatureEnabled(
  feature: OutputFeature,
  context: { supported: readonly McpToolRequiredCapability[]; experimental: Record<string, unknown>; protocolVersion?: string | undefined; audience: ClientAudience },
): boolean {
  const gate = FEATURE_GATES[feature]
  if (gate.baseline) return true
  if (gate.humanOnly) return context.audience === 'human-chat'
  if (gate.requiresCapability && !context.supported.includes(gate.requiresCapability)) return false
  if (gate.experimentalKey && context.experimental[gate.experimentalKey] === true) return true
  if (gate.minProtocolVersion) {
    return context.protocolVersion !== undefined && compareProtocolVersions(context.protocolVersion, gate.minProtocolVersion) >= 0
  }
  return false
}

const FEATURE_KEYWORDS = new Map<string, InputFeature>()
for (const [feature, keywords] of INPUT_FEATURE_KEYWORDS) {
  for (const keyword of keywords) FEATURE_KEYWORDS.set(keyword, feature)
}

const MAX_SCHEMA_DEPTH = 32

function pruneNode(node: SchemaNode, supported: ReadonlySet<InputFeature>, depth: number): SchemaNode | undefined {
  if (depth > MAX_SCHEMA_DEPTH) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue
    if (UNIVERSAL_SCHEMA_KEYWORDS.has(key)) {
      out[key] = value
      continue
    }
    const feature = FEATURE_KEYWORDS.get(key)
    if (feature === undefined) continue
    if (!supported.has(feature)) continue
    if (key === 'properties' && isRecord(value)) {
      const properties: Record<string, SchemaNode> = {}
      for (const [name, child] of Object.entries(value)) {
        if (!isRecord(child)) continue
        const pruned = pruneNode(child, supported, depth + 1)
        if (pruned) properties[name] = pruned
      }
      out[key] = properties
      continue
    }
    if (key === 'items' && isRecord(value)) {
      const pruned = pruneNode(value, supported, depth + 1)
      if (pruned) out[key] = pruned
      continue
    }
    if ((key === 'prefixItems' || key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      const pruned = value.flatMap((child) => {
        if (!isRecord(child)) return []
        const node = pruneNode(child, supported, depth + 1)
        return node ? [node] : []
      })
      if (pruned.length > 0) out[key] = pruned
      continue
    }
    if ((key === 'not' || key === 'additionalProperties') && isRecord(value)) {
      const pruned = pruneNode(value, supported, depth + 1)
      if (pruned) out[key] = pruned
      continue
    }
    out[key] = value
  }
  return out as SchemaNode
}

export function pruneSchema(schema: SchemaNode | undefined, supported: readonly InputFeature[]): SchemaNode | undefined {
  if (!isRecord(schema)) return undefined
  const pruned = pruneNode(schema, new Set(supported), 0)
  return pruned && Object.keys(pruned).length > 0 ? pruned : undefined
}

export function schemaInputFeatures(schema: SchemaNode | undefined): InputFeature[] {
  if (!isRecord(schema)) return []
  const found = new Set<InputFeature>()
  const walk = (node: SchemaNode, depth: number): void => {
    if (depth > MAX_SCHEMA_DEPTH) return
    for (const [key, value] of Object.entries(node)) {
      const feature = FEATURE_KEYWORDS.get(key)
      if (feature) found.add(feature)
      if (key === 'properties' && isRecord(value)) {
        for (const child of Object.values(value)) if (isRecord(child)) walk(child, depth + 1)
      } else if (key === 'items' || key === 'not' || key === 'additionalProperties') {
        if (isRecord(value)) walk(value, depth + 1)
      } else if (Array.isArray(value)) {
        for (const child of value) if (isRecord(child)) walk(child, depth + 1)
      }
    }
  }
  walk(schema, 0)
  return INPUT_FEATURES.filter((feature) => found.has(feature))
}

function clientHaystack(info: McpClientInfoLike | undefined): string {
  if (!info) return ''
  return [info.name, info.title].filter((part): part is string => typeof part === 'string').join(' ').toLowerCase()
}

export function resolveAudience(info: McpClientInfoLike | undefined): ClientAudience {
  const haystack = clientHaystack(info)
  if (!haystack) return 'unknown'
  if (HUMAN_CLIENT_MARKERS.some((marker) => haystack.includes(marker))) return 'human-chat'
  if (AGENT_CLIENT_MARKERS.some((marker) => haystack.includes(marker))) return 'agent'
  if (HUMAN_WEAK_CLIENT_MARKERS.some((marker) => haystack.includes(marker))) return 'human-chat'
  return 'unknown'
}

function verbosityFor(audience: ClientAudience): OutputVerbosity {
  if (audience === 'agent') return 'standard'
  if (audience === 'human-chat') return 'detailed'
  return 'minimal'
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function missing<T extends string>(required: readonly T[], available: readonly string[]): T[] {
  const set = new Set(available)
  return required.filter((value) => !set.has(value))
}

export function negotiateCapabilities(input: NegotiationInput): NegotiatedCapabilities {
  const capabilities = input.clientCapabilities
  const declared = isRecord(capabilities)
  const supported = declaredCapabilities(capabilities)
  const audience = input.audience ?? resolveAudience(input.clientInfo)
  const protocolVersion = asString(input.protocolVersion)
  const experimental = experimentalFlags(capabilities)

  const featureContext = { supported, experimental, protocolVersion }
  const inputFeatures = INPUT_FEATURES.filter((feature) => inputFeatureEnabled(feature, featureContext))
  const outputFeatures = OUTPUT_FEATURES.filter((feature) => outputFeatureEnabled(feature, { ...featureContext, audience }))

  const allowlist = input.allowedOperations
  const allowlistEnforced = allowlist !== undefined
  const allowed = allowlist ? new Set(allowlist) : undefined

  const tools: NegotiatedTool[] = []
  const outsideAllowlist: string[] = []
  const requiresApprovalVisible: string[] = []

  for (const tool of input.tools) {
    const requiredCapabilities = unique(tool.requiredCapabilities ?? [])
    const unsupportedCapabilities = missing(requiredCapabilities, supported)
    const requiredInputFeatures = unique(tool.requiredInputFeatures ?? [])
    const supportedInputFeatures = new Set(inputFeatures)
    const droppedInputFeatures = unique([...requiredInputFeatures, ...schemaInputFeatures(tool.inputSchema)]).filter(
      (feature) => !supportedInputFeatures.has(feature),
    )
    const requiredOutputFeatures = unique(tool.requiredOutputFeatures ?? [])
    const wantedOutputFeatures = unique([...requiredOutputFeatures, ...(tool.outputFeatures ?? [])])
    const supportedOutputFeatures = new Set(outputFeatures)
    const droppedOutputFeatures = wantedOutputFeatures.filter((feature) => !supportedOutputFeatures.has(feature))
    const outsideAllowed = allowed !== undefined && !(allowed.has(tool.name) || (tool.inventoryId !== undefined && allowed.has(tool.inventoryId)))
    const modeUnsupported = input.mode !== undefined && tool.supportedModes !== undefined && !tool.supportedModes.includes(input.mode)

    let hiddenReason: string | undefined
    if (outsideAllowed) hiddenReason = 'not in the operator allowlist'
    else if (unsupportedCapabilities.length > 0) hiddenReason = `unsupported client capabilities: ${unsupportedCapabilities.join(', ')}`
    else if (missing(requiredInputFeatures, inputFeatures).length > 0) hiddenReason = `unsupported required input features: ${missing(requiredInputFeatures, inputFeatures).join(', ')}`
    else if (missing(requiredOutputFeatures, outputFeatures).length > 0) hiddenReason = `unsupported required output features: ${missing(requiredOutputFeatures, outputFeatures).join(', ')}`
    else if (modeUnsupported) hiddenReason = `not available in mode ${input.mode}`

    const requiresApproval = tool.requiresApproval === true
    if (outsideAllowed) outsideAllowlist.push(tool.name)

    const inputSchema = hiddenReason === undefined ? pruneSchema(tool.inputSchema, inputFeatures) : undefined
    if (hiddenReason === undefined && tool.inputSchema !== undefined && inputSchema === undefined) {
      hiddenReason = 'input schema has no representable contract for this client'
    }

    const supportedTool = hiddenReason === undefined
    if (supportedTool && requiresApproval) requiresApprovalVisible.push(tool.name)

    tools.push({
      name: tool.name,
      inventoryId: tool.inventoryId,
      supported: supportedTool,
      hiddenReason,
      requiresApproval,
      requiredCapabilities,
      unsupportedCapabilities,
      requiredInputFeatures,
      droppedInputFeatures,
      requiredOutputFeatures,
      droppedOutputFeatures,
      inputFeatures,
      outputFeatures: tool.outputFeatures?.filter((feature) => supportedOutputFeatures.has(feature)) ?? outputFeatures,
      inputSchema,
      outputSchema: supportedTool ? pruneSchema(tool.outputSchema, inputFeatures) : undefined,
    })
  }

  const verbosity = verbosityFor(audience)

  return {
    clientName: asString(input.clientInfo?.name),
    clientVersion: asString(input.clientInfo?.version),
    protocolVersion,
    audience,
    declared,
    supportedCapabilities: supported,
    unsupportedCapabilities: KNOWN_CAPABILITIES.filter((capability) => !supported.includes(capability)),
    inputFeatures,
    droppedInputFeatures: INPUT_FEATURES.filter((feature) => !inputFeatures.includes(feature)),
    outputFeatures,
    droppedOutputFeatures: OUTPUT_FEATURES.filter((feature) => !outputFeatures.includes(feature)),
    outputVerbosity: verbosity,
    maxResultChars: VERBOSITY_LIMITS[verbosity],
    streamProgress: input.streamProgress ?? true,
    tools,
    visibleTools: tools.filter((tool) => tool.supported).map((tool) => tool.name),
    hiddenTools: tools.filter((tool) => !tool.supported).map((tool) => tool.name),
    safety: {
      approvalMode: input.approvalMode ?? 'always',
      approvalEnforced: true,
      toolsRequiringApproval: requiresApprovalVisible,
      toolsOutsideAllowlist: unique(outsideAllowlist),
      allowlistEnforced,
      notes: APPROVAL_NOTES,
    },
  }
}

export function negotiationReport(result: NegotiatedCapabilities): NegotiationReport {
  return {
    audience: result.audience,
    client: {
      name: result.clientName,
      version: result.clientVersion,
      protocolVersion: result.protocolVersion,
      declared: result.declared,
    },
    capabilities: {
      supported: [...result.supportedCapabilities],
      unsupported: [...result.unsupportedCapabilities],
    },
    features: {
      input: { enabled: [...result.inputFeatures], disabled: [...result.droppedInputFeatures] },
      output: { enabled: [...result.outputFeatures], disabled: [...result.droppedOutputFeatures] },
    },
    output: {
      verbosity: result.outputVerbosity,
      maxResultChars: result.maxResultChars,
      streamProgress: result.streamProgress,
    },
    tools: result.tools.map((tool) => ({
      name: tool.name,
      supported: tool.supported,
      requiresApproval: tool.requiresApproval,
      hiddenReason: tool.hiddenReason,
      droppedInputFeatures: tool.droppedInputFeatures.length > 0 ? [...tool.droppedInputFeatures] : undefined,
      droppedOutputFeatures: tool.droppedOutputFeatures.length > 0 ? [...tool.droppedOutputFeatures] : undefined,
    })),
    safety: {
      approvalMode: result.safety.approvalMode,
      approvalEnforced: result.safety.approvalEnforced,
      allowlistEnforced: result.safety.allowlistEnforced,
      toolsRequiringApproval: [...result.safety.toolsRequiringApproval],
      toolsOutsideAllowlist: [...result.safety.toolsOutsideAllowlist],
      notes: [...result.safety.notes],
    },
  }
}

export function visibleTools(result: NegotiatedCapabilities): Array<{ name: string; inputSchema?: SchemaNode; outputSchema?: SchemaNode }> {
  const byName = new Map(result.tools.map((tool) => [tool.name, tool]))
  return result.visibleTools.flatMap((name) => {
    const tool = byName.get(name)
    if (!tool) return []
    return [{ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }]
  })
}
