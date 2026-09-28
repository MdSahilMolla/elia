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

/** A change to the plan the running work shows, by its step numbers (1-based). */
export type LivePlanEdit =
  | { kind: 'change'; step: number; to: string }
  | { kind: 'add'; after: number; title: string }
  | { kind: 'remove'; step: number }

export interface LiveAnswer {
  answer: string
  /** An instruction for the running work, when the message asked it to change. */
  steer?: string
  /** What the person wants, when the message is more than a question. */
  wants?: string
  /** How the plan should change, validated against the plan the work shows. */
  edits?: LivePlanEdit[]
  /** The reasoning behind the reply, as the panel showed it. */
  thinking?: string
  /** Sentences dropped because they claimed work no step backs up. */
  dropped?: number
  model: string
}

export const LIVE_SYSTEM = `You are elia, thinking about a message the person you work for sent while you are in the middle of a task for them. Another part of you is still doing the work; you are the part that reads the message, works out what they want, and decides whether the plan must change.

You are given the conversation so far (the running turn included), the request being worked on, the numbered plan, what the work has done this turn and is doing right now, and — when the autopilot is running — its state. You have read-only tools (read_file, list_files, grep, find_symbol): use one or two when the answer depends on code you have not seen. You cannot change anything yourself.

Reply in exactly this shape:
THINKING: <two or three sentences reasoning about what the message means for this work>
WANTS: <what they want, in one line — or "none" for a plain question>
ANSWER: <what you say to them: brief and concrete>
PLAN:
~ <step number> => <the step's new wording>
+ after <step number>: <a new step>
- <step number>
(write "PLAN: none" when the plan does not change)

Rules:
- The ANSWER says only what the activity shows. Never say you set up, wrote, ran or finished anything the tool calls and progress lines do not show. If nothing has been built yet, say so.
- Change the plan only when the message asks for something the plan does not already cover. Reword a step that should now do more; add a step for new work; remove a step they no longer want. Use the plan's own step numbers; "+ after 0" puts a step first.
- A plain question (status, why, how far) gets WANTS: none and PLAN: none.`

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
  const plan = ctx.plan.length > 0 ? ctx.plan.map((step, index) => `${index + 1}. [${step.status}] ${step.content}`).join('\n') : '(no plan shown)'
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
    '# Reply now\n\nYou do not do the work yourself — the working part does. Answer in the THINKING / WANTS / ANSWER / PLAN shape. If their message asks for any change, WANTS says what, and PLAN says how the numbered plan changes (or none).',
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

const SECTION = /^\s*(?:#+\s*)?(?:\*\*)?(THINKING|WANTS|ANSWER|PLAN|STEER)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$/i

/** The reply's sections, by header. Text before the first header is the answer (older replies had no headers). */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let current = 'ANSWER'
  const lines = text.trim().split(/\r?\n/)
  for (const line of lines) {
    const header = SECTION.exec(line)
    if (header) {
      current = header[1]!.toUpperCase()
      out.set(current, header[2] ?? '')
    } else {
      out.set(current, `${out.get(current) ?? ''}${out.has(current) && out.get(current) !== '' ? '\n' : ''}${line}`)
    }
  }
  return out
}

const NONE = /^\s*(?:none|n\/a|no change|-)?\s*\.?\s*$/i

/** Reads PLAN lines against a plan of `planLength` steps; anything that does not name a real step is dropped. */
export function parsePlanEdits(block: string, planLength: number): LivePlanEdit[] {
  const edits: LivePlanEdit[] = []
  for (const line of block.split(/\r?\n/)) {
    const change = /^\s*[~*]\s*(\d+)\s*(?:=>|->|→|:)\s*(.+?)\s*$/.exec(line)
    if (change) {
      const step = Number(change[1])
      if (step >= 1 && step <= planLength) edits.push({ kind: 'change', step, to: change[2]! })
      continue
    }
    const add = /^\s*\+\s*(?:after\s+(\d+)\s*[:\-–]?\s*)?(.+?)\s*$/i.exec(line)
    if (add) {
      const after = add[1] === undefined ? planLength : Number(add[1])
      if (after >= 0 && after <= planLength && add[2]) edits.push({ kind: 'add', after, title: add[2] })
      continue
    }
    const remove = /^\s*-\s*(\d+)\b/.exec(line)
    if (remove) {
      const step = Number(remove[1])
      if (step >= 1 && step <= planLength) edits.push({ kind: 'remove', step })
    }
  }
  return edits
}

/** Splits the reply into what the person reads, what they want, the plan change, and the instruction for the work. */
export function parseLiveAnswer(text: string, planLength = 0): { answer: string; steer?: string; wants?: string; edits?: LivePlanEdit[]; thinking?: string } {
  const parts = sections(text)
  const answer = (parts.get('ANSWER') ?? '').trim()
  const steerRaw = parts.get('STEER')?.trim().replace(/^[`"']|[`"']$/g, '')
  const wantsRaw = parts.get('WANTS')?.trim()
  const planRaw = parts.get('PLAN')
  const thinking = parts.get('THINKING')?.trim()
  const wants = wantsRaw && !NONE.test(wantsRaw) ? wantsRaw : undefined
  const edits = planRaw && !NONE.test(planRaw) ? parsePlanEdits(planRaw, planLength) : []
  return {
    answer,
    ...(steerRaw && !NONE.test(steerRaw) ? { steer: steerRaw } : {}),
    ...(wants ? { wants } : {}),
    ...(edits.length > 0 ? { edits } : {}),
    ...(thinking ? { thinking } : {}),
  }
}

/** Where the THINKING section stands while the reply streams — what the panel shows as it is written. */
export function streamingThinking(textSoFar: string): string {
  const start = /(?:^|\n)\s*(?:\*\*)?THINKING(?:\*\*)?\s*:\s*/i.exec(textSoFar)
  if (!start) return ''
  const rest = textSoFar.slice(start.index + start[0].length)
  const next = /\n\s*(?:\*\*)?(?:WANTS|ANSWER|PLAN|STEER)(?:\*\*)?\s*:/i.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'lsp_refactor', 'run_command', 'run_program', 'process', 'provision_environment', 'database', 'task'])
const ABOUT_PLAN = /\b(?:plan|step|steps|todo|to-do)\b/i
const CLAIM = /\b(?:I|I've|I have|I just|we|we've|we have)\s+(?:(?:just|already|also|now)\s+)*(?:set up|setup|created|added|built|wrote|written|implemented|installed|launched|ran|run|deployed|fixed|updated|committed|integrated|finished|completed|scaffolded|made)\b/i

/**
 * Drops sentences that claim work nothing backs up. With no finished tool call
 * that could have done it, a "I've set up the physics engine" is a claim the
 * person would act on, and it is false — seen live, twice, from the reply lane.
 */
export function stripUnbackedClaims(answer: string, recentTools: LiveView['recentTools'], planChanged = false): { text: string; dropped: number } {
  const did = recentTools.filter((tool) => !tool.isError && WRITE_TOOLS.has(tool.name))
  const sentences = answer.split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(])/)
  let dropped = 0
  const kept = sentences.filter((sentence) => {
    if (!CLAIM.test(sentence)) return true
    // "I've updated the plan" is true when this reply changed it — the session
    // applies the change the moment the reply lands.
    if (planChanged && ABOUT_PLAN.test(sentence) && !/[\w-]+\.[a-z0-9]{1,6}\b/i.test(sentence)) return true
    if (did.length === 0) {
      dropped += 1
      return false
    }
    // A claim that names a file keeps only when some step touched that file.
    const files = sentence.match(/[\w./-]+\.[a-z0-9]{1,6}\b/gi) ?? []
    if (files.length > 0 && !files.some((file) => did.some((tool) => tool.input.includes(file.split('/').pop()!)))) {
      dropped += 1
      return false
    }
    return true
  })
  return { text: kept.join(' ').trim(), dropped }
}

export type LiveResponder = (input: {
  system: string
  user: string
  cwd: string
  signal: AbortSignal
  /** The reply as it streams, and the model's own reasoning when it returns any. */
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
}) => Promise<{ text: string; model: string }>

/**
 * Which tier answers: the main model. The small fast tier answered quickly and
 * invented progress ("I just added snake.py and launched it") before anything
 * ran; this lane decides plan changes now, so it gets the model that plans.
 * ELIA_LIVE_TIER=fast opts back into the fast tier.
 */
async function liveRoute(): Promise<{ provider: import('../providers/types.ts').Provider; providerName: string; model: string }> {
  const { config } = await import('../config.ts')
  const tier = process.env.ELIA_LIVE_TIER?.trim().toLowerCase() === 'fast' ? config.tiers.fast : config.tiers.deep
  return { provider: tier.provider, providerName: tier.providerName, model: tier.model }
}

export const defaultLiveResponder: LiveResponder = async ({ system, user, cwd, signal, onText, onReasoning }) => {
  const [{ runAgentLoop, lastAssistantText }, { toolsByName }, { withAgentIdentity }] = await Promise.all([
    import('../agentLoop.ts'),
    import('../tools/registry.ts'),
    import('../autonomy/context.ts'),
  ])
  const route = await liveRoute()
  const tools = ['read_file', 'list_files', 'grep', 'find_symbol'].map((name) => toolsByName[name]).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: user }] }]
  await withAgentIdentity({ name: 'live', role: 'lead', cwd, signal }, () =>
    runAgentLoop({ messages, systemPrompt: system, tools, useAnimation: false, verbose: false, maxSteps: 5, ...route, signal, onText, onThinking: onReasoning }))
  return { text: lastAssistantText(messages, ''), model: route.model }
}

export const LIVE_TIMEOUT_MS = 90_000

export async function answerWhileWorking(
  ctx: LiveContext,
  question: string,
  options: {
    signal?: AbortSignal
    responder?: LiveResponder
    timeoutMs?: number
    /** The reasoning so far, each time more of it arrives — what the thinking panel shows. */
    onThinking?: (textSoFar: string) => void
  } = {},
): Promise<LiveAnswer> {
  const controller = new AbortController()
  const forward = () => controller.abort()
  options.signal?.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LIVE_TIMEOUT_MS)
  let streamed = ''
  let reasoning = ''
  const show = () => {
    const thinking = [reasoning.trim(), streamingThinking(streamed)].filter(Boolean).join('\n')
    if (thinking) options.onThinking?.(thinking)
  }
  try {
    const reply = await (options.responder ?? defaultLiveResponder)({
      system: LIVE_SYSTEM,
      user: buildLivePrompt(ctx, question),
      cwd: ctx.cwd,
      signal: controller.signal,
      onText: (delta) => {
        streamed += delta
        show()
      },
      onReasoning: (delta) => {
        reasoning += delta
        show()
      },
    })
    if (controller.signal.aborted && !reply.text.trim()) throw new Error(options.signal?.aborted ? 'cancelled' : `no answer within ${Math.round((options.timeoutMs ?? LIVE_TIMEOUT_MS) / 1000)}s`)
    const parsed = parseLiveAnswer(reply.text, ctx.plan.length)
    const checked = stripUnbackedClaims(parsed.answer, ctx.recentTools, (parsed.edits?.length ?? 0) > 0)
    const direction = parsed.wants !== undefined || (parsed.edits?.length ?? 0) > 0 || looksLikeDirection(question)
    const steer = parsed.steer ?? (direction ? `The person's note: ${question.trim()}${parsed.wants ? `\nThey want: ${parsed.wants}` : ''}` : undefined)
    const answer =
      checked.text ||
      ((parsed.edits?.length ?? 0) > 0
        ? 'Got it — the plan is changed to match.'
        : steer
          ? 'Understood — the work will take it into account.'
          : 'Nothing to report beyond what is running now.')
    const thinking = parsed.thinking ?? (reasoning.trim() || undefined)
    return {
      answer,
      ...(steer ? { steer } : {}),
      ...(parsed.wants ? { wants: parsed.wants } : {}),
      ...(parsed.edits ? { edits: parsed.edits } : {}),
      ...(thinking ? { thinking } : {}),
      ...(checked.dropped > 0 ? { dropped: checked.dropped } : {}),
      model: reply.model,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forward)
  }
}
