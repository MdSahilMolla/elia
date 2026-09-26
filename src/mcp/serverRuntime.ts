import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createActionGovernor, type ActionApproval, type ActionAssessment, type ActionRequest, assessAction } from '../autonomy/governor.ts'
import { applyPolicy } from '../autonomy/policy.ts'
import { loadLessons } from '../autonomy/lessons.ts'
import { loadProjectMemory, loadUserMemory } from '../memory.ts'
import { getSessionBus } from '../session/bus.ts'
import { loadUserConfig } from '../userConfig.ts'
import type {
  EliaMode,
  McpGovernedMutation,
  McpImportedContext,
  McpPlanRecord,
  McpProgressEvent,
  McpRunState,
  McpServerRuntimeConfig,
  McpToolExecutionContext,
} from './serverTypes.ts'
import type { EliaMcpServerConfig } from './config.ts'

export interface CreateMcpServerRuntimeOptions {
  config: EliaMcpServerConfig
  cwd?: string
  mode?: EliaMode
  approve?: ActionApproval
  sessionBus?: McpToolExecutionContext['sessionBus']
  progress?: (event: McpProgressEvent) => void
}

export interface McpServerRuntime extends McpToolExecutionContext {
  cwd: string
  config: McpServerRuntimeConfig
  setMode: (sessionId: string, mode: EliaMode) => void
  getMode: (sessionId: string) => EliaMode
  subscribeProgress: (listener: (event: McpProgressEvent) => void) => () => void
  setProgressListener: (listener: ((event: McpProgressEvent) => void) | undefined) => void
  dispose: () => void
}

interface MutationContract {
  action: ActionRequest
  assessment: ActionAssessment
}

function mutationContract(request: ActionRequest): MutationContract {
  const input = request.input
  const contracts: Record<string, MutationContract> = {
    memory_write: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'writes durable memory', 'mcp.memory.write', ['project-memory'], true),
    },
    lesson_promote: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'promotes a lesson into durable project state', 'mcp.lesson.promote', ['project-lessons'], true),
    },
    plan_approve: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('safe', 'allow', 'records approval for a server-held plan', 'mcp.plan.approve', [], true),
    },
    run_fork: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'creates a derived run and may consume model budget', 'mcp.run.fork', [], true),
    },
    run_variant: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'creates an additional model run and may consume budget', 'mcp.run.variant', [], true),
    },
    elia_session_create: {
      action: { name: 'write_file', input: { path: join('.elia', 'session-worktrees', request.name) } },
      assessment: assessment('review', 'approve', 'creates an in-process session and may create an isolated worktree', 'mcp.session.create', ['project-filesystem'], true),
    },
    elia_session_inject: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'queues work for execution by a live session', 'mcp.session.inject', ['model-budget'], true),
    },
    elia_session_sync: {
      action: { name: 'write_file', input: { path: join('.elia', 'sessions') } },
      assessment: assessment('review', 'approve', 'merges private memory between live sessions', 'mcp.session.sync', ['session-memory'], false),
    },
    elia_session_kill: {
      action: { name: 'process', input: { action: 'stop' } },
      assessment: assessment('review', 'approve', 'terminates a live session and may delete its isolated worktree', 'mcp.session.kill', ['project-filesystem'], false),
    },
    elia_context_drop: {
      action: { name: 'submit_fragment', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'publishes context into subscribed live sessions', 'mcp.context.drop', ['session-context'], true),
    },
    elia_context_subscribe: {
      action: { name: 'submit_fragment', input: { mutation: request.name } },
      assessment: assessment('safe', 'allow', 'adds or removes an in-memory context subscription', 'mcp.context.subscribe', ['session-context'], true),
    },
    context_import: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('safe', 'allow', 'imports bounded context into server memory', 'mcp.context.import', [String(input.source ?? '')], true),
    },
    policy_update: {
      action: { name: 'write_file', input: { path: '.elia/policy.json' } },
      assessment: assessment('critical', 'approve', 'changes the checked-in autonomy policy and can only tighten future authorization', 'mcp.policy.update', ['.elia/policy.json'], false),
    },
    evolve: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'starts a bounded self-improvement evaluation', 'mcp.evolve', ['project-artifacts'], true),
    },
    bench: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'starts a bounded benchmark run', 'mcp.bench', ['project-artifacts'], true),
    },
    distill: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'distills bounded run artifacts into a proposal', 'mcp.distill', ['project-artifacts'], true),
    },
    promote: {
      action: { name: 'submit_hypothesis', input: { mutation: request.name } },
      assessment: assessment('review', 'approve', 'promotes a bounded self-improvement proposal', 'mcp.promote', ['project-artifacts'], true),
    },
  }
  const contract = contracts[request.name]
  if (contract) return contract
  const directAssessment = assessAction(request)
  if (directAssessment.reason.startsWith('unknown tool ')) {
    throw new Error(`Unknown critical mutation action: ${request.name}`)
  }
  return { action: request, assessment: directAssessment }
}

function assessment(
  risk: ActionAssessment['risk'],
  decision: ActionAssessment['decision'],
  reason: string,
  intent: string,
  resources: string[],
  reversible: boolean,
): ActionAssessment {
  return { risk, decision, reason, intent, resources, reversible }
}

export async function createMcpServerRuntime(options: CreateMcpServerRuntimeOptions): Promise<McpServerRuntime> {
  loadUserConfig()
  const cwd = resolve(options.cwd ?? process.cwd())
  const mode = options.mode ?? 'general'
  const config: McpServerRuntimeConfig = {
    cwd,
    mode,
    transport: options.config.transport,
    host: options.config.host,
    port: options.config.port,
    allowedOperations: [...options.config.allowedOperations],
    approvalMode: options.config.approvalMode,
    streamProgress: options.config.streamProgress,
    domainAutoDetect: options.config.domainAutoDetect,
    maxConcurrentSessions: options.config.maxConcurrentSessions,
    costLimitPerSessionUsd: options.config.costLimitPerSessionUsd,
  }
  const progressListeners = new Set<(event: McpProgressEvent) => void>()
  let externalProgress: ((event: McpProgressEvent) => void) | undefined = options.progress
  const emit = (event: McpProgressEvent): void => {
    const normalized = { ...event, at: event.at ?? Date.now() }
    if (!options.config.streamProgress) return
    try {
      externalProgress?.(normalized)
    } catch (error) {
      void error
    }
    for (const listener of progressListeners) {
      try {
        listener(normalized)
      } catch (error) {
        void error
      }
    }
  }
  const governedMutation: McpGovernedMutation = async <T>(
    requestOrName: string | { name: string; input: Record<string, unknown> },
    inputOrMutate: Record<string, unknown> | (() => T | Promise<T>),
    possibleMutate?: () => T | Promise<T>,
  ): Promise<T> => {
    const request = typeof requestOrName === 'string'
      ? { name: requestOrName, input: inputOrMutate as Record<string, unknown> }
      : requestOrName
    const mutate = typeof inputOrMutate === 'function' ? inputOrMutate as () => T | Promise<T> : possibleMutate
    if (typeof mutate !== 'function') throw new Error(`Governed mutation ${request.name} requires a callback`)
    const contract = mutationContract(request)
    const policied = applyPolicy(contract.assessment, request, cwd)
    if (policied.blocked) throw new Error(policied.message ?? 'Mutation blocked by policy')
    if (options.config.approvalMode === 'never' && policied.assessment.decision !== 'allow') {
      throw new Error(`Mutation ${request.name} requires approval, but approvalMode is never`)
    }
    const mode = options.config.approvalMode === 'auto' ? 'unattended' : 'supervised'
    const approve = options.config.approvalMode === 'always'
      ? async (assessmentResult: ActionAssessment, action: ActionRequest) => {
          if (!options.approve) throw new Error(`Mutation ${request.name} requires an explicit approval callback`)
          return options.approve(assessmentResult, action)
        }
      : options.approve
    const governor = createActionGovernor({ mode, approve, cwd })
    const gate = await governor.check(contract.action)
    if (!gate.allowed) throw new Error(gate.message ?? `Mutation ${request.name} was blocked`)
    return mutate()
  }
  const sessionCostUsd = new Map<string, number>()
  const costKey = (sessionId: string | undefined): string => sessionId ?? 'server'
  const assertSessionCostWithinLimit = (sessionId: string | undefined): void => {
    const limit = options.config.costLimitPerSessionUsd
    if (limit === null || limit === undefined) return
    const spent = sessionCostUsd.get(costKey(sessionId)) ?? 0
    if (spent >= limit) {
      throw new Error(`Session ${costKey(sessionId)} has spent $${spent.toFixed(4)} of its $${limit.toFixed(4)} cost limit; raise config.costLimitPerSessionUsd or start a fresh session before spending more.`)
    }
  }
  const recordSessionCost = (sessionId: string | undefined, usd: number): void => {
    if (!Number.isFinite(usd) || usd <= 0) return
    const key = costKey(sessionId)
    sessionCostUsd.set(key, (sessionCostUsd.get(key) ?? 0) + usd)
  }
  const runtime: McpServerRuntime = {
    cwd,
    config,
    sessionBus: options.sessionBus ?? getSessionBus(),
    mode,
    emit,
    governedMutation,
    plans: new Map<string, McpPlanRecord>(),
    runStates: new Map<string, McpRunState>(),
    importedContexts: new Map<string, McpImportedContext>(),
    activeModes: new Map<string, EliaMode>(),
    sessionCostUsd,
    assertSessionCostWithinLimit,
    recordSessionCost,
    memory: {
      project: loadProjectMemory(cwd),
      user: loadUserMemory(),
    },
    lessons: loadLessons(resolve(cwd, '.elia', 'lessons.md')).map((lesson) => lesson.text),
    setMode(sessionId, nextMode) {
      runtime.activeModes.set(sessionId, nextMode)
    },
    getMode(sessionId) {
      return runtime.activeModes.get(sessionId) ?? runtime.mode
    },
    subscribeProgress(listener) {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
    setProgressListener(listener) {
      externalProgress = listener
    },
    dispose() {
      progressListeners.clear()
      externalProgress = undefined
    },
  }
  runtime.activeModes.set('server', mode)
  return runtime
}

export const createServerRuntime = createMcpServerRuntime
export type ServerRuntime = McpServerRuntime
export type { McpServerRuntimeConfig }

export function newMcpRunId(): string {
  return randomUUID()
}
