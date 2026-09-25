/**
 * /quickchat orchestrator.
 *
 * An inline, NON-BLOCKING question inside a running session: a cheap fast-tier
 * model call gets a read-only snapshot of the session and the answer lands in
 * the overlay while the session's own work continues underneath.
 *
 * Guarantees:
 *  - never touches the primary (deep) model — quickchat goes exclusively to the
 *    fast tier (`config.tiers.fast`),
 *  - every model call races a 60s AbortController (overridable for tests); on
 *    timeout the overlay reports it,
 *  - the context is always the token-capped read-only snapshot from
 *    context-builder, so the passive question can never push the active
 *    session's context around.
 */

import { buildQuickchatContext, estimateTokens } from './context-builder.ts'
import { appendToSessionLog, createOverlay, QUICKCHAT_TIMEOUT_MS, type QuickchatOverlay } from './overlay.ts'
import type { Provider } from '../providers/types.ts'
import type {
  DelegationMode,
  DelegationRecord,
  DelegationSource,
  QuickchatContext,
  QuickchatDelegationResult,
  QuickchatPlanStep,
  SessionBus,
  SessionHandle,
  SessionId,
} from '../session/types.ts'

export type FastResponder = (ctx: QuickchatContext, question: string, signal: AbortSignal) => Promise<string>

export interface FastTier {
  provider: Provider
  providerName: string
  model: string
  label: string
}

/** A /quickchat agent-loop call: one question, no tools, at most one step. */
export interface FastLoopCall {
  messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
  systemPrompt: string
  tools: readonly unknown[]
  useAnimation: boolean
  verbose: boolean
  maxSteps: number
  provider: Provider
  providerName: string
  model: string
  signal?: AbortSignal
}

/**
 * Test-only seam. Routes the default fast-tier call through an in-process
 * runner instead of the real `runAgentLoop`. Swapping this never touches the
 * shared module registry, so co-resident suites that import `agentLoop.ts` for
 * real keep their real imports.
 */
let __fastLoopOverride: ((opts: FastLoopCall) => Promise<unknown>) | undefined
export function setFastLoopOverrideForTests(runner: ((opts: FastLoopCall) => Promise<unknown>) | undefined): void {
  __fastLoopOverride = runner
}

export interface RunQuickchatOptions {
  /** A session id or (unambiguous) session name. */
  sessionRef: string
  question: string
  /** Test seam: bypass the real fast-tier model call. */
  fastResponder?: FastResponder
  /** Test seam: substitute the session bus instead of the process singleton. */
  bus?: SessionBus
  /** Wall-clock cap for the model call. Defaults to QUICKCHAT_TIMEOUT_MS. */
  timeoutMs?: number
  /** Directory for the per-session quickchat log. Defaults to the sessions dir. */
  logDir?: string
}

export interface RunQuickchatOutcome {
  answer: string
  overlay: QuickchatOverlay
}

class QuickchatTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`quickchat timed out after ${formatDuration(timeoutMs)}`)
  }
}

function formatDuration(ms: number): string {
  if (ms % 1000 === 0) return `${ms / 1000}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

/**
 * Runs one quickchat question against a session. Unknown sessions throw a
 * friendly error before any overlay or model call is created. The overlay opens
 * before the model is invoked; on success, timeout, or provider failure the
 * outcome is appended to the overlay and the session's quickchat log, and the
 * overlay closes. Nothing here advances the session's turn.
 */
export async function runQuickchat(opts: RunQuickchatOptions): Promise<RunQuickchatOutcome> {
  const bus = opts.bus ?? (await loadSessionBus())
  const session = bus.resolve(opts.sessionRef)
  if (session === undefined) {
    throw new Error(
      `Unknown session "${opts.sessionRef}". Run /sessions to list active sessions, or use /quickchat without --session to query the current one.`,
    )
  }

  const context = buildQuickchatContext(session)
  const overlay = createOverlay()
  overlay.open(opts.question, `${session.name} (${session.id})`)

  const timeoutMs = opts.timeoutMs ?? QUICKCHAT_TIMEOUT_MS
  const controller = new AbortController()
  const responder = opts.fastResponder ?? (await resolveFastResponder())

  let answer: string
  try {
    answer = await raceResponder(responder, context, opts.question, controller, timeoutMs)
  } catch (error) {
    answer = readableQuickchatError(error)
  } finally {
    controller.abort()
  }

  overlay.appendChunk(answer)
  appendToSessionLog(session.id, { kind: 'quickchat', question: opts.question, answer }, { dir: opts.logDir })
  overlay.close()

  return { answer, overlay }
}

async function raceResponder(
  responder: FastResponder,
  ctx: QuickchatContext,
  question: string,
  controller: AbortController,
  timeoutMs: number,
): Promise<string> {
  const hardTimeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      const error = new QuickchatTimeoutError(timeoutMs)
      // Settle the race with the timeout first; aborting then only wakes the
      // provider so it can stop spending tokens.
      reject(error)
      controller.abort()
      clearTimeout(timer)
    }, timeoutMs)
  })
  return Promise.race([responder(ctx, question, controller.signal), hardTimeout])
}

function readableQuickchatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/aborted/i.test(message)) return 'quickchat cancelled'
  return `quickchat failed: ${message}`
}

/**
 * Picks the tier a quickchat call goes to: always `config.tiers.fast`, never
 * the primary model. When no distinct fast tier is configured the config layer
 * aliases `fast` onto `deep`, so this mirrors that one-for-one.
 */
export function selectFastTier(config: { tiers: { fast: FastTier; deep?: FastTier } }): FastTier {
  return config.tiers.fast
}

/**
 * When no distinct fast tier is configured, `config.tiers.fast` is the same
 * object reference as `config.tiers.deep` (see `resolveFastTier`): quickchat
 * answers with the primary model then, so it must say so instead of pretending
 * it used a cheap tier.
 */
export function fastTierNote(config: { tiers: { fast: FastTier; deep?: FastTier }; cascadeEnabled?: boolean }): string | undefined {
  const aliased = config.cascadeEnabled === false || config.tiers.fast.label === config.tiers.deep?.label
  if (!aliased) return undefined
  return `Note: no distinct fast tier is configured, so this quickchat used the deep tier (${
    config.tiers.fast.label
  }). Set ELIA_FAST_PROVIDER/ELIA_FAST_MODEL for a dedicated fast tier.`
}

/**
 * The default fast-tier call path. Builds a Provider from `config.tiers.fast`
 * and runs ONE tool-less model call through the agent loop (`tools: []`,
 * `maxSteps: 1`, no animation, no verbosity, honouring the abort signal).
 * This is the only place quickchat invokes the fast tier — the primary model is
 * never used for overlay queries. Provider errors are folded into a readable
 * string rather than thrown.
 */
export async function resolveFastResponder(): Promise<FastResponder> {
  const [{ config }, { runAgentLoop, lastAssistantText }] = await Promise.all([
    import('../config.ts'),
    import('../agentLoop.ts'),
  ])
  const tier = selectFastTier(config)
  const note = fastTierNote(config)
  const runLoop = (__fastLoopOverride ?? runAgentLoop) as (opts: FastLoopCall) => Promise<unknown>
  return async (ctx, question, signal): Promise<string> => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: buildQuickchatPrompt(ctx, question) }] }]
    try {
      await runLoop({
        messages,
        systemPrompt: QUICKCHAT_SYSTEM_PROMPT,
        tools: [],
        useAnimation: false,
        verbose: false,
        maxSteps: 1,
        provider: tier.provider,
        providerName: tier.providerName,
        model: tier.model,
        signal,
      })
      const outcome = lastAssistantText(messages, '')
      if (note === undefined) return outcome
      return outcome.length > 0 ? `${outcome}\n\n${note}` : note
    } catch (error) {
      if (signal.aborted) return 'quickchat cancelled'
      const message = error instanceof Error ? error.message : String(error)
      return `quickchat failed: ${message}`
    }
  }
}

const QUICKCHAT_SYSTEM_PROMPT = `You are elia's quickchat observer: a fast, read-only "second pair of eyes" on an active session.
You are shown a snapshot of one running session: its current task, plan steps, recently modified files (summaries only), recent sub-agent output summaries, pending reviews, memory, and any current errors.
Answer the question studied and concisely: a short paragraph for a normal question, a tight list when the question asks for one.
You are an observer and have NO tools: you do not run commands, read files, or change anything — you answer only from this snapshot and general knowledge.
If the snapshot does not contain what the question needs, say so plainly instead of guessing.`

/** Serializes the (already token-capped) snapshot into the model prompt. Cheap and pure. */
export function buildQuickchatPrompt(ctx: QuickchatContext, question: string): string {
  const plan = ctx.planSteps.length > 0 ? ctx.planSteps.map((step) => `${step.id} ${step.title} [${step.status}]`).join('; ') : '(none)'
  const outputs = ctx.recentAgentOutputs.length > 0 ? ctx.recentAgentOutputs.join('\n---\n') : '(none)'
  const files = ctx.filesModified.length > 0 ? ctx.filesModified.map((file) => `${file.path}: ${file.summary}`).join('; ') : '(none)'
  const reviews = ctx.pendingReviews.length > 0 ? ctx.pendingReviews.join('; ') : '(none)'
  const errors = ctx.currentErrors.length > 0 ? ctx.currentErrors.join('; ') : '(none)'
  const memory = [
    ...ctx.memorySlice.localNotes.map((note) => `local note: ${note}`),
    ...ctx.memorySlice.localLessons.map((lesson) => `local lesson: ${lesson}`),
    ...ctx.memorySlice.projectNotes.map((note) => `project note: ${note}`),
    ...ctx.memorySlice.lessons.map((lesson) => `project lesson: ${lesson}`),
  ]
    .join(' | ') || '(none)'
  const snapshot = [
    `session: ${ctx.sessionName} (${ctx.sessionId})`,
    `current task: ${ctx.currentTask ?? '(none)'}`,
    `plan: ${plan}`,
    `files modified: ${files}`,
    `pending reviews: ${reviews}`,
    `current errors: ${errors}`,
    `memory: ${memory}`,
    `recent outputs:\n${outputs}`,
  ].join('\n')
  return `# Question\n\n${question}\n\n# Read-only session snapshot (bounded to ${estimateTokens(snapshot)} tokens by elia)\n\n${snapshot}`
}

/** Independent risk-flagging prompt for `/quickchat risk`. */
export const RISK_FLAG_PROMPT = `Act as an independent risk reviewer of this session's snapshot. List the most important risks right now — correctness, security, concurrency, data loss, or dubious assumptions in the work visible in the snapshot. One short line per risk, most severe first. If nothing risky is visible, say "no obvious risks in the current snapshot" and stop. Do not invent risks not supported by the snapshot.`

/** Parsed forms of the text after `/quickchat`. */
export type ParsedQuickchatCommand =
  | { kind: 'ask'; question: string }
  | { kind: 'delegate'; mode: 'after-step'; question: string }
  | { kind: 'delegate-new'; mode: 'new-session'; question: string }
  | { kind: 'delegate-now'; mode: 'now'; question: string }
  | { kind: 'status' }
  | { kind: 'summary' }
  | { kind: 'diff' }
  | { kind: 'risk' }
  | { kind: 'session-ask'; targetSession: string; question: string }

/**
 * Pure, model-free parser for the `/quickchat` command surface. Accepts text
 * with or without the leading `/quickchat` prefix:
 *   - `<question>`                    → ask
 *   - `delegate "…"`                  → delegate (after-step)
 *   - `delegate --new "…"`            → delegate-new
 *   - `delegate --now "…"`            → delegate-now
 *   - `status | summary | diff | risk`
 *   - `--session <name> "question"`   → session-ask
 */
export function parseQuickchatCommand(input: string): ParsedQuickchatCommand {
  const raw = input.trim().replace(/^\/quickchat\b/, '').trim()
  const lower = raw.toLowerCase()
  if (lower === 'status') return { kind: 'status' }
  if (lower === 'summary') return { kind: 'summary' }
  if (lower === 'diff') return { kind: 'diff' }
  if (lower === 'risk') return { kind: 'risk' }
  if (raw.startsWith('--session')) {
    const parsed = parseSessionAsk(raw)
    if (parsed !== undefined) return { kind: 'session-ask', targetSession: parsed.targetSession, question: parsed.question }
    return { kind: 'ask', question: raw }
  }
  if (/^delegate(?:\s|$)/i.test(raw)) {
    const rest = raw.replace(/^delegate(?:\s|$)/i, '').trim()
    if (rest.startsWith('--new')) return { kind: 'delegate-new', mode: 'new-session', question: stripQuotes(rest.replace(/^--new/, '').trim()) }
    if (rest.startsWith('--now')) return { kind: 'delegate-now', mode: 'now', question: stripQuotes(rest.replace(/^--now/, '').trim()) }
    return { kind: 'delegate', mode: 'after-step', question: stripQuotes(rest) }
  }
  return { kind: 'ask', question: raw }
}

function parseSessionAsk(raw: string): { targetSession: string; question: string } | undefined {
  const after = raw.replace(/^--session/, '').trim()
  if (after === '') return undefined
  const quoted = /^("([^"]*)"|'([^']*)')/.exec(after)
  let target: string
  let rest: string
  if (quoted) {
    target = quoted[2] ?? quoted[3] ?? ''
    rest = after.slice(quoted[0].length)
  } else {
    const token = /^(\S+)/.exec(after)
    if (token === null) return undefined
    target = token[1] ?? ''
    rest = after.slice(token[0].length)
  }
  return { targetSession: target, question: stripQuotes(rest.trim()) }
}

function stripQuotes(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

type DelegateParsed = Extract<ParsedQuickchatCommand, { kind: 'delegate' | 'delegate-new' | 'delegate-now' }>

interface DelegationApi {
  delegateTask(opts: {
    bus?: SessionBus
    target?: SessionId
    source?: DelegationSource
    goal: string
    mode: DelegationMode
  }): Promise<DelegateTaskResult>
}

interface DelegateTaskResult {
  record: DelegationRecord
  confirmation: string
  spawned?: SessionId
}

async function pushDelegation(bus: SessionBus, session: SessionHandle, parsed: DelegateParsed): Promise<DelegateTaskResult> {
  const mod = (await import('../session/delegation.ts')) as unknown as DelegationApi
  if (typeof mod?.delegateTask !== 'function') {
    throw new Error('delegation is not available in this build of the session layer')
  }
  return mod.delegateTask({ bus, target: session.id, source: 'quickchat', goal: parsed.question, mode: parsed.mode })
}

function delegationConfirmation(parsed: DelegateParsed, result: DelegateTaskResult): string {
  const when =
    parsed.mode === 'now'
      ? 'starting immediately'
      : parsed.mode === 'new-session'
        ? `spawned${result.spawned ? ` in session ${result.spawned}` : ' in a new session'}`
        : 'queued to run after the current step'
  return `Delegate ${result.confirmation} (${when}; record ${result.record.id}).`
}

export interface SessionExtras {
  planSteps?: QuickchatPlanStep[]
  filesModified?: Array<{ path: string; summary: string }>
}

/** Renders a 5-line status summary from a session handle and optional extras. */
export function renderSummary(session: SessionHandle, extras: SessionExtras = {}): string {
  const steps = extras.planSteps ?? []
  const files = extras.filesModified ?? []
  const doneSteps = steps.filter((step) => step.status === 'done').length
  const runningStep = steps.find((step) => step.status === 'running')
  const queueByStatus = new Map<string, number>()
  for (const task of session.taskQueue) queueByStatus.set(task.status, (queueByStatus.get(task.status) ?? 0) + 1)
  const queueLine =
    session.taskQueue.length === 0
      ? 'queue: empty'
      : `queue: ${[...queueByStatus.entries()].map(([status, count]) => `${count} ${status}`).join(', ')}`
  const memory = session.memorySlice
  return [
    `session: ${session.name} (${session.status})${session.lastTask ? ` — ${session.lastTask}` : ''}`,
    `plan: ${doneSteps}/${steps.length} step${steps.length === 1 ? '' : 's'} done${runningStep ? `, "${runningStep.title}" in progress` : ''}`,
    `files: ${files.length} modified${files.length > 0 ? ` (${files.slice(0, 3).map((file) => file.path).join(', ')})` : ''}`,
    queueLine,
    `memory: ${memory.localNotes.length} local note(s), ${memory.lessons.length} project lesson(s)`,
  ].join('\n')
}

/** Renders the files-modified list for `/quickchat diff`. */
export function renderDiff(files: Array<{ path: string; summary: string }>): string {
  if (files.length === 0) return 'No modified files recorded in the session snapshot.'
  return files.map((file) => `- ${file.path}${file.summary.trim() ? `: ${file.summary}` : ''}`).join('\n')
}

export interface QuickchatCommandDeps {
  bus?: SessionBus
  /** Bypass the real fast-tier call in asks/risk (tests, or callers that already have a responder). */
  fastResponder?: FastResponder
  /** Extra plan steps for `summary`, when the caller tracks them. */
  planSteps?: QuickchatPlanStep[]
  /** Extra files-modified summaries for `summary`/`diff`, when the caller tracks them. */
  filesModified?: Array<{ path: string; summary: string }>
  /** Directory for the quickchat log (tests only). */
  logDir?: string
}

/**
 * Handles a REPL/CLI input line that leads with `/quickchat`. Anything else is
 * returned as `{ handled: false }` and left for the interactive pipeline.
 */
export async function handleQuickchatCommand(
  input: string,
  session: SessionHandle,
  deps: QuickchatCommandDeps = {},
): Promise<{ handled: boolean; result?: unknown }> {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/quickchat')) return { handled: false }
  const parsed = parseQuickchatCommand(trimmed)
  switch (parsed.kind) {
    case 'ask':
      if (!parsed.question.trim()) return { handled: true, result: { error: 'Usage: /quickchat <question>' } }
      return { handled: true, result: await runQuickchatSafe({ sessionRef: session.id, question: parsed.question, ...depsToRun(deps) }) }
    case 'session-ask': {
      const missing = parsed.targetSession === '' || !parsed.question.trim()
      if (missing) return { handled: true, result: { error: 'Usage: /quickchat --session <name> <question>' } }
      return {
        handled: true,
        result: await runQuickchatSafe({ sessionRef: parsed.targetSession, question: parsed.question, ...depsToRun(deps) }),
      }
    }
    case 'status':
      return { handled: true, result: { status: session.status, taskQueue: session.taskQueue } }
    case 'summary':
      return { handled: true, result: renderSummary(session, { planSteps: deps.planSteps, filesModified: deps.filesModified }) }
    case 'diff':
      return { handled: true, result: renderDiff(deps.filesModified ?? []) }
    case 'risk':
      return { handled: true, result: await runQuickchatSafe({ sessionRef: session.id, question: RISK_FLAG_PROMPT, ...depsToRun(deps) }) }
    case 'delegate':
    case 'delegate-new':
    case 'delegate-now': {
      const bus = deps.bus ?? (await loadSessionBus())
      try {
        const result = await pushDelegation(bus, session, parsed)
        const confirmation = delegationConfirmation(parsed, result)
        return { handled: true, result: { record: result.record, confirmation } satisfies QuickchatDelegationResult }
      } catch (error) {
        return { handled: true, result: { error: readableQuickchatError(error) } }
      }
    }
  }
}

function depsToRun(deps: QuickchatCommandDeps): Pick<RunQuickchatOptions, 'bus' | 'fastResponder' | 'logDir'> {
  return { bus: deps.bus, fastResponder: deps.fastResponder, logDir: deps.logDir }
}

async function runQuickchatSafe(opts: RunQuickchatOptions): Promise<RunQuickchatOutcome | { error: string }> {
  try {
    return await runQuickchat(opts)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function loadSessionBus(): Promise<SessionBus> {
  const mod = (await import('../session/bus.ts')) as { getSessionBus?: () => SessionBus }
  if (typeof mod?.getSessionBus !== 'function') {
    throw new Error('Session support is not wired up in this build (session bus missing).')
  }
  return mod.getSessionBus()
}