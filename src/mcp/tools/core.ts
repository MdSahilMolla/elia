import { lastAssistantText, runAgentLoop, type ConversationMessage } from '../../agentLoop.ts'
import { readActionLedger } from '../../autonomy/audit.ts'
import { withAgentIdentity } from '../../autonomy/context.ts'
import { detectChecks } from '../../autonomy/detectChecks.ts'
import { planWaves } from '../../autonomy/fleet.ts'
import { createActionGovernor, withActionGovernor, type GovernanceMode } from '../../autonomy/governor.ts'
import { GoalGraphStore, withGoalGraph } from '../../autonomy/goalGraph.ts'
import { createJournal, newRunId, readEvents, runDir, type JournalEvent } from '../../autonomy/journal.ts'
import { autoApprove, repairFileContext, retryGuidanceFor, runAutonomousTask, type AutonomousRunResult } from '../../autonomy/loop.ts'
import type { AgentMode } from '../../autonomy/mode.ts'
import { createProposalTool, parseProposal } from '../../autonomy/proposal.ts'
import { forkRun, isForkable, runSteps } from '../../autonomy/rewind.ts'
import type { Proposal } from '../../autonomy/types.ts'
import { runVariants } from '../../autonomy/variants.ts'
import { config, providerConfigError, systemPromptForMode, turnContextPrompt } from '../../config.ts'
import type { Usage } from '../../providers/types.ts'
import type { SessionId } from '../../session/types.ts'
import { allWorkerTools } from '../../tools/registry.ts'
import { taskTool } from '../../tools/task.ts'
import { setReportSink, type ReportKind } from '../../ui/report.ts'
import { estimateCostUsd } from '../../usage.ts'
import { detectEliaDomain, type DomainDetection } from '../adapters/domain-detector.ts'
import {
  ELIA_MODES,
  ToolCategory,
  defineMcpTool,
  type CostTier,
  type EliaMode,
  type JsonSchema,
  type McpPlanRecord,
  type McpProgressEvent,
  type McpRunState,
  type McpRunStatus,
  type McpToolDefinition,
  type McpToolExecutionContext,
} from '../serverTypes.ts'

type ToolHandler = (input: Record<string, unknown>, context: McpToolExecutionContext) => unknown | Promise<unknown>
type ToolMetadata = Omit<McpToolDefinition, 'execute'>

export type CoreLoopDomainDetector = (goal: string, context: string) => DomainDetection

const ALL_MODES: readonly EliaMode[] = ELIA_MODES
const MAX_GOAL_LENGTH = 8_000
const MAX_CONTEXT_LENGTH = 8_000
const MAX_INSTRUCTION_LENGTH = 4_000
const MAX_PLAN_STEPS = 60
const MAX_VARIANTS = 4
const DEFAULT_MAX_WALL_CLOCK_S = 1_800
const DEFAULT_MAX_ACTIONS = 300
const DEFAULT_RECEIPT_WAIT_MS = 90_000
const JOURNAL_POLL_MS = 3_000
const PROGRESS_TEXT_LIMIT = 2_000
const JOURNAL_TAIL_KINDS: ReadonlySet<JournalEvent['kind']> = new Set([
  'run-start',
  'phase',
  'proposal',
  'approval',
  'step-start',
  'step-end',
  'verify',
  'verdict',
  'lesson',
  'run-end',
])
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'delete_file'])
const PLANNER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'grep',
  'web_search',
  'web_fetch',
  'browser',
  'board_read',
  'board_post',
  'environment',
])
const MODE_KEYWORDS: readonly (readonly [EliaMode, readonly string[]])[] = [
  ['dev', ['bug', 'fix', 'refactor', 'typescript', 'python', 'rust', 'compile', 'test', 'api', 'endpoint', 'repository', 'function', 'module', 'lint', 'typecheck']],
  ['security', ['vulnerab', 'exploit', 'threat model', 'malware', 'ransomware', 'breach', 'cve', 'patch the security', 'penetration']],
  ['research', ['research', 'literature', 'citation', 'source', 'survey', 'evidence', 'compare vendors', 'findings']],
  ['data', ['dataset', 'csv', 'parquet', 'dataframe', 'sql query', 'analyz', 'analyse', 'chart', 'dashboard', 'metric']],
  ['finance', ['revenue', 'budget', 'forecast', 'valuation', 'pricing', 'cost model', 'margin', 'roi', 'invoice', 'investment']],
  ['presentation', ['slide', 'deck', 'presentation', 'keynote', 'talk', 'speech']],
  ['battmann', ['strategy', 'roadmap', 'competitive', 'positioning', 'go-to-market', 'okr', 'business plan']],
]
const PLANNER_INSTRUCTION = `## Right now you are planning, not building

You are in the orient-and-propose phase of an autonomous run. You must NOT change anything yet — you have no write tools in this phase, by design.

1. Look at the shape of the project before forming any opinion: call \`environment\`, list files, and read the handful of files that actually decide the design.
2. Send scouts out in parallel (call \`task\` with role "scout" more than once in a single turn) for anything you cannot answer by reading directly.
3. Then call \`submit_proposal\` exactly once and stop.

Do not narrate the plan in prose first: the proposal is rendered from the tool call, so prose first just shows the user the same plan twice. Two steps that touch disjoint files with no ordering requirement must NOT depend on each other. Every entry in \`verification\` must be a literal shell command that exists in this project — never a manual instruction, because each one is executed exactly as written.`

let domainDetector: CoreLoopDomainDetector | undefined = detectEliaDomain

export function setCoreLoopDomainDetector(next: CoreLoopDomainDetector | undefined): void {
  domainDetector = next
}

export function detectCoreLoopMode(goal: string, fallback: EliaMode): EliaMode {
  const text = goal.toLowerCase()
  let best: EliaMode = fallback
  let bestScore = 0
  for (const [mode, keywords] of MODE_KEYWORDS) {
    const score = keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0)
    if (score > bestScore) {
      best = mode
      bestScore = score
    }
  }
  return bestScore > 0 ? best : fallback
}

function objectSchema(properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const PLAN_OUTPUT: JsonSchema = { ...objectSchema({
  status: { type: 'string' },
  plan_id: { type: 'string' },
  plan_status: { type: 'string' },
  goal: { type: 'string' },
  mode: { type: 'string' },
  run_id: { type: 'string' },
  steps: { type: 'array', items: { type: 'string' } },
  created_at: { type: 'integer' },
  updated_at: { type: 'integer' },
  approved_at: { type: 'integer' },
  proposal: { type: 'object' },
  detected_checks: { type: 'array', items: { type: 'string' } },
}), additionalProperties: true }

const RUN_OUTPUT: JsonSchema = { ...objectSchema({
  status: { type: 'string' },
  run_id: { type: 'string' },
  plan_id: { type: 'string' },
  summary: { type: 'string' },
  files_changed: { type: 'array', items: { type: 'string' } },
  cost_usd: { type: 'number' },
  estimated_cost_tier: { type: 'string' },
  verification: { type: 'array', items: { type: 'string' } },
  blockers: { type: 'array', items: { type: 'string' } },
  next_steps: { type: 'array', items: { type: 'string' } },
  error: { type: 'string' },
}), additionalProperties: true }

const STATUS_OUTPUT: JsonSchema = objectSchema({
  status: { type: 'string' },
  run_id: { type: 'string' },
  plan_id: { type: 'string' },
  next_steps: { type: 'array', items: { type: 'string' } },
  error: { type: 'string' },
})

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defineTool(base: McpToolExecutionContext, metadata: ToolMetadata, handler: ToolHandler): McpToolDefinition {
  return defineMcpTool({
    ...metadata,
    execute: async (input, call) => {
      const context = { ...base, ...call }
      const restoreReports = captureReports(context, String(metadata.name))
      try {
        return await handler(input, context)
      } catch (error) {
        return { status: 'failed', error: message(error) }
      } finally {
        restoreReports()
      }
    },
  })
}

function object(input: Record<string, unknown> | undefined): Record<string, unknown> {
  return input ?? {}
}

function requireString(input: Record<string, unknown>, key: string, tool: string, maxLength: number): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${tool}: "${key}" is required and must be a non-empty string.`)
  }
  if (value.length > maxLength) {
    throw new Error(`${tool}: "${key}" is longer than ${maxLength} characters.`)
  }
  return value.trim()
}

function optionalString(input: Record<string, unknown>, key: string, tool: string, maxLength: number): string | undefined {
  if (input[key] === undefined || input[key] === null) return undefined
  return requireString(input, key, tool, maxLength)
}

function optionalBoolean(input: Record<string, unknown>, key: string, tool: string): boolean {
  const value = input[key]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new Error(`${tool}: "${key}" must be a boolean.`)
  return value
}

function optionalCount(input: Record<string, unknown>, key: string, tool: string, minimum: number, maximum: number, fallback: number): number {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${tool}: "${key}" must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function requireEliaMode(input: Record<string, unknown>, key: string, tool: string): EliaMode | undefined {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(ELIA_MODES as readonly string[]).includes(value)) {
    throw new Error(`${tool}: "${key}" must be one of ${ELIA_MODES.join(', ')}.`)
  }
  return value as EliaMode
}

function assertLive(context: McpToolExecutionContext, tool: string): void {
  if (context.signal?.aborted === true) {
    throw new Error(`${tool}: the request was cancelled before it completed.`)
  }
}

function resolveSessionId(context: McpToolExecutionContext, input: Record<string, unknown>, tool: string): SessionId | undefined {
  const ref = optionalString(input, 'session_id', tool, 200)
  if (ref === undefined) return undefined
  const handle = context.sessionBus.resolve(ref)
  if (!handle) {
    throw new Error(`${tool}: no live session matches "${ref}" in this server's session bus.`)
  }
  return handle.id
}

function toAgentMode(mode: EliaMode): AgentMode {
  if (mode === 'security') return 'cyber'
  if (mode === 'battmann') return 'battmann'
  return 'dev'
}

function governanceMode(context: McpToolExecutionContext): GovernanceMode {
  return context.config.approvalMode === 'auto' ? 'unattended' : 'supervised'
}

function assertApprovalPossible(context: McpToolExecutionContext, tool: string): void {
  if (context.config.approvalMode === 'never') {
    throw new Error(`${tool}: this server runs with approvalMode "never", so no tool may start a mutating run.`)
  }
}

function inventoryIdFor(name: string): string {
  return `${ToolCategory.AGENT_LOOP.toLowerCase()}.${name.slice('elia_'.length).replaceAll('_', '.')}`
}

function assertOperationAllowed(context: McpToolExecutionContext, tool: string): void {
  const allowed = context.config.allowedOperations
  if (allowed.includes('*') || allowed.includes(tool) || allowed.includes(inventoryIdFor(tool))) return
  throw new Error(
    `${tool}: this server's allowedOperations (${allowed.join(', ') || 'none'}) does not include ${tool} or ${inventoryIdFor(tool)}.`,
  )
}

function resolveRunMode(
  goal: string,
  contextText: string,
  explicit: EliaMode | undefined,
  context: McpToolExecutionContext,
): { mode: EliaMode; source: string; confidence?: number; reasoning?: string } {
  if (explicit) return { mode: explicit, source: 'requested' }
  if (context.config.domainAutoDetect && domainDetector) {
    const detection = domainDetector(goal, contextText)
    return { mode: detection.mode, source: `detected:${detection.domain}`, confidence: detection.confidence, reasoning: detection.reasoning }
  }
  if (!domainDetector) return { mode: detectCoreLoopMode(goal, context.mode), source: 'keyword' }
  return { mode: context.mode, source: 'server' }
}

function estimatedCostTier(proposal: Proposal): CostTier {
  const steps = proposal.steps.length
  const checks = proposal.verification.length
  if (steps === 0) return 'free'
  if (steps <= 2 && checks <= 1) return 'cheap'
  if (steps <= 5) return 'model-call'
  return 'expensive'
}

function stepLines(proposal: Proposal): string[] {
  if (proposal.steps.length > MAX_PLAN_STEPS) {
    throw new Error(`The proposed plan has ${proposal.steps.length} steps, more than the ${MAX_PLAN_STEPS} this tool will hold.`)
  }
  return proposal.steps.map((step) => `${step.id}: ${step.title} [${step.role}]`)
}

function planRecord(context: McpToolExecutionContext, goal: string, mode: EliaMode, proposal: Proposal, runId: string): McpPlanRecord {
  const now = Date.now()
  const plan: McpPlanRecord = {
    id: `plan_${runId}`,
    goal,
    status: 'proposed',
    steps: stepLines(proposal),
    createdAt: now,
    updatedAt: now,
    mode,
    runId,
    metadata: {
      proposal,
      waves: planWaves(proposal.steps).waves.length,
      estimated_cost_tier: estimatedCostTier(proposal),
    },
  }
  context.plans.set(plan.id, plan)
  return plan
}

function planView(context: McpToolExecutionContext, plan: McpPlanRecord): Record<string, unknown> {
  return {
    plan_id: plan.id,
    plan_status: plan.status,
    goal: plan.goal,
    mode: plan.mode ?? context.mode,
    run_id: plan.runId,
    steps: plan.steps,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    approved_at: plan.approvedAt,
    ...object(plan.metadata),
    detected_checks: detectChecks(context.cwd),
  }
}

function storedProposal(plan: McpPlanRecord): Proposal | undefined {
  const parsed = parseProposal(plan.metadata?.proposal)
  return 'proposal' in parsed ? parsed.proposal : undefined
}

function requirePlan(context: McpToolExecutionContext, planId: string, tool: string): McpPlanRecord {
  const plan = context.plans.get(planId)
  if (!plan) {
    throw new Error(`${tool}: no plan "${planId}" is held by this server. Plans live in this process only, so use the plan_id from the tool call that created it.`)
  }
  return plan
}

function emitProgress(context: McpToolExecutionContext, event: McpProgressEvent): void {
  try {
    context.emit({ at: Date.now(), ...event })
  } catch {
    return
  }
}

function captureReports(context: McpToolExecutionContext, tool: string): () => void {
  setReportSink((kind: ReportKind, text: string) => {
    emitProgress(context, {
      type: `report_${kind}`,
      tool,
      status: 'progress',
      message: text.slice(0, PROGRESS_TEXT_LIMIT),
    })
  })
  return () => setReportSink(undefined)
}

function progressForEvent(event: JournalEvent, tool: string, runId: string, sessionId?: string): McpProgressEvent | undefined {
  if (!JOURNAL_TAIL_KINDS.has(event.kind)) return undefined
  const base = { runId, tool, sessionId, at: event.at }
  switch (event.kind) {
    case 'run-start':
      return { ...base, type: 'run_started', status: 'starting', message: String(event.data.goal ?? '') }
    case 'phase':
      return { ...base, type: 'phase', status: 'progress', message: String(event.data.phase ?? ''), data: event.data }
    case 'proposal':
      return { ...base, type: 'plan_ready', status: 'progress', message: 'proposal ready for review' }
    case 'approval':
      return { ...base, type: 'approval', status: 'progress', message: String(event.data.action ?? ''), data: event.data }
    case 'step-start':
      return { ...base, type: 'step_started', status: 'progress', message: String(event.data.title ?? ''), data: event.data }
    case 'step-end':
      return {
        ...base,
        type: 'step_completed',
        status: event.data.ok === true ? 'completed' : 'failed',
        message: String(event.data.report ?? '').slice(0, PROGRESS_TEXT_LIMIT),
        data: event.data,
      }
    case 'verify':
      return { ...base, type: 'verification_result', status: 'progress', data: event.data }
    case 'verdict':
      return { ...base, type: 'review_finding', status: 'progress', data: event.data }
    case 'lesson':
      return { ...base, type: 'lesson', status: 'progress', data: event.data }
    case 'run-end':
      return { ...base, type: 'run_completed', status: event.data.outcome === 'completed' ? 'completed' : 'failed', data: event.data }
  }
}

function startJournalTail(context: McpToolExecutionContext, runId: string, tool: string, sessionId?: string): () => void {
  let lastSeq = 0
  let stopped = false
  const tick = (): void => {
    if (stopped) return
    let events: JournalEvent[]
    try {
      events = readEvents(runId)
    } catch {
      return
    }
    for (const event of events) {
      if (event.seq < lastSeq) continue
      lastSeq = event.seq + 1
      const progress = progressForEvent(event, tool, runId, sessionId)
      if (progress) emitProgress(context, progress)
    }
  }
  tick()
  const timer = setInterval(tick, JOURNAL_POLL_MS)
  return () => {
    stopped = true
    clearInterval(timer)
    tick()
  }
}

function filesChanged(runId: string): string[] {
  try {
    return [
      ...new Set(
        readActionLedger(runId)
          .filter((record) => WRITE_TOOL_NAMES.has(record.tool) && !record.isError)
          .map((record) => String(object(record.input).path ?? '').trim())
          .filter((path) => path.length > 0),
      ),
    ]
  } catch {
    return []
  }
}

function costUsd(usage: Usage, cwd: string): number | undefined {
  try {
    return estimateCostUsd(config.model, usage, cwd)
  } catch {
    return undefined
  }
}

function runReceipt(result: AutonomousRunResult, planId: string | undefined, cwd: string, tier: CostTier): Record<string, unknown> {
  const cost = costUsd(result.usage, cwd)
  return {
    status: result.outcome,
    run_id: result.runId,
    ...(planId ? { plan_id: planId } : {}),
    summary: result.completion.summary,
    files_changed: filesChanged(result.runId),
    ...(cost === undefined ? {} : { cost_usd: cost }),
    estimated_cost_tier: tier,
    verification: result.completion.evidence,
    blockers: result.completion.blockers,
    next_steps: result.completion.nextActions.length > 0 ? result.completion.nextActions : ['No further action is owed; the run receipt is on disk.'],
    elapsed_ms: result.elapsedMs,
    workspace: result.workspace.root,
  }
}

interface LaunchedRun {
  runId: string
  settled: Promise<Record<string, unknown>>
}

function launchRun(input: {
  context: McpToolExecutionContext
  tool: string
  runId: string
  planId?: string
  mode: EliaMode
  sessionId?: string
  tier?: CostTier
  tail?: boolean
  run: () => Promise<{ runId: string; result: Record<string, unknown> }>
}): LaunchedRun {
  const { context, tool, runId, planId, mode, sessionId, tier, tail, run } = input
  context.assertSessionCostWithinLimit(sessionId)
  const startedAt = Date.now()
  const state: McpRunState = {
    runId,
    status: 'queued',
    startedAt,
    updatedAt: startedAt,
    ...(planId ? { planId } : {}),
    mode,
    ...(sessionId ? { sessionId } : {}),
  }
  context.runStates.set(runId, state)
  const stopTail = tail ? startJournalTail(context, runId, tool, sessionId) : () => undefined
  emitProgress(context, { type: 'run_queued', runId, tool, sessionId, status: 'starting', message: 'run accepted by the server' })

  const settled = (async (): Promise<Record<string, unknown>> => {
    state.status = 'running'
    state.updatedAt = Date.now()
    context.runStates.set(runId, state)
    try {
      const finished = await run()
      state.status = finished.result.status === 'executing' ? 'running' : completedStatus(finished.result)
      state.updatedAt = Date.now()
      state.completedAt = Date.now()
      const cost = finished.result.cost_usd
      if (typeof cost === 'number') {
        state.costUsd = cost
        context.recordSessionCost(sessionId, cost)
      }
      state.result = finished.result
      context.runStates.set(runId, state)
      if (finished.runId !== runId) {
        context.runStates.set(finished.runId, { ...state, runId: finished.runId, result: { ...finished.result, run_id: finished.runId } })
        emitProgress(context, { type: 'run_started', runId: finished.runId, tool, sessionId, status: 'starting', message: 'derived run id assigned' })
      }
      if (planId) {
        const plan = context.plans.get(planId)
        if (plan) {
          plan.status = state.status === 'completed' ? 'completed' : state.status === 'cancelled' ? 'cancelled' : 'failed'
          plan.updatedAt = Date.now()
          context.plans.set(planId, plan)
        }
      }
      return { ...finished.result, ...(tier ? { estimated_cost_tier: tier } : {}) }
    } catch (error) {
      state.status = 'failed'
      state.updatedAt = Date.now()
      state.completedAt = Date.now()
      state.error = message(error)
      const failed: Record<string, unknown> = { status: 'failed', run_id: runId, error: state.error }
      state.result = failed
      context.runStates.set(runId, state)
      emitProgress(context, { type: 'run_completed', runId, tool, sessionId, status: 'failed', message: state.error })
      return failed
    } finally {
      stopTail()
    }
  })()

  return { runId, settled }
}

function completedStatus(result: Record<string, unknown>): McpRunStatus {
  const status = String(result.status ?? '')
  if (status === 'completed' || status === 'no-proposal') return 'completed'
  if (status === 'aborted' || status === 'cancelled') return 'cancelled'
  if (status === 'awaiting_approval' || status === 'executing' || status === 'running' || status === 'queued') return 'running'
  if (status === 'rejected' || status === 'needs-attention' || status === 'failed') return 'failed'
  return 'completed'
}

async function settleWithin(work: Promise<Record<string, unknown>>, ms: number): Promise<{ settled: true; value: Record<string, unknown> } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms)
  })
  try {
    return await Promise.race([work.then((value) => ({ settled: true as const, value })), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function planOnly(input: {
  context: McpToolExecutionContext
  tool: string
  runId: string
  goal: string
  contextText: string | undefined
  mode: EliaMode
  sessionId?: string
}): Promise<{ proposal: Proposal | undefined; summary: string }> {
  const { context, tool, runId, goal, contextText, mode, sessionId } = input
  const failure = providerConfigError()
  if (failure) throw new Error(`${tool}: no model provider is configured, so no plan can be produced: ${failure}`)

  const proposalCapture = createProposalTool()
  const agentMode = toAgentMode(mode)
  const tools = [
    ...allWorkerTools().filter((tool) => PLANNER_TOOL_NAMES.has(tool.name)),
    taskTool,
    proposalCapture.tool,
  ]
  const messages: ConversationMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `## Goal\n${goal}${contextText ? `\n\n## Additional context from the caller\n${contextText}` : ''}\n\nOrient yourself, then submit a proposal.`,
        },
      ],
    },
  ]
  const systemPrompt = `${systemPromptForMode(agentMode)}\n\n${turnContextPrompt(new Date(), context.cwd)}\n\n${PLANNER_INSTRUCTION}`

  emitProgress(context, { type: 'run_started', runId, tool, sessionId, status: 'starting', message: 'planning' })
  const planning = await withAgentIdentity({ name: 'lead', role: 'lead', runId, cwd: context.cwd, signal: context.signal }, () =>
    runAgentLoop({
      messages,
      systemPrompt,
      systemDynamicPrompt: turnContextPrompt(),
      tools,
      useAnimation: false,
      verbose: false,
      maxSteps: 40,
      signal: context.signal,
    }),
  )
  emitProgress(context, {
    type: 'plan_ready',
    runId,
    tool,
    sessionId,
    status: 'progress',
    message: planning.steps > 0 ? `planned in ${planning.steps} model steps` : 'planned without tool use',
  })

  const proposal = proposalCapture.taken()
  const summary = proposal
    ? proposal.understanding.trim() || proposal.goal
    : lastAssistantText(messages, 'The planner returned no proposal and no summary.')
  return { proposal, summary }
}

function seedPlanGraph(context: McpToolExecutionContext, plan: McpPlanRecord, proposal: Proposal): GoalGraphStore {
  const goal = plan.goal
  const runId = plan.runId ?? newRunId()
  const graph = GoalGraphStore.open({ runId, goal, dir: runDir(runId) })
  graph.seedProposal(proposal)
  return graph
}

function awaitNextSteps(plan: McpPlanRecord, mode: EliaMode): string[] {
  return [
    `Call elia_approve_plan with plan_id "${plan.id}" to execute this plan as run ${plan.runId}.`,
    `The run executes in ${mode} mode against this server's working directory; every write stays behind elia's action governor.`,
  ]
}

function runTaskHandler(): ToolHandler {
  const tool = 'elia_run_task'
  return async (input, context) => {
    assertLive(context, tool)
    const goal = requireString(input, 'goal', tool, MAX_GOAL_LENGTH)
    const contextText = optionalString(input, 'context', tool, MAX_CONTEXT_LENGTH)
    const requestedMode = requireEliaMode(input, 'mode', tool)
    const sessionId = resolveSessionId(context, input, tool)
    const autoApprovePlan = optionalBoolean(input, 'approve_plan_automatically', tool)
    const maxWallClockS = optionalCount(input, 'max_wall_clock_s', tool, 1, 86_400, DEFAULT_MAX_WALL_CLOCK_S)
    const maxActions = optionalCount(input, 'max_actions', tool, 0, 100_000, DEFAULT_MAX_ACTIONS)
    const resolved = resolveRunMode(goal, contextText ?? '', requestedMode, context)
    const mode = resolved.mode
    if (autoApprovePlan) {
      assertOperationAllowed(context, tool)
      assertApprovalPossible(context, tool)
    }

    const runId = newRunId()
    const planId = `plan_${runId}`
    if (autoApprovePlan) {
      emitProgress(context, { type: 'run_started', runId, tool, sessionId, status: 'starting', message: goal, data: { mode, mode_source: resolved.source } })
      const launched = launchRun({
        context,
        tool,
        runId,
        mode,
        sessionId,
        tail: true,
        run: async () => {
          const result = await runAutonomousTask({
            goal,
            runId,
            approve: autoApprove,
            mode: toAgentMode(mode),
            workspaceRoot: context.cwd,
            governanceMode: governanceMode(context),
            signal: context.signal,
            maxWallClockMs: maxWallClockS * 1_000,
            maxActions,
            ...(sessionId ? { sessionId } : {}),
          })
          const proposal = result.proposal
          if (proposal) {
            const plan = planRecord(context, goal, mode, proposal, runId)
            plan.status = 'approved'
            plan.approvedAt = Date.now()
            plan.updatedAt = Date.now()
            context.plans.set(plan.id, plan)
            return { runId: result.runId, result: { ...runReceipt(result, plan.id, context.cwd, estimatedCostTier(proposal)), plan_id: plan.id } }
          }
          return { runId: result.runId, result: { ...runReceipt(result, undefined, context.cwd, 'expensive') } }
        },
      })
      const wait = await settleWithin(launched.settled, DEFAULT_RECEIPT_WAIT_MS)
      if (wait.settled) return wait.value
      return {
        status: 'executing',
        run_id: runId,
        plan_id: planId,
        summary: goal,
        files_changed: filesChanged(runId),
        estimated_cost_tier: 'expensive',
        verification: [],
        next_steps: [
          `The run is still going as ${runId}; it keeps running after this call returns.`,
          'Watch the run_progress notifications from this server, or read the receipt on disk at .elia/runs.',
        ],
      }
    }

    const { proposal, summary } = await planOnly({ context, tool, runId, goal, contextText, mode, sessionId })
    if (!proposal) {
      return {
        status: 'awaiting_approval',
        run_id: runId,
        plan_id: planId,
        summary,
        files_changed: [],
        estimated_cost_tier: 'free',
        verification: [],
        next_steps: ['No plan was produced, so nothing was written. Re-run elia_run_task with a goal this server can plan against.'],
      }
    }
    const plan = planRecord(context, goal, mode, proposal, runId)
    seedPlanGraph(context, plan, proposal)
    const tier = estimatedCostTier(proposal)
    return {
      status: 'awaiting_approval',
      run_id: runId,
      plan_id: plan.id,
      summary,
      files_changed: [],
      estimated_cost_tier: tier,
      verification: proposal.verification,
      next_steps: awaitNextSteps(plan, mode),
      mode,
      mode_source: resolved.source,
      ...(resolved.confidence === undefined ? {} : { mode_confidence: resolved.confidence }),
      plan: planView(context, plan),
    }
  }
}

function getPlanHandler(): ToolHandler {
  const tool = 'elia_get_plan'
  return async (input, context) => {
    assertLive(context, tool)
    const planId = requireString(input, 'plan_id', tool, 200)
    const plan = requirePlan(context, planId, tool)
    return { status: 'ok', ...planView(context, plan) }
  }
}

function approvePlanHandler(): ToolHandler {
  const tool = 'elia_approve_plan'
  return async (input, context) => {
    assertLive(context, tool)
    const planId = requireString(input, 'plan_id', tool, 200)
    const plan = requirePlan(context, planId, tool)
    assertOperationAllowed(context, tool)
    assertApprovalPossible(context, tool)
    const proposal = storedProposal(plan)
    if (!proposal) {
      throw new Error(`${tool}: plan "${planId}" has no stored proposal, so there is nothing to execute.`)
    }
    const runId = plan.runId ?? newRunId()
    if (plan.status === 'approved' || plan.status === 'running' || plan.status === 'completed') {
      return {
        status: plan.status,
        run_id: runId,
        plan_id: plan.id,
        summary: `Plan ${plan.id} was already ${plan.status}.`,
        files_changed: plan.status === 'completed' ? filesChanged(runId) : [],
        estimated_cost_tier: String(object(plan.metadata).estimated_cost_tier ?? 'expensive'),
        verification: proposal.verification,
        next_steps: ['This plan has already been approved; its run state is recorded in this server\'s run registry.'],
      }
    }

    plan.status = 'running'
    plan.updatedAt = Date.now()
    plan.approvedAt = Date.now()
    plan.runId = runId
    context.plans.set(plan.id, plan)

    const tier = String(object(plan.metadata).estimated_cost_tier ?? 'expensive') as CostTier
    const launched = launchRun({
      context,
      tool,
      runId,
      planId: plan.id,
      mode: plan.mode ?? context.mode,
      tail: true,
      run: async () => {
        await context.governedMutation({ name: 'plan_approve', input: { plan_id: plan.id, goal: plan.goal } }, async () => {
          const graph = seedPlanGraph(context, plan, proposal)
          const approval = graph.requestApproval('plan', 'proposal', { goal: plan.goal }, 'The MCP client approved this plan through elia_approve_plan.')
          if (approval.status === 'pending') {
            graph.resolveApproval(approval.id, true, 'Approved through elia_approve_plan.')
          }
        })
        const result = await runAutonomousTask({
          goal: plan.goal,
          runId,
          approve: autoApprove,
          mode: toAgentMode(plan.mode ?? context.mode),
          workspaceRoot: context.cwd,
          governanceMode: governanceMode(context),
          signal: context.signal,
          resumeGraph: true,
        })
        return { runId: result.runId, result: runReceipt(result, plan.id, context.cwd, tier) }
      },
    })

    const wait = await settleWithin(launched.settled, DEFAULT_RECEIPT_WAIT_MS)
    if (wait.settled) return wait.value
    return {
      status: 'executing',
      run_id: runId,
      plan_id: plan.id,
      summary: `Plan approved; run ${runId} is executing.`,
      files_changed: filesChanged(runId),
      estimated_cost_tier: tier,
      verification: proposal.verification,
      next_steps: [
        `The approved run ${runId} keeps going after this call returns.`,
        'Watch the run_progress notifications from this server for its steps, checks, and final outcome.',
      ],
    }
  }
}

function forkRunHandler(): ToolHandler {
  const tool = 'elia_fork_run'
  return async (input, context) => {
    assertLive(context, tool)
    const sourceRunId = requireString(input, 'run_id', tool, 200)
    const instruction = requireString(input, 'instruction', tool, MAX_INSTRUCTION_LENGTH)
    const checkpointId = optionalCount(input, 'checkpoint_id', tool, 0, 100_000, Number.NaN)
    if (!Number.isInteger(checkpointId)) {
      throw new Error(`${tool}: "checkpoint_id" is required and must be a non-negative integer. Use elia_get_plan or the run timeline to find a forkable checkpoint.`)
    }
    assertOperationAllowed(context, tool)
    assertApprovalPossible(context, tool)

    const steps = runSteps(sourceRunId)
    if (steps.length === 0) {
      throw new Error(`${tool}: run "${sourceRunId}" has no journal checkpoints on this machine, so there is nothing to fork.`)
    }
    const checkpoint = steps.find((step) => step.checkpointId === checkpointId)
    if (!checkpoint) {
      return {
        status: 'unsupported',
        run_id: sourceRunId,
        checkpoint_id: checkpointId,
        next_steps: [],
        error: `run ${sourceRunId} has no checkpoint ${checkpointId}. Available: ${steps.map((step) => `${step.checkpointId} (${step.label})`).join(', ')}.`,
      }
    }
    if (!isForkable(checkpoint.label)) {
      return {
        status: 'unsupported',
        run_id: sourceRunId,
        checkpoint_id: checkpointId,
        next_steps: [],
        error: `checkpoint ${checkpointId} ("${checkpoint.label}") is not a planning checkpoint, so there is no decision to retake there. Forkable checkpoints: ${steps.filter((step) => step.forkable).map((step) => `${step.checkpointId} (${step.label})`).join(', ') || 'none'}.`,
      }
    }

    const requestId = `fork_${newRunId()}`
    launchRun({
      context,
      tool,
      runId: requestId,
      mode: context.mode,
      tail: false,
      run: async () => {
        await context.governedMutation({ name: 'run_fork', input: { run_id: sourceRunId, checkpoint_id: checkpointId, instruction } }, () => undefined)
        const forked = await forkRun({ runId: sourceRunId, checkpointId, instruction, approve: autoApprove, signal: context.signal })
        if (!forked.ok) {
          return { runId: requestId, result: { status: 'failed', run_id: requestId, error: forked.error, next_steps: [] } }
        }
        const run = forked.run
        return {
          runId: run.runId,
          result: {
            ...runReceipt(run, undefined, context.cwd, 'expensive'),
            run_id: run.runId,
            source_run_id: sourceRunId,
            checkpoint_id: checkpointId,
            instruction,
          },
        }
      },
    })

    return {
      status: 'executing',
      run_id: requestId,
      source_run_id: sourceRunId,
      checkpoint_id: checkpointId,
      instruction,
      next_steps: [
        `The fork replays run ${sourceRunId} up to checkpoint ${checkpointId} and continues as a new run.`,
        'Its derived run id is assigned when the replay reaches its own first phase, and arrives as a run_progress notification from this server.',
      ],
    }
  }
}

function variantBriefing(proposal: Proposal): string {
  const steps = proposal.steps.map((step) => `- ${step.id} (${step.role}) ${step.title}: ${step.instructions}`).join('\n')
  const checks = proposal.verification.length > 0 ? proposal.verification.join('\n') : 'No shell verification was proposed; review your own work carefully.'
  return [
    `## Goal\n${proposal.goal}`,
    proposal.understanding ? `## What is already known about this project\n${proposal.understanding}` : '',
    `## Approved steps\n${steps}`,
    `## Verification commands that must all pass\n${checks}`,
  ]
    .filter((section) => section.length > 0)
    .join('\n\n')
}

function runVariantsHandler(): ToolHandler {
  const tool = 'elia_run_variants'
  return async (input, context) => {
    assertLive(context, tool)
    const planId = requireString(input, 'plan_id', tool, 200)
    const count = optionalCount(input, 'count', tool, 1, MAX_VARIANTS, 2)
    const plan = requirePlan(context, planId, tool)
    const proposal = storedProposal(plan)
    if (!proposal) {
      throw new Error(`${tool}: plan "${planId}" has no stored proposal, so there are no steps to run variants of.`)
    }
    assertOperationAllowed(context, tool)
    assertApprovalPossible(context, tool)

    const mode = plan.mode ?? context.mode
    const runId = newRunId()
    const tier = String(object(plan.metadata).estimated_cost_tier ?? 'expensive') as CostTier
    const launched = launchRun({
      context,
      tool,
      runId,
      planId: plan.id,
      mode,
      tail: true,
      run: async () => {
        await context.governedMutation({ name: 'run_variant', input: { plan_id: plan.id, count } }, () => undefined)
        const journal = createJournal(runId, plan.goal)
        const graph = GoalGraphStore.open({ runId, goal: plan.goal, dir: journal.dir })
        graph.seedProposal(proposal)
        const governor = createActionGovernor({ mode: governanceMode(context), cwd: context.cwd, maxActions: DEFAULT_MAX_ACTIONS })
        const outcomes = await withAgentIdentity({ name: 'lead', role: 'lead', runId, cwd: context.cwd, signal: context.signal }, () =>
          withActionGovernor(governor, () =>
            withGoalGraph(graph, () =>
              runVariants({
                proposal,
                briefing: variantBriefing(proposal),
                count,
                runId,
                journal,
                governor,
                graph,
                signal: context.signal,
              }),
            ),
          ),
        )
        const cost = costUsd(outcomes.usage, context.cwd)
        return {
          runId,
          result: {
            status: 'completed',
            run_id: runId,
            plan_id: plan.id,
            summary: `Ran ${count} independent implementations of plan ${plan.id} in isolated worktrees; variant ${outcomes.chosen.index + 1} passed verification with the lowest cost and was merged.`,
            files_changed: outcomes.mergedFiles,
            ...(cost === undefined ? {} : { cost_usd: cost }),
            estimated_cost_tier: tier,
            verification: outcomes.all.map((outcome) => `variant ${outcome.index + 1}/${count}: ${outcome.passed ? 'passed' : 'failed'} (${outcome.verificationSummary})`),
            next_steps: ['Review the merged result, then run the project checks yourself if you want a second opinion.'],
            variants: outcomes.all.map((outcome) => ({
              index: outcome.index + 1,
              passed: outcome.passed,
              chosen: outcome.index === outcomes.chosen.index,
              elapsed_ms: outcome.elapsedMs,
              verification: outcome.verificationSummary,
            })),
          },
        }
      },
    })

    const wait = await settleWithin(launched.settled, DEFAULT_RECEIPT_WAIT_MS)
    if (wait.settled) return wait.value
    return {
      status: 'executing',
      run_id: runId,
      plan_id: plan.id,
      summary: `Running ${count} variants of plan ${plan.id}.`,
      files_changed: [],
      estimated_cost_tier: tier,
      verification: proposal.verification,
      next_steps: [
        `The ${count} variants are running as ${runId} and keep going after this call returns.`,
        'The winning worktree is merged into this server\'s working directory only after verification picks it.',
      ],
    }
  }
}

function repairRunHandler(): ToolHandler {
  const tool = 'elia_repair_run'
  return async (input, context) => {
    assertLive(context, tool)
    const sourceRunId = requireString(input, 'run_id', tool, 200)
    const instruction = optionalString(input, 'instruction', tool, MAX_INSTRUCTION_LENGTH)
    assertOperationAllowed(context, tool)
    assertApprovalPossible(context, tool)

    const events = readEvents(sourceRunId)
    if (events.length === 0) {
      throw new Error(`${tool}: run "${sourceRunId}" has no journal on this machine, so there is nothing to repair from.`)
    }
    const start = events.find((event) => event.kind === 'run-start')
    const originalGoal = typeof start?.data.goal === 'string' ? start.data.goal : undefined
    if (!originalGoal) {
      throw new Error(`${tool}: run "${sourceRunId}" has a journal with no recorded goal, so the repair cannot be scoped.`)
    }
    const proposed = events.find((event) => event.kind === 'proposal')
    const parsedProposal = proposed ? parseProposal(proposed.data.proposal) : undefined
    const proposal = parsedProposal && 'proposal' in parsedProposal ? parsedProposal.proposal : undefined
    const ended = [...events].reverse().find((event) => event.kind === 'run-end')
    const outcome = ended ? String(ended.data.outcome ?? 'unknown') : 'unknown'
    const failedStep = [...events].reverse().find((event) => event.kind === 'step-end' && event.data.ok !== true)
    const failure = failedStep
      ? `Step ${String(failedStep.data.id ?? 'unknown')} reported: ${String(failedStep.data.report ?? 'no report was recorded.')}`
      : `The run ended with outcome "${outcome}".`
    const guidance = instruction ?? retryGuidanceFor(failedStep ? String(failedStep.data.report ?? '') : '')
    const goal = [
      `Repair the failed elia run ${sourceRunId}.`,
      `Original goal: ${originalGoal}`,
      `What went wrong: ${failure}`,
      `What to do about it: ${guidance}`,
      `Repair the existing files in place. Do not scaffold a second copy of the deliverable at a new path.`,
      proposal ? repairFileContext(proposal) : '',
    ]
      .filter((section) => section.length > 0)
      .join('\n\n')

    const runId = newRunId()
    const source = context.runStates.get(sourceRunId)
    launchRun({
      context,
      tool,
      runId,
      mode: source?.mode ?? context.mode,
      tail: true,
      run: async () => {
        const result = await runAutonomousTask({
          goal,
          runId,
          approve: autoApprove,
          mode: toAgentMode(source?.mode ?? context.mode),
          workspaceRoot: context.cwd,
          governanceMode: governanceMode(context),
          signal: context.signal,
        })
        return { runId: result.runId, result: { ...runReceipt(result, undefined, context.cwd, 'expensive'), source_run_id: sourceRunId } }
      },
    })

    return {
      status: 'executing',
      run_id: runId,
      source_run_id: sourceRunId,
      summary: `Repair run ${runId} started for ${sourceRunId}: ${failure}`,
      files_changed: [],
      estimated_cost_tier: 'expensive',
      verification: proposal?.verification ?? detectChecks(context.cwd),
      next_steps: [
        `The repair runs as ${runId} and keeps going after this call returns.`,
        `It re-reads run ${sourceRunId}'s journal and the files that run touched; every write still passes elia's action governor.`,
      ],
    }
  }
}

function metadata(name: string, description: string, options: Partial<ToolMetadata>): ToolMetadata {
  return {
    name,
    description,
    category: ToolCategory.AGENT_LOOP,
    inputSchema: objectSchema({}),
    outputSchema: STATUS_OUTPUT,
    requiresApproval: true,
    supportedModes: ALL_MODES,
    idempotent: false,
    costTier: 'expensive',
    inventoryId: inventoryIdFor(name),
    ...options,
  }
}

export function createCoreLoopTools(context: McpToolExecutionContext): McpToolDefinition[] {
  return [
    defineTool(
      context,
      metadata('elia_run_task', 'Starts a governed Elia task run.', {
        inputSchema: objectSchema(
          {
            goal: { type: 'string', description: 'What must be true when this is done, in one or two concrete sentences.' },
            mode: { type: 'string', enum: ELIA_MODES, description: 'Run in this elia mode. Detected from the goal when omitted and the server has domain auto-detect on.' },
            session_id: { type: 'string', description: 'A live session on this server whose memory and cost roll-up this run belongs to.' },
            context: { type: 'string', description: 'Extra context the planner should read: prior findings, constraints, the request behind the goal.' },
            approve_plan_automatically: { type: 'boolean', description: 'Approve the plan the planner produces and execute it in the same call. Defaults to false, which plans and returns a plan_id for elia_approve_plan without writing anything.' },
            max_wall_clock_s: { type: 'integer', minimum: 1, maximum: 86_400, description: 'Hard wall-clock budget for the whole run in seconds.' },
            max_actions: { type: 'integer', minimum: 0, maximum: 100_000, description: 'Maximum governed tool actions for the whole run. 0 means no additional limit.' },
          },
          ['goal'],
        ),
        outputSchema: RUN_OUTPUT,
        idempotent: false,
        requiresApproval: false,
        costTier: 'expensive',
      }),
      runTaskHandler(),
    ),
    defineTool(
      context,
      metadata('elia_get_plan', 'Returns a server-held run plan.', {
        inputSchema: objectSchema({ plan_id: { type: 'string', description: 'The plan_id returned by elia_run_task.' } }, ['plan_id']),
        outputSchema: PLAN_OUTPUT,
        requiresApproval: false,
        idempotent: true,
        costTier: 'free',
      }),
      getPlanHandler(),
    ),
    defineTool(
      context,
      metadata('elia_approve_plan', 'Approves a server-held run plan.', {
        inputSchema: objectSchema({ plan_id: { type: 'string', description: 'The plan_id returned by elia_run_task.' } }, ['plan_id']),
        outputSchema: RUN_OUTPUT,
        idempotent: true,
        costTier: 'free',
      }),
      approvePlanHandler(),
    ),
    defineTool(
      context,
      metadata('elia_fork_run', 'Forks an existing run into a new derived run.', {
        inputSchema: objectSchema(
          {
            run_id: { type: 'string', description: 'The run whose journal holds the checkpoint to fork from.' },
            checkpoint_id: { type: 'integer', minimum: 0, description: 'Checkpoint id from the run timeline. Only "before-orient" and "after-propose" checkpoints are forkable.' },
            instruction: { type: 'string', description: 'What to do differently when re-planning from that checkpoint.' },
          },
          ['run_id', 'checkpoint_id', 'instruction'],
        ),
        outputSchema: STATUS_OUTPUT,
        idempotent: false,
        costTier: 'expensive',
      }),
      forkRunHandler(),
    ),
    defineTool(
      context,
      metadata('elia_run_variants', 'Starts bounded variants of an existing run.', {
        inputSchema: objectSchema(
          {
            plan_id: { type: 'string', description: 'The plan_id whose stored proposal should be attempted more than once.' },
            count: { type: 'integer', minimum: 1, maximum: MAX_VARIANTS, description: 'How many independent implementations to run, each in its own isolated worktree. Defaults to 2.' },
          },
          ['plan_id'],
        ),
        outputSchema: RUN_OUTPUT,
        idempotent: false,
        costTier: 'expensive',
      }),
      runVariantsHandler(),
    ),
    defineTool(
      context,
      metadata('elia_repair_run', 'Requests a governed repair for a failed run.', {
        inputSchema: objectSchema(
          {
            run_id: { type: 'string', description: 'The failed run to repair from, read through its journal.' },
            instruction: { type: 'string', description: 'What the repair must fix. Omit it to repair from the failure the run actually recorded.' },
          },
          ['run_id'],
        ),
        outputSchema: STATUS_OUTPUT,
        idempotent: false,
        costTier: 'expensive',
      }),
      repairRunHandler(),
    ),
  ]
}
