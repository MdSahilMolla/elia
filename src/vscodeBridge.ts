import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { runTurn, type AgentMode, type ConversationMessage } from './agent.ts'
import { lastAssistantText, type ToolEvent } from './agentLoop.ts'
import { requestRunControl } from './autonomy/control.ts'
import { listRuns, readEvents } from './autonomy/journal.ts'
import { currentAgent } from './autonomy/context.ts'
import { appendActionAudit } from './autonomy/audit.ts'
import { assessAction, createActionGovernor, type ActionRequest, type GovernanceMode } from './autonomy/governor.ts'
import { contractForAction, evaluatePostconditions, evaluatePreconditions } from './autonomy/actionContract.ts'
import { taskSessions } from './taskSessions.ts'
import { listSkillBundles } from './skills/bundles.ts'
import { listSkillFiles, listLoadedSkills, loadSkills } from './skills/loader.ts'
import { newSessionId, loadSession, saveSession } from './session.ts'
import { deploymentTool } from './tools/deployment.ts'
import { runShell, clampOutput } from './shell.ts'
import { environmentTool } from './tools/environment.ts'
import { redactActionInput } from './autonomy/governor.ts'
import { redactText } from './ui/redact.ts'
import { encodeBridgeMessage, isBridgeRequest, type BridgeRequest, type BridgeResponse, type BridgeEvent } from './vscodeBridgeProtocol.ts'

const MAX_LINE_LENGTH = 100_000
const MAX_PROMPT_LENGTH = 50_000
const MAX_GOAL_LENGTH = 10_000
const MAX_SESSIONS = 32
const MAX_RUNS = 16

interface PendingApproval {
  resolve: (decision: boolean) => void
  requestId: string
  createdAt: number
}

interface ActiveProcess {
  runId: string
  process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
}

export interface BridgeSession {
  handleRequest(request: BridgeRequest): Promise<void>
  isShuttingDown(): boolean
}

export interface BridgeSessionOptions {
  /** Called for every response and event this session produces — one per transport connection. */
  output: (message: BridgeResponse | BridgeEvent) => void
  /** Called once a `shutdown` request's in-flight work has fully drained. Stdio exits the process; a per-connection transport (e.g. one WebSocket) just closes that connection. */
  onShutdown?: () => void
}

/**
 * One client's worth of bridge state (chat sessions, pending approvals, active
 * autonomous-run child processes) bound to one `output` sink. Kept as a
 * factory rather than module-level state so each transport connection —
 * today the single stdio pipe `runVscodeBridge` reads, potentially several
 * concurrent WebSocket connections under an HTTP transport — gets its own
 * isolated session instead of silently sharing one client's chat history or
 * approvals with another's.
 */
export function createBridgeSession(options: BridgeSessionOptions): BridgeSession {
  const sessions = new Map<string, ConversationMessage[]>()
  const pendingApprovals = new Map<string, PendingApproval>()
  const activeProcesses = new Map<string, ActiveProcess>()
  let chatTail = Promise.resolve()
  let shutdownRequested = false
  let inFlight = 0

  const output = options.output

  const event = (name: string, data: Record<string, unknown> = {}): void => {
    output({ type: 'event', event: name, data })
  }

  const response = (id: string, result: unknown): void => {
    output({ type: 'response', id, ok: true, result })
  }

  const failure = (id: string, error: unknown): void => {
    output({ type: 'response', id, ok: false, error: redactText(error instanceof Error ? error.message : String(error), 4_000) })
  }

  const waitForApproval = (requestId: string, kind: string, payload: Record<string, unknown>): Promise<boolean> => {
    const approvalKey = `${requestId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
    event('approval_required', { approvalKey, requestId, kind, payload })
    return new Promise<boolean>((resolve) => {
      pendingApprovals.set(approvalKey, { resolve, requestId, createdAt: Date.now() })
    })
  }

  const handleChat = async (request: BridgeRequest, params: Record<string, unknown>): Promise<unknown> => {
    const prompt = boundedString(params.prompt, 'prompt', MAX_PROMPT_LENGTH)
    const context = renderEditorContext(params.context)
    const userPrompt = context ? `${prompt}\n\n${context}` : prompt
    const mode = parseMode(params.mode)
    const sessionId = boundedSessionId(params.sessionId) ?? newSessionId()
    const existing = sessions.get(sessionId) ?? (await loadSession(sessionId))?.messages ?? []
    if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string)
    sessions.set(sessionId, existing)
    const messages = existing
    messages.push({ role: 'user', content: [{ type: 'text', text: userPrompt }] })
    const governanceMode = parseGovernanceMode(params.governanceMode) ?? 'unattended'
    const selectedSkills = parseStringArray(params.skillNames, 64, 100)
    let streamedText = ''
    let streamedThinking = ''

    event('chat_started', { requestId: request.id, sessionId, mode })
    const result = await runTurn(messages, {
      mode,
      skillNames: selectedSkills,
      governanceMode,
      signal: currentAgent().signal,
      silent: true,
      onText: (delta) => {
        streamedText += delta
        event('assistant_delta', { requestId: request.id, sessionId, text: delta })
      },
      onThinking: (delta) => {
        streamedThinking += delta
        event('thinking_delta', { requestId: request.id, sessionId, text: delta })
      },
      approveAction: governanceMode === 'supervised'
        ? async (assessment, action) => waitForApproval(request.id, 'action', { assessment, request: redactActionInput(action.name, action.input) })
        : undefined,
      onTool: (toolEvent) => event('tool_finished', { requestId: request.id, sessionId, ...safeToolEvent(toolEvent) }),
    })
    const text = streamedText || lastAssistantText(messages, streamedThinking || '[Elia stopped without a final answer.]')
    if (!messages.some((message) => message.role === 'assistant' && message.content.some((block) => block.type === 'text' && block.text === text))) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    }
    await saveSession(sessionId, messages)
    const output = { sessionId, text, usage: result.usage, steps: result.steps, stopReason: result.stopReason }
    event('chat_finished', { requestId: request.id, ...output })
    return output
  }

  const handleAutonomousStart = async (request: BridgeRequest, params: Record<string, unknown>): Promise<unknown> => {
    const goal = boundedString(params.goal, 'goal', MAX_GOAL_LENGTH)
    const runId = safeRunId(params.runId) ?? `vscode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (activeProcesses.has(runId)) throw new Error(`Autonomous run ${runId} is already active`)

    const cliEntry = fileURLToPath(new URL('../bin/elia.ts', import.meta.url))
    const args = [cliEntry, 'auto', goal, '--json', '--unattended', '--run-id', runId]
    const profile = params.profile
    if (profile === 'fast' || profile === 'balanced' || profile === 'thorough') args.push(`--${profile}`)
    const maxRunMs = boundedInteger(params.maxRunMs, 1, 86_400_000)
    const maxActions = boundedInteger(params.maxActions, 1, 5_000)
    if (maxRunMs !== undefined) args.push('--max-run-ms', String(maxRunMs))
    if (maxActions !== undefined) args.push('--max-actions', String(maxActions))
    if (params.polish === false) args.push('--no-polish')
    if (params.resume === true) args.push('--resume')

    const child = Bun.spawn([process.execPath, ...args], {
      cwd: currentAgent().cwd ?? process.cwd(),
      env: { ...process.env, ELIA_UI_MODE: 'json', NO_COLOR: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    activeProcesses.set(runId, { runId, process: child })
    event('autonomous_started', { requestId: request.id, runId, goal, pid: child.pid ?? null })
    void forwardAutonomousOutput(runId, child, event).finally(() => activeProcesses.delete(runId))
    return { runId, goal, status: 'started' }
  }

  const handleDeployment = async (request: BridgeRequest, params: Record<string, unknown>): Promise<unknown> => {
    const actionRequest: ActionRequest = { name: 'deployment', input: params }
    const cwd = currentAgent().cwd ?? process.cwd()
    const assessment = assessAction(actionRequest, cwd)
    const governanceMode = parseGovernanceMode(params.governanceMode) ?? 'supervised'
    const governor = createActionGovernor({
      mode: governanceMode,
      approve: governanceMode === 'supervised'
        ? async (nextAssessment, nextRequest) => waitForApproval(request.id, 'deployment', { assessment: nextAssessment, request: redactActionInput(nextRequest.name, nextRequest.input) })
        : undefined,
      maxActions: 1,
    })
    const gate = await governor.check(actionRequest)
    if (!gate.allowed) return { status: 'blocked', reason: gate.message ?? assessment.reason, assessment: gate.assessment }

    const contract = contractForAction(actionRequest, cwd, `vscode:${request.id}`)
    const precondition = await evaluatePreconditions(contract, cwd, currentAgent().signal)
    if (!precondition.ok) return { status: 'blocked', reason: precondition.failures.join('; '), precondition, assessment: gate.assessment }

    const startedAt = Date.now()
    let result = ''
    let isError = false
    try {
      result = await deploymentTool.execute(params)
      const postcondition = evaluatePostconditions(contract, result, cwd)
      if (!postcondition.ok) {
        result = JSON.stringify({ status: 'failed', reason: postcondition.failures.join('; '), postcondition, providerResult: tryJson(result) ?? result })
        isError = true
      }
      appendActionAudit({ name: 'deployment', input: params, result, isError, durationMs: Date.now() - startedAt, cached: false, assessment: gate.assessment })
      event('deployment_finished', { requestId: request.id, provider: params.provider, action: params.action, target: params.target, ok: !isError })
      return tryJson(result) ?? result
    } catch (error) {
      isError = true
      result = error instanceof Error ? error.message : String(error)
      appendActionAudit({ name: 'deployment', input: params, result, isError, durationMs: Date.now() - startedAt, cached: false, assessment: gate.assessment })
      throw error
    }
  }

  const handleRequest = async (request: BridgeRequest): Promise<void> => {
    inFlight += 1
    try {
      const params = request.params ?? {}
      switch (request.method) {
        case 'chat.send': {
          const pending = chatTail.then(() => handleChat(request, params))
          chatTail = pending.then(() => undefined, () => undefined)
          response(request.id, await pending)
          return
        }
        case 'autonomous.start':
          response(request.id, await handleAutonomousStart(request, params))
          return
        case 'autonomous.approve': {
          const key = boundedString(params.approvalKey ?? params.key, 'approvalKey', 400)
          const pendingApproval = pendingApprovals.get(key)
          if (!pendingApproval) throw new Error('Approval request is unknown, expired, or already resolved')
          pendingApprovals.delete(key)
          pendingApproval.resolve(params.decision === 'approve' || params.approved === true)
          response(request.id, { approved: params.decision === 'approve' || params.approved === true })
          return
        }
        case 'autonomous.control': {
          const runId = safeRunId(params.runId)
          const action = params.action === 'pause' || params.action === 'stop' ? params.action : undefined
          if (!runId || !action) throw new Error('autonomous.control requires a valid runId and pause or stop action')
          const accepted = requestRunControl(runId, action)
          response(request.id, { runId, action, accepted })
          return
        }
        case 'tasks.list':
          await taskSessions.load()
          response(request.id, taskSessions.list())
          return
        case 'task.control': {
          const taskId = boundedString(params.taskId, 'taskId', 200)
          const action = params.action
          if (action !== 'pause' && action !== 'resume' && action !== 'cancel' && action !== 'retry') throw new Error('task.control action must be pause, resume, cancel, or retry')
          response(request.id, { taskId, action, accepted: taskSessions.control(taskId, action) })
          return
        }
        case 'runs.list':
          response(request.id, listRuns(Math.min(boundedInteger(params.limit, 1, MAX_RUNS) ?? 20, MAX_RUNS)))
          return
        case 'runs.inspect': {
          const runId = safeRunId(params.runId)
          if (!runId) throw new Error('runs.inspect requires a valid runId')
          response(request.id, { runId, events: readEvents(runId) })
          return
        }
        case 'skills.list':
          response(request.id, { files: listSkillFiles(), loaded: listLoadedSkills(), bundles: listSkillBundles() })
          return
        case 'git.diff': {
          const result = await runShell('git diff --no-ext-diff --no-color', 20_000, currentAgent().cwd ?? process.cwd(), currentAgent().signal)
          response(request.id, { status: result.exitCode === 0 && !result.timedOut ? 'ok' : 'failed', diff: clampOutput(result.stdout, 100_000), error: result.stderr ? clampOutput(result.stderr, 4_000) : undefined })
          return
        }
        case 'environment.inspect':
          response(request.id, JSON.parse(await environmentTool.execute({})))
          return
        case 'deployment.run':
          response(request.id, await handleDeployment(request, params))
          return
        case 'shutdown':
          response(request.id, { status: 'stopping' })
          shutdownRequested = true
          for (const active of activeProcesses.values()) active.process.kill()
          return
        default:
          throw new Error(`Unknown bridge method: ${request.method}`)
      }
    } catch (error) {
      failure(request.id, error)
    } finally {
      inFlight -= 1
      if (shutdownRequested && inFlight === 0) options.onShutdown?.()
    }
  }

  return {
    handleRequest,
    isShuttingDown: () => shutdownRequested,
  }
}

/**
 * The stdio transport — one process, one client, spawned fresh per caller
 * (today: the VS Code extension). All model work, tool governance, durable
 * state, and external-action policy remain in this process or in the normal
 * Elia CLI it launches; see bridgeHttp.ts for the multi-client HTTP/WebSocket
 * transport over the same protocol and the same createBridgeSession core.
 */
export async function runVscodeBridge(): Promise<void> {
  try {
    await loadSkills()
  } catch {
    // Skill discovery remains best-effort; the bridge can still serve built-ins.
  }

  const output = (message: BridgeResponse | BridgeEvent): void => {
    process.stdout.write(encodeBridgeMessage(message))
  }
  const reject = (error: string): void => output({ type: 'response', id: 'unknown', ok: false, error })

  const session = createBridgeSession({ output, onShutdown: () => process.exit(0) })

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of input) {
    if (line.length > MAX_LINE_LENGTH) {
      reject(`Bridge request exceeds ${MAX_LINE_LENGTH} characters`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      reject('Bridge request must be one JSON object per line')
      continue
    }
    if (session.isShuttingDown()) continue
    if (!isBridgeRequest(parsed)) {
      reject('Invalid bridge request envelope')
      continue
    }
    void session.handleRequest(parsed)
  }
}

async function forwardAutonomousOutput(
  runId: string,
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  event: (name: string, data?: Record<string, unknown>) => void,
): Promise<void> {
  const stdout = child.stdout
  const stderr = child.stderr
  let stdoutBuffer = ''
  let stderrBuffer = ''
  if (stdout) {
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        stdoutBuffer += decoder.decode(value, { stream: true })
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) forwardChildLine(runId, line, event)
      }
      if (stdoutBuffer.trim()) forwardChildLine(runId, stdoutBuffer, event)
    } finally {
      reader.releaseLock()
    }
  }
  if (stderr) {
    const reader = stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        stderrBuffer += decoder.decode(value, { stream: true })
        const lines = stderrBuffer.split('\n')
        stderrBuffer = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) event('autonomous_stderr', { runId, message: redactText(line, 4_000) })
      }
      if (stderrBuffer.trim()) event('autonomous_stderr', { runId, message: redactText(stderrBuffer, 4_000) })
    } finally {
      reader.releaseLock()
    }
  }
  const exitCode = await child.exited
  event('autonomous_process_exit', { runId, exitCode })
}

function forwardChildLine(runId: string, line: string, event: (name: string, data?: Record<string, unknown>) => void): void {
  if (!line.trim()) return
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    const name = typeof parsed.type === 'string' ? parsed.type : 'autonomous_output'
    const data = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'type'))
    event(name, { runId, ...data })
  } catch {
    event('autonomous_output', { runId, message: redactText(line, 4_000) })
  }
}

function safeToolEvent(toolEvent: ToolEvent): Record<string, unknown> {
  return {
    name: toolEvent.name,
    input: redactActionInput(toolEvent.name, toolEvent.input),
    result: redactText(toolEvent.result, 4_000),
    isError: toolEvent.isError,
    durationMs: toolEvent.durationMs,
    cached: toolEvent.cached,
    assessment: toolEvent.assessment,
    actionId: toolEvent.actionId,
    idempotencyKey: toolEvent.idempotencyKey,
    replayed: toolEvent.replayed,
    failureClass: toolEvent.failureClass,
  }
}

function renderEditorContext(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const context = value as Record<string, unknown>
  const parts: string[] = []
  if (typeof context.file === 'string' && context.file.length <= 500) parts.push(`Active file: ${context.file}`)
  if (typeof context.language === 'string' && context.language.length <= 100) parts.push(`Language: ${context.language}`)
  if (typeof context.selection === 'string' && context.selection.length > 0 && context.selection.length <= 16_000) parts.push(`Selected code:\n${context.selection}`)
  if (Array.isArray(context.diagnostics)) {
    const diagnostics = context.diagnostics.filter((item): item is string => typeof item === 'string').slice(0, 20)
    if (diagnostics.length > 0) parts.push(`Editor diagnostics:\n${diagnostics.join('\\n')}`)
  }
  return parts.length > 0 ? `## VS Code editor context\\n${parts.join('\\n\\n')}` : ''
}

function parseMode(value: unknown): AgentMode {
  if (value === undefined || value === 'dev') return 'dev'
  if (value === 'cyber' || value === 'sports' || value === 'fitness' || value === 'battmann') return value
  throw new Error('mode must be dev, cyber, sports, fitness, or battmann')
}

function parseGovernanceMode(value: unknown): GovernanceMode | undefined {
  if (value === undefined) return undefined
  if (value === 'unattended' || value === 'supervised') return value
  throw new Error('governanceMode must be unattended or supervised')
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  const normalized = value.trim()
  if (normalized.length > max) throw new Error(`${name} exceeds ${max} characters`)
  return normalized
}

function boundedSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const id = boundedString(value, 'sessionId', 100)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)?$/i.test(id)) throw new Error('sessionId has an invalid format')
  return id
}

function safeRunId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const id = boundedString(value, 'runId', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('runId has an invalid format')
  return id
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`integer must be between ${min} and ${max}`)
  return value
}

function parseStringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length > maxLength)) throw new Error('skillNames must be a bounded string array')
  return value.map((item) => item.trim()).filter(Boolean)
}

function tryJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
