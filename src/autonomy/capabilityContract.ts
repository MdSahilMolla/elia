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
  ...['read_file', 'list_files', 'grep', 'find_symbol', 'recall', 'brain', 'why', 'project_profile', 'production_readiness', 'environment', 'causal_debug', 'arch_drift', 'adversarial_verify', 'codebase_memory', 'predictive_impact', 'dependency_audit', 'multi_modal_review', 'spec_verify', 'temporal_analysis', 'board_read', 'load_tools']
    .map((tool) => contract(tool, 'safe', ['workspace-read'], true, 'bounded local observation')),
  ...['web_search', 'web_fetch', 'paper'].map((tool) => contract(tool, 'safe', ['network-read'], true, 'dated source or fetched response')),
  ...['visualize', 'finance', 'data_science', 'sports', 'fitness'].map((tool) => contract(tool, 'safe', ['workspace-read'], true, 'deterministic result or generated artifact')),
  ...['write_file', 'edit_file', 'delete_file', 'lsp_refactor', 'todo_write', 'note_lesson', 'record_rationale', 'causal_fix', 'causal_verify', 'cross_project_learn', 'self_healing_monitor', 'federated_collab', 'board_post']
    .map((tool) => contract(tool, 'review', ['workspace-write'], false, 'written artifact and postcondition')),
  contract('run_command', 'review', ['process'], false, 'exit status, bounded output, and declared postcondition'),
  contract('run_program', 'review', ['process'], false, 'exit status, bounded output, and declared postcondition'),
  // Not idempotent, and unlike run_command it leaves something behind: a
  // process that outlives the call. Two `start`s are two servers competing for
  // a port, so it is reviewed like any other process capability.
  contract('process', 'review', ['process'], false, 'process id, live status, and captured output'),
  contract('provision_environment', 'review', ['process', 'workspace-write'], false, 'installed dependency or recorded blocker'),
  // Per-call risk comes from the target's locality and what the call does
  // (devdb/policy.ts): local work is safe or review, anything remote — and any
  // SQL that reaches past the database — is critical. `review` is where it starts.
  contract('database', 'review', ['process', 'workspace-write', 'network-read', 'external-write'], false, 'query rows, catalog readback, health findings, migration exit status, or the backup path taken before a destructive change'),
  contract('github', 'review', ['network-read', 'external-write'], false, 'provider response and readback'),
  contract('deployment', 'critical', ['process', 'network-read', 'external-write'], false, 'provider receipt and live postcondition'),
  contract('browser', 'critical', ['network-read', 'external-write'], false, 'fresh browser state or user takeover'),
  contract('communication', 'critical', ['external-write'], false, 'approved content and delivery readback'),
  ...['new_engagement', 'run_security_tool', 'http_probe', 'log_finding', 'engagement_report', 'flag_verify'].map((tool) => contract(tool, 'critical', ['security'], false, 'authorized scope and evidence artifact')),
  // The CTF and triage tools only observe: a toolchain report, a stored
  // procedure, and a parse of recon output elia already saved. None of them
  // spawns a process or reaches a target, which is the line that separates them
  // from run_security_tool on the same mode.
  ...['ctf_toolchain', 'ctf_playbook', 'security_triage'].map((tool) => contract(tool, 'safe', ['workspace-read'], true, 'detected tool inventory, returned playbook, or parsed findings with per-finding evidence')),
  // ask_user reaches no system: it puts one question to a person and reports
  // the answer. It is still critical, because what it returns decides whether a
  // run keeps spending money, and an answer nobody gave is a decision the model
  // would otherwise be inventing. `workspace-read` covers the one thing it
  // actually observes, the session's spend so far.
  contract('ask_user', 'critical', ['workspace-read'], false, "the operator's answer, or a recorded decline when there is nobody to ask"),
  contract('read_spreadsheet', 'safe', ['workspace-read'], true, 'parsed workbook result'),
  ...['spreadsheet', 'presentation'].map((tool) => contract(tool, 'review', ['workspace-write'], false, 'saved artifact and schema/readback')),
  contract('battmann', 'critical', ['workspace-write', 'network-read', 'external-write'], false, 'dated evidence, audit entry, and governed action receipt'),
  // Data-science mode: per-action effects live in datascience/effects.ts; these are the worst case per tool.
  ...['ds_stats', 'ds_timeseries', 'ds_analytics'].map((tool) => contract(tool, 'safe', ['workspace-read', 'workspace-write'], true, 'execution record with input fingerprints, seed, and validation checks')),
  contract('ds_ml', 'safe', ['workspace-read', 'workspace-write'], true, 'execution record, versioned model artifact, baseline and holdout checks'),
  contract('ds_report', 'safe', ['workspace-read', 'workspace-write'], true, 'hashed artifact recorded against the execution records it reports'),
  contract('ds_data', 'review', ['workspace-read', 'workspace-write', 'network-read'], true, 'versioned dataset snapshot with source hash, lineage, and execution record'),
  contract('ds_python', 'critical', ['process', 'network-read', 'workspace-write'], false, 'recorded code, exit status, hashed outputs, and installed package list'),
  // System Intelligence mode: per-action effects live in sysintel/effects.ts; these are the worst case per tool.
  contract('si_org', 'safe', ['workspace-read'], true, 'organization model reference; nothing is recorded'),
  contract('si_work', 'safe', ['workspace-read', 'workspace-write'], true, 'initiative record under .elia/sysintel with an append-only journal entry'),
  contract('si_artifact', 'review', ['workspace-read', 'workspace-write'], true, 'artifact version validated against its template and hashed; exports name the project path'),
  contract('si_record', 'critical', ['workspace-write', 'process'], false, 'engine-run check results, git-verified commits, attributed reviews, and person-approved sign-offs'),
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
