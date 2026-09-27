/**
 * Live replies: talking to elia while it works.
 *
 * A message sent mid-turn used to wait: plain text was folded into the running
 * work at its next step boundary, and the only way to just *ask* something was
 * `/quickchat`, which answered from a thin session snapshot that did not even
 * include the conversation. Now every message sent while elia is busy gets an
 * answer right away, from a second, read-only lane of the same session:
 *
 *   - it sees what the work lane sees — the conversation so far (including the
 *     running turn's tool calls and results), the request being worked on, the
 *     plan, the tools running this second, the autopilot's state when one runs
 *   - it can open files (read_file, list_files, grep, find_symbol), so "what
 *     does parseDate do?" gets a real answer, not a guess from a summary
 *   - it cannot change anything; the work lane is the only one that acts
 *
 * When the message is a direction rather than a question ("also add tests",
 * "stop touching the auth module"), the reply ends with one `STEER:` line, and
 * that line — not the raw message — is folded into the running work. One model
 * call decides both what to say and whether the work must change.
 */

import type { ChatMessage, ContentBlock } from '../providers/types.ts'

/** What the UI knows about the running turn right now. */
export interface LiveView {
  /** The request the running turn is working on. */
  request: string
  elapsedMs: number
  /** The working line's current status, if any. */
  status: string
  /** Tools running this second, as the working line names them. */
  runningTools: string[]
  plan: Array<{ content: string; status: string }>
  /** This turn's finished tool calls, oldest first: name, a short input, outcome. */
  recentTools: Array<{ name: string; input: string; outcome: string; isError: boolean }>
  /** The tail of what the model has written this turn. */
  assistantSoFar: string
  /**
   * Progress lines the turn has printed, oldest first: an escalated run's
   * phases, the autopilot's narration. Often the only record of work that
   * runs outside the turn's own tool calls.
   */
  progress?: string[]
  /** Directions already queued for the running work. */
  steering: string[]
}

export interface LiveContext extends LiveView {
  /** The session's conversation, the running turn included. */
  conversation: readonly ChatMessage[]
  /** The autopilot's snapshot, when one is running in this session. */
  pilot?: string
  /** Earlier live exchanges this turn, so "do that" can resolve. */
  exchanges: Array<{ question: string; answer: string }>
  cwd: string
}

export interface LiveAnswer {
  answer: string
  /** An instruction for the running work, when the message asked it to change. */
  steer?: string
  model: string
}

export const LIVE_SYSTEM = `You are elia, answering the person you work for while you are in the middle of a task for them. They sent a message mid-task. Another part of you is still doing the work; you are the part that talks.

You are given the conversation so far (the running turn included), the request being worked on, what the work has done this turn and is doing right now, and — when the autopilot is running — its state. You have read-only tools (read_file, list_files, grep, find_symbol): use one or two when the answer depends on code you have not seen. You cannot change anything.

Answer directly and briefly, like a colleague glancing up from the keyboard: what you are doing and why, what you found, how far along it is, what comes next. Be concrete — files, commands, results. Never claim something is done unless the activity shows it done. If you do not know, say what you would check.

If the message asks the work to change — do something more or different, skip or stop something, use another approach, a correction — end your reply with exactly one line:
STEER: <an imperative, self-contained instruction for the working part>
Only questions get no STEER line.`

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+\n/g, '\n').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function renderBlock(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text':
      return clip(block.text, 1_500)
    case 'tool_use':
      return `[tool call ${block.name} ${clip(JSON.stringify(block.input), 240)}]`
    case 'tool_result':
      return `[tool result${block.is_error ? ' (error)' : ''}: ${clip(block.content, 400)}]`
    case 'image':
      return `[image${block.alt ? `: ${block.alt}` : ''}]`
    default:
      return undefined
  }
}

/** The conversation as compact text, newest kept when it must be cut. */
export function renderConversation(messages: readonly ChatMessage[], maxChars = 14_000): string {
  const rendered: string[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    const body = message.content.map(renderBlock).filter(Boolean).join('\n')
    if (!body) continue
    const entry = `${message.role === 'user' ? 'USER' : 'ELIA'}: ${body}`
    if (used + entry.length > maxChars) {
      rendered.push(`… ${index + 1} earlier message(s) omitted`)
      break
    }
    rendered.push(entry)
    used += entry.length
  }
  return rendered.reverse().join('\n\n')
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 90 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

export function buildLivePrompt(ctx: LiveContext, question: string): string {
  const plan = ctx.plan.length > 0 ? ctx.plan.map((step) => `- [${step.status}] ${step.content}`).join('\n') : '(no plan shown)'
  const tools = ctx.recentTools.length > 0
    ? ctx.recentTools.slice(-15).map((tool) => `- ${tool.name} ${tool.input}${tool.isError ? ' → ERROR' : ''}${tool.outcome ? ` → ${tool.outcome}` : ''}`).join('\n')
    : '(none yet)'
  const sections = [
    `# Their message (sent ${seconds(ctx.elapsedMs)} into the running turn)\n\n${question}`,
    `# The request being worked on\n\n${ctx.request || '(unknown)'}`,
    `# Right now\n\nstatus: ${ctx.status || '(working)'}\nrunning: ${ctx.runningTools.join(', ') || '(no tool running — the model is thinking or writing)'}`,
    `# Plan\n\n${plan}`,
    `# Tool calls this turn (oldest first)\n\n${tools}`,
    ctx.progress && ctx.progress.length > 0 ? `# Progress lines this turn (oldest first)\n\n${ctx.progress.slice(-20).map((line) => `- ${clip(line, 240)}`).join('\n')}` : '',
    ctx.assistantSoFar ? `# What the work has written this turn (tail)\n\n${clip(ctx.assistantSoFar.slice(-2_000), 2_000)}` : '',
    ctx.steering.length > 0 ? `# Directions already queued for the work\n\n${ctx.steering.map((s) => `- ${s}`).join('\n')}` : '',
    ctx.pilot ? `# Autopilot (running in this session)\n\n${ctx.pilot}` : '',
    ctx.exchanges.length > 0 ? `# Earlier messages during this turn\n\n${ctx.exchanges.slice(-4).map((x) => `Q: ${x.question}\nA: ${clip(x.answer, 600)}`).join('\n\n')}` : '',
    `# The conversation so far\n\n${renderConversation(ctx.conversation) || '(empty)'}`,
    // Said again last, where a small model is still listening: it will
    // otherwise answer "I'll add that test" and never hand it to the work.
    '# Reply now\n\nYou do not do the work yourself — the working part does. If their message asks for any change (more, less, different, stop, also…), your last line must be `STEER: <instruction>`. A plain question gets no STEER line.',
  ]
  return sections.filter(Boolean).join('\n\n')
}

/**
 * Whether a message reads as a direction rather than a question. The safety
 * net under the STEER protocol: a model that answers "sure, I'll add that"
 * and forgets the STEER line must not swallow the instruction.
 */
export function looksLikeDirection(message: string): boolean {
  const text = message.trim().toLowerCase()
  if (!text || /\?\s*$/.test(text)) return false
  if (/^(?:what|why|how|when|where|which|who|is|are|was|were|do|does|did|can you explain|could you explain|tell me|explain|status|eta|progress)\b/.test(text)) return false
  return /^(?:please\s+|pls\s+|ok(?:ay)?[,\s]+|and\s+|also\s+|now\s+)*(?:also|add|use|stop|don'?t|do not|never|skip|change|make|remove|rename|switch|instead|try|fix|implement|write|update|include|avoid|keep|drop|revert|undo|focus|prioriti[sz]e|wait|hold|pause|let'?s|go ahead|continue|ignore|leave|move|put|create|delete|build|run|test|refactor|split|merge)\b/.test(text)
    || /\b(?:instead|make sure|don'?t|do not|rather than)\b/.test(text)
}

/** Splits the reply into what the person reads and the instruction for the work. */
export function parseLiveAnswer(text: string): { answer: string; steer?: string } {
  const lines = text.trim().split(/\r?\n/)
  let steer: string | undefined
  const kept: string[] = []
  for (const line of lines) {
    const match = /^\s*(?:\*\*)?STEER:(?:\*\*)?\s*(.+?)\s*$/i.exec(line)
    if (match?.[1] && match[1].toLowerCase() !== 'none') steer = match[1].replace(/^[`"']|[`"']$/g, '')
    else if (!match) kept.push(line)
  }
  return { answer: kept.join('\n').trim(), ...(steer ? { steer } : {}) }
}

export type LiveResponder = (input: { system: string; user: string; cwd: string; signal: AbortSignal }) => Promise<{ text: string; model: string }>

/** Which tier answers: the fast tier when one is configured (ELIA_LIVE_TIER=deep overrides). */
async function liveRoute(): Promise<{ provider: import('../providers/types.ts').Provider; providerName: string; model: string }> {
  const { config } = await import('../config.ts')
  const tier = process.env.ELIA_LIVE_TIER?.trim().toLowerCase() === 'deep' ? config.tiers.deep : config.tiers.fast
  return { provider: tier.provider, providerName: tier.providerName, model: tier.model }
}

export const defaultLiveResponder: LiveResponder = async ({ system, user, cwd, signal }) => {
  const [{ runAgentLoop, lastAssistantText }, { toolsByName }, { withAgentIdentity }] = await Promise.all([
    import('../agentLoop.ts'),
    import('../tools/registry.ts'),
    import('../autonomy/context.ts'),
  ])
  const route = await liveRoute()
  const tools = ['read_file', 'list_files', 'grep', 'find_symbol'].map((name) => toolsByName[name]).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: user }] }]
  await withAgentIdentity({ name: 'live', role: 'lead', cwd, signal }, () =>
    runAgentLoop({ messages, systemPrompt: system, tools, useAnimation: false, verbose: false, maxSteps: 5, ...route, signal }))
  return { text: lastAssistantText(messages, ''), model: route.model }
}

export const LIVE_TIMEOUT_MS = 90_000

export async function answerWhileWorking(
  ctx: LiveContext,
  question: string,
  options: { signal?: AbortSignal; responder?: LiveResponder; timeoutMs?: number } = {},
): Promise<LiveAnswer> {
  const controller = new AbortController()
  const forward = () => controller.abort()
  options.signal?.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LIVE_TIMEOUT_MS)
  try {
    const reply = await (options.responder ?? defaultLiveResponder)({ system: LIVE_SYSTEM, user: buildLivePrompt(ctx, question), cwd: ctx.cwd, signal: controller.signal })
    if (controller.signal.aborted && !reply.text.trim()) throw new Error(options.signal?.aborted ? 'cancelled' : `no answer within ${Math.round((options.timeoutMs ?? LIVE_TIMEOUT_MS) / 1000)}s`)
    const parsed = parseLiveAnswer(reply.text)
    const steer = parsed.steer ?? (looksLikeDirection(question) ? question.trim() : undefined)
    return { answer: parsed.answer || (steer ? 'Understood — passing that to the work.' : '(no answer)'), ...(steer ? { steer } : {}), model: reply.model }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forward)
  }
}
