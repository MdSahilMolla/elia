import {
  COST_TIERS,
  ELIA_MODES,
  ToolCategory,
  assertMcpToolName,
  type CostTier,
  type EliaMode,
  type McpFeatureMetadata,
  type McpToolRequiredCapability,
  type ToolCategory as ToolCategoryType,
} from './serverTypes.ts'

const ALL_MODES = ELIA_MODES
const RESEARCH_MODES: readonly EliaMode[] = ['research', 'general']
const DATA_MODES: readonly EliaMode[] = ['data', 'finance', 'general']
const FINANCE_MODES: readonly EliaMode[] = ['finance', 'general']
const PRESENTATION_MODES: readonly EliaMode[] = ['presentation', 'battmann', 'general']
const OBJECT_INPUT = { type: 'object', additionalProperties: true } as const
const JSON_OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const

interface FeatureSpec {
  name: string
  description: string
  category: ToolCategoryType
  requiresApproval: boolean
  supportedModes: readonly EliaMode[]
  idempotent: boolean
  costTier: CostTier
  inventoryId?: string
  requiredCapabilities?: readonly McpToolRequiredCapability[]
}

function feature(spec: FeatureSpec): McpFeatureMetadata {
  assertMcpToolName(spec.name)
  const inventoryId = spec.inventoryId ?? `${spec.category.toLowerCase()}.${spec.name.slice('elia_'.length).replaceAll('_', '.')}`
  return {
    ...spec,
    inventoryId,
    inputSchema: OBJECT_INPUT,
    outputSchema: JSON_OBJECT_OUTPUT,
  }
}

export const MCP_FEATURE_INVENTORY: readonly McpFeatureMetadata[] = [
  feature({ name: 'elia_run_task', description: 'Starts a governed Elia task run.', category: ToolCategory.AGENT_LOOP, requiresApproval: false, supportedModes: ALL_MODES, idempotent: false, costTier: 'expensive' }),
  feature({ name: 'elia_get_plan', description: 'Returns a server-held run plan.', category: ToolCategory.AGENT_LOOP, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_approve_plan', description: 'Approves a server-held run plan.', category: ToolCategory.AGENT_LOOP, requiresApproval: true, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_fork_run', description: 'Forks an existing run into a new derived run.', category: ToolCategory.AGENT_LOOP, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'expensive' }),
  feature({ name: 'elia_run_variants', description: 'Starts bounded variants of an existing run.', category: ToolCategory.AGENT_LOOP, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'expensive' }),
  feature({ name: 'elia_repair_run', description: 'Requests a governed repair for a failed run.', category: ToolCategory.AGENT_LOOP, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'expensive' }),
  feature({ name: 'elia_session_create', description: 'Creates an in-process Elia session.', category: ToolCategory.SESSION, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'free', inventoryId: 'session.create' }),
  feature({ name: 'elia_session_list', description: 'Lists active Elia sessions.', category: ToolCategory.SESSION, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free', inventoryId: 'session.list' }),
  feature({ name: 'elia_session_status', description: 'Returns bounded status for an Elia session.', category: ToolCategory.SESSION, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free', inventoryId: 'session.status' }),
  feature({ name: 'elia_session_context', description: 'Returns a bounded session context snapshot.', category: ToolCategory.SESSION, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free', inventoryId: 'session.context' }),
  feature({ name: 'elia_session_inject', description: 'Injects explicit context into an Elia session.', category: ToolCategory.SESSION, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'free', inventoryId: 'session.inject' }),
  feature({ name: 'elia_session_sync', description: 'Synchronizes bounded state with an Elia session.', category: ToolCategory.SESSION, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'cheap', inventoryId: 'session.sync' }),
  feature({ name: 'elia_session_kill', description: 'Terminates an active Elia session.', category: ToolCategory.SESSION, requiresApproval: true, supportedModes: ALL_MODES, idempotent: true, costTier: 'free', inventoryId: 'session.kill' }),
  feature({ name: 'elia_context_drop', description: 'Drops a named context slice from a session.', category: ToolCategory.SESSION, requiresApproval: true, supportedModes: ALL_MODES, idempotent: true, costTier: 'free', inventoryId: 'context.drop' }),
  feature({ name: 'elia_context_subscribe', description: 'Subscribes to named context-drop events.', category: ToolCategory.SESSION, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free', inventoryId: 'context.subscribe' }),
  feature({ name: 'elia_memory_read', description: 'Reads project or user memory.', category: ToolCategory.MEMORY, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_memory_write', description: 'Writes bounded project or user memory.', category: ToolCategory.MEMORY, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'free' }),
  feature({ name: 'elia_memory_search', description: 'Searches project and user memory.', category: ToolCategory.MEMORY, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'cheap' }),
  feature({ name: 'elia_lesson_promote', description: 'Promotes a lesson into durable memory.', category: ToolCategory.MEMORY, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'cheap' }),
  feature({ name: 'elia_lesson_trial', description: 'Starts or records a bounded lesson trial.', category: ToolCategory.MEMORY, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'cheap' }),
  feature({ name: 'elia_evolve', description: 'Runs a bounded self-improvement generation.', category: ToolCategory.SELF_IMPROVEMENT, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'expensive' }),
  feature({ name: 'elia_bench', description: 'Runs a bounded Elia benchmark.', category: ToolCategory.SELF_IMPROVEMENT, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'expensive' }),
  feature({ name: 'elia_distill', description: 'Distills bounded run artifacts.', category: ToolCategory.SELF_IMPROVEMENT, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'model-call' }),
  feature({ name: 'elia_promote', description: 'Promotes a verified self-improvement candidate.', category: ToolCategory.SELF_IMPROVEMENT, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'expensive' }),
  feature({ name: 'elia_compounding_status', description: 'Returns current self-improvement compounding status.', category: ToolCategory.SELF_IMPROVEMENT, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_bench_latency', description: 'Returns benchmark latency percentiles.', category: ToolCategory.SELF_IMPROVEMENT, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_set_mode', description: 'Sets the active bounded Elia operating mode.', category: ToolCategory.CONFIG, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_research', description: 'Runs a bounded research task.', category: ToolCategory.DOMAIN_GENERAL, requiresApproval: false, supportedModes: RESEARCH_MODES, idempotent: false, costTier: 'model-call' }),
  feature({ name: 'elia_analyze_data', description: 'Analyzes bounded user-provided data.', category: ToolCategory.DOMAIN_GENERAL, requiresApproval: false, supportedModes: DATA_MODES, idempotent: false, costTier: 'model-call' }),
  feature({ name: 'elia_write_document', description: 'Writes a bounded local document artifact.', category: ToolCategory.DOMAIN_GENERAL, requiresApproval: true, supportedModes: [...DATA_MODES, ...PRESENTATION_MODES], idempotent: false, costTier: 'cheap' }),
  feature({ name: 'elia_strategic_analysis', description: 'Produces bounded strategic analysis.', category: ToolCategory.DOMAIN_GENERAL, requiresApproval: false, supportedModes: FINANCE_MODES, idempotent: false, costTier: 'expensive' }),
  feature({ name: 'elia_runs_list', description: 'Lists bounded run receipts.', category: ToolCategory.OBSERVABILITY, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_run_receipt', description: 'Reads one run receipt.', category: ToolCategory.OBSERVABILITY, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_run_diff', description: 'Reads a bounded run-to-run diff.', category: ToolCategory.OBSERVABILITY, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'cheap' }),
  feature({ name: 'elia_cost_report', description: 'Reads bounded run cost reporting.', category: ToolCategory.OBSERVABILITY, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_policy_read', description: 'Reads the effective project autonomy policy.', category: ToolCategory.GOVERNANCE, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free' }),
  feature({ name: 'elia_policy_update', description: 'Requests a monotonic project autonomy policy update.', category: ToolCategory.GOVERNANCE, requiresApproval: true, supportedModes: ALL_MODES, idempotent: false, costTier: 'free' }),
  feature({ name: 'elia_quick_ask', description: 'Runs a bounded quick question.', category: ToolCategory.AGENT_LOOP, requiresApproval: false, supportedModes: ALL_MODES, idempotent: false, costTier: 'model-call' }),
  feature({ name: 'elia_import_context', description: 'Imports bounded external context into server memory.', category: ToolCategory.CONFIG, requiresApproval: false, supportedModes: ALL_MODES, idempotent: true, costTier: 'free', inventoryId: 'config.import.context' }),
]

export const SERVER_FEATURE_INVENTORY = MCP_FEATURE_INVENTORY
export const CANONICAL_MCP_TOOL_COUNT = 39
export const MCP_TOOL_NAMES = MCP_FEATURE_INVENTORY.map((entry) => entry.name)
export const MCP_FEATURE_BY_NAME = new Map(MCP_FEATURE_INVENTORY.map((entry) => [entry.name, entry] as const))

export function assertMcpFeatureInventoryComplete(): void {
  if (MCP_FEATURE_INVENTORY.length !== CANONICAL_MCP_TOOL_COUNT) {
    throw new Error(`Canonical MCP inventory mismatch: expected ${CANONICAL_MCP_TOOL_COUNT} tools, received ${MCP_FEATURE_INVENTORY.length}; one canonical tool name is unspecified`)
  }
}

export function isCostTier(value: string): value is CostTier {
  return (COST_TIERS as readonly string[]).includes(value)
}

export const MCP_FEATURE_CATEGORIES = Object.freeze({
  agentLoop: ToolCategory.AGENT_LOOP,
  sessions: ToolCategory.SESSION,
  memory: ToolCategory.MEMORY,
  selfImprovement: ToolCategory.SELF_IMPROVEMENT,
  specialist: ToolCategory.DOMAIN_GENERAL,
  governance: ToolCategory.GOVERNANCE,
  adapter: ToolCategory.CONFIG,
})
