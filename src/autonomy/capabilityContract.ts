import type { Tool } from '../tools/types.ts'

/**
 * The durable action contract describes one invocation. This catalog describes
 * what a built-in capability is allowed to be before the model invokes it.
 * Dynamic skills and MCP tools deliberately do not receive a default contract:
 * their registrar must supply one before they can be presented as governed
 * autonomous capabilities.
 */
export type CapabilityRisk = 'safe' | 'review' | 'critical'
export type CapabilityScope = 'workspace-read' | 'workspace-write' | 'process' | 'network-read' | 'external-write' | 'security'

export interface CapabilityContract {
  tool: string
  risk: CapabilityRisk
  scopes: CapabilityScope[]
  idempotent: boolean
  evidence: string
}

function contract(
  tool: string,
  risk: CapabilityRisk,
  scopes: CapabilityScope[],
  idempotent: boolean,
  evidence: string,
): CapabilityContract {
  return { tool, risk, scopes, idempotent, evidence }
}

const CATALOG: CapabilityContract[] = [
  ...['read_file', 'list_files', 'grep', 'recall', 'brain', 'why', 'project_profile', 'production_readiness', 'environment', 'causal_debug', 'arch_drift', 'adversarial_verify', 'codebase_memory', 'predictive_impact', 'dependency_audit', 'multi_modal_review', 'spec_verify', 'temporal_analysis', 'board_read']
    .map((tool) => contract(tool, 'safe', ['workspace-read'], true, 'bounded local observation')),
  ...['web_search', 'web_fetch'].map((tool) => contract(tool, 'safe', ['network-read'], true, 'dated source or fetched response')),
  ...['visualize', 'finance', 'data_science', 'sports', 'fitness'].map((tool) => contract(tool, 'safe', ['workspace-read'], true, 'deterministic result or generated artifact')),
  ...['write_file', 'edit_file', 'todo_write', 'note_lesson', 'record_rationale', 'causal_fix', 'causal_verify', 'cross_project_learn', 'self_healing_monitor', 'federated_collab', 'board_post']
    .map((tool) => contract(tool, 'review', ['workspace-write'], false, 'written artifact and postcondition')),
  contract('run_command', 'review', ['process'], false, 'exit status, bounded output, and declared postcondition'),
  contract('run_program', 'review', ['process'], false, 'exit status, bounded output, and declared postcondition'),
  contract('provision_environment', 'review', ['process', 'workspace-write'], false, 'installed dependency or recorded blocker'),
  contract('github', 'review', ['network-read', 'external-write'], false, 'provider response and readback'),
  contract('deployment', 'critical', ['process', 'network-read', 'external-write'], false, 'provider receipt and live postcondition'),
  contract('browser', 'critical', ['network-read', 'external-write'], false, 'fresh browser state or user takeover'),
  contract('communication', 'critical', ['external-write'], false, 'approved content and delivery readback'),
  ...['new_engagement', 'run_security_tool', 'http_probe', 'log_finding', 'engagement_report'].map((tool) => contract(tool, 'critical', ['security'], false, 'authorized scope and evidence artifact')),
  contract('read_spreadsheet', 'safe', ['workspace-read'], true, 'parsed workbook result'),
  ...['spreadsheet', 'presentation'].map((tool) => contract(tool, 'review', ['workspace-write'], false, 'saved artifact and schema/readback')),
  contract('battmann', 'critical', ['workspace-write', 'network-read', 'external-write'], false, 'dated evidence, audit entry, and governed action receipt'),
]

const BY_TOOL = new Map(CATALOG.map((entry) => [entry.tool, entry]))

export function capabilityContractFor(tool: string): CapabilityContract | undefined {
  return BY_TOOL.get(tool)
}

export function builtinCapabilityContracts(): readonly CapabilityContract[] {
  return CATALOG
}

/** Lists the static tools that would otherwise bypass the capability catalog. */
export function missingCapabilityContracts(tools: readonly Pick<Tool, 'name'>[]): string[] {
  return tools.map((tool) => tool.name).filter((name) => !BY_TOOL.has(name)).sort()
}
