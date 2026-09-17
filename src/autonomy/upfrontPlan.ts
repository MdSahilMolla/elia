import type { ChatMessage, ContentBlock, Provider, ProviderActivity, Usage } from '../providers/types.ts'
import type { TodoItem } from './todoList.ts'

/**
 * elia thinks the request through out loud and writes the plan *before* it acts.
 *
 * Across 52 recorded sessions on mercury-2.5 the model planned first in 0 of 16
 * multi-step turns. It went straight to run_command / write_file, and the plan
 * the user eventually saw was one the planless-work nudge (toolBatchingNudge.ts)
 * forced out of it 8–12 tool calls in — a retroactive list of "remaining steps".
 * The system prompt's "call todo_write first" rule and a 0.95-confidence lesson
 * saying the same thing moved that to 2 of 12. And mercury-2.5 returns no
 * reasoning at all (its `reasoning_summary` is null), so nothing on screen said
 * why it was doing what it did — the user saw it "jump straight to the work".
 *
 * So planning is elia's step, not a hope about the model. Before the agent loop
 * runs a multi-step request, one tool-less call on the same model thinks it
 * through and returns a short checklist: the thinking streams to the screen as
 * reasoning, the checklist becomes the todo list and a visible plan, and the
 * lead model starts from it with the plan already written down. It runs with the
 * turn's project memory in its prompt, so what earlier sessions learned shapes
 * the plan where the user can see it.
 */

/** A work order, not a question — the only kind of request worth planning. */
const ACTION_VERB =
  /\b(?:build|create|make|add|implement|fix|update|refactor|rewrite|write|generate|set[-\s]?up|scaffold|migrate|convert|integrate|remove|delete|rename|change|design|redesign|improve|optimi[sz]e|port|upgrade|install|deploy|configure|research|replace|extend|enhance|clean[-\s]?up|debug|develop|automate|draft|prepare|restructure|document)\b/i

/** Opens like a question ("how do I add…" asks for an explanation, not the change). */
const QUESTION_OPENER = /^\s*(?:what|what's|whats|why|how|where|when|who|which|explain|describe|is|are|does|do|did|tell\s+me)\b/i

/** Planning past this many steps is a project plan, and that is `elia auto`'s job. */
const MAX_STEPS = 8
const MAX_STEP_CHARS = 200
const MAX_THINKING_CHARS = 1_200
const HISTORY_CHARS = 5_000
const DEFAULT_TIMEOUT_MS = 30_000

/** Context elia prepends to a turn (operator notes, `!cmd` output, an earlier plan) — not what the user asked. */
export function stripInjectedContext(text: string): string {
  return text
    .replace(/<operator-context>[\s\S]*?<\/operator-context>/g, '')
    .replace(/<local-command>[\s\S]*?<\/output>/g, '')
    .replace(/<elia-plan>[\s\S]*?<\/elia-plan>/g, '')
    .trim()
}

/**
 * Whether a request reads as multi-step work worth planning up front. Only the
 * instruction at the top counts — a pasted log underneath that mentions
 * "build" is not a work order. Deliberately loose: the planner itself answers
 * NONE for a trivial ask, so this only has to keep chat and questions out.
 */
export function wantsUpfrontPlan(rawRequest: string): boolean {
  const request = stripInjectedContext(rawRequest)
  if (request.length < 12 || request.startsWith('/')) return false
  const head = request
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 4)
    .join('\n')
    .slice(0, 400)
  if (QUESTION_OPENER.test(head)) return false
  return ACTION_VERB.test(head)
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** "write_file src/app.tsx" — enough for the planner to know what already happened, not the payload. */
function describeCall(block: Extract<ContentBlock, { type: 'tool_use' }>): string {
  const target = ['path', 'command', 'query', 'url', 'description']
    .map((key) => block.input[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return target ? `${block.name} ${clip(target, 70)}` : block.name
}

/** elia's own mid-turn corrections, which read as user messages but are not what the user said. */
const ELIA_INJECTED = /^(?:\[elia\]|This change is in "|The project's checks fail|The page you just built)/

/**
 * The conversation so far, compressed for the planner: what was asked, what
 * elia said, and which actions it took — no file contents, no tool output. A
 * follow-up ("now add a dark mode") is only plannable with this.
 */
export function conversationDigest(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    if (message.role === 'user') {
      const said = stripInjectedContext(text)
      if (said && !ELIA_INJECTED.test(said)) lines.push(`User: ${clip(said, 600)}`)
      continue
    }
    if (text.trim()) lines.push(`elia: ${clip(text, 600)}`)
    const calls = message.content.flatMap((block) => (block.type === 'tool_use' ? [describeCall(block)] : []))
    if (calls.length > 0) lines.push(`elia ran: ${calls.join('; ')}`)
  }
  const joined = lines.join('\n')
  return joined.length > HISTORY_CHARS ? `…${joined.slice(-HISTORY_CHARS)}` : joined
}

export function plannerPrompt(request: string, digest: string): string {
  return [
    digest ? `<conversation-so-far>\n${digest}\n</conversation-so-far>\n` : '',
    `<request>\n${request}\n</request>`,
    '',
    'First decide whether this needs a plan at all. Reply with exactly NONE, and nothing else, when the request is a question, small talk, or a small change you can make in one or two edits — fixing a typo, renaming something inside one file, a one-line or styling tweak. Most small requests need no plan.',
    '',
    'Otherwise, before you touch anything, think the request through and write the plan you are about to follow. The user reads this on screen, so write it for them. Reply in exactly this shape and nothing else:',
    'THINKING: 2-4 short first-person sentences — what the user actually wants, the approach you will take and why, and the one thing most likely to go wrong. If something under "What earlier runs learned about this project" or a weak-area warning applies here, say how you will act on it.',
    'PLAN:',
    '1. <a concrete step — what you will do, naming the files, commands, or pages involved>',
    '2. ...',
    `(3 to ${MAX_STEPS - 1} steps. The last step checks the result for real: run the build or the tests, or open the page.)`,
    'If the request names something you cannot confirm exists here — a package, skill, plugin, file, or command — the first step finds out what it is. Never plan a step like "if it is new, create it": when the thing turns out not to exist, the plan stops and asks the user what they meant.',
  ]
    .filter((line, index) => index !== 0 || line)
    .join('\n')
}

const PLAN_MARKER = /^[ \t]*(?:#{1,6}[ \t]*)?\**[ \t]*plan[ \t]*\**[ \t]*:?[ \t]*\**[ \t]*$/im
const INLINE_PLAN_MARKER = /^([ \t]*\**[ \t]*plan[ \t]*\**[ \t]*:[ \t]*\**)[ \t]*(?=\d{1,2}[.)]\s|[-*•]\s)/im
const THINKING_LABEL = /^\s*(?:#{1,6}\s*)?\**\s*(?:thinking|approach|reasoning)\s*\**\s*:?\s*\**\s*/i
const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.*\S)\s*$/
const LIST_START = /^[ \t]*(?:\d{1,2}[.)]|[-*•])[ \t]+/m
const NONE_REPLY = /^\W*none\b/i

function cleanStep(step: string): string {
  return clip(step.replace(/^\*\*(.*)\*\*$/, '$1').replace(/\*\*/g, ''), MAX_STEP_CHARS)
}

/** Where the plan starts: a `PLAN:` line, or failing that the first list item. */
function planStart(text: string): number {
  const marker = PLAN_MARKER.exec(text)
  if (marker) return marker.index
  const item = LIST_START.exec(text)
  return item ? item.index : -1
}

export interface ParsedPlan {
  thinking: string
  steps: string[]
}

/** Reads the planner's reply. Undefined for NONE or anything with fewer than two steps. */
export function parsePlannerReply(reply: string): ParsedPlan | undefined {
  const text = reply.replace(/\r/g, '').replace(INLINE_PLAN_MARKER, '$1\n').trim()
  if (!text || NONE_REPLY.test(text)) return undefined
  const start = planStart(text)
  if (start < 0) return undefined
  const marker = PLAN_MARKER.exec(text)
  const body = marker && marker.index === start ? text.slice(start + marker[0].length) : text.slice(start)
  const steps = body
    .split('\n')
    .flatMap((line) => {
      const match = LIST_ITEM.exec(line)
      return match ? [cleanStep(match[1]!)] : []
    })
    .filter(Boolean)
    .slice(0, MAX_STEPS)
  if (steps.length < 2) return undefined
  return { thinking: text.slice(0, start).replace(THINKING_LABEL, '').trim(), steps }
}

/**
 * The part of a partial reply that is safe to show as thinking so far: the
 * label stripped, the plan held back, and a short tail held until it is clear
 * it is not the start of the `PLAN:` line.
 */
export function visibleThinking(partial: string, final: boolean): string | undefined {
  const text = partial.replace(/\r/g, '')
  if (NONE_REPLY.test(text)) return ''
  // Too short to tell a "THINKING:" label from the first words of the answer.
  if (!final && text.length < 24 && !text.includes('\n')) return undefined
  const start = planStart(text)
  const shown = start >= 0 ? text.slice(0, start) : final ? text : text.slice(0, Math.max(0, text.length - 12))
  // Trimmed at both ends: a reply that opens with a blank line would put the
  // ✻ mark on that line and the thought below a gap.
  return shown.replace(THINKING_LABEL, '').trim().slice(0, MAX_THINKING_CHARS)
}

/** Feeds reply deltas in, emits only the growing thinking prefix — never the label, never the plan. */
export function createThinkingStream(emit: (delta: string) => void): { push(delta: string): void; finish(): string } {
  let reply = ''
  let shown = ''
  const advance = (final: boolean): void => {
    const visible = visibleThinking(reply, final)
    // A prefix that changed shape (a label recognised late) is not appended to —
    // garbling what is already on screen is worse than stopping early.
    if (visible === undefined || visible.length <= shown.length || !visible.startsWith(shown)) return
    emit(visible.slice(shown.length))
    shown = visible
  }
  return {
    push(delta) {
      reply += delta
      advance(false)
    },
    finish() {
      advance(true)
      return reply
    },
  }
}

export interface UpfrontPlan {
  thinking: string
  steps: string[]
  usage: Usage
  elapsedMs: number
}

export interface DraftUpfrontPlanOptions {
  provider: Provider
  cwd: string
  /** The lead's own system prompt and project memory, so the plan follows the same rules and lessons. */
  system: string
  systemDynamic?: string
  /** The conversation, ending with the request being planned. */
  messages: ChatMessage[]
  request: string
  onThinking?: (delta: string) => void
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Called when the plan could not be drafted for a reason the user should know
   * about — a provider error, a timeout, an unreadable reply.
   *
   * Not decoration. Swallowing every failure here makes "the provider is out of
   * credit" and "the planner judged this too small to plan" the same observable
   * event: no plan, no thinking, and a status line that says `Working…`. That
   * cost a debugging session to tell apart from the outside, which is precisely
   * the cost this callback exists to remove. An abort stays silent — the user
   * pressed Esc and does not need to be told what they just did.
   */
  onProblem?: (message: string) => void
}

/**
 * One tool-less call that thinks the request through and returns the plan, or
 * undefined when there is nothing worth planning or the call failed. Never
 * throws: a turn must not fail because its plan could not be drafted — the lead
 * model then simply starts without one, as it always used to.
 */
export async function draftUpfrontPlan(options: DraftUpfrontPlanOptions): Promise<UpfrontPlan | undefined> {
  const startedAt = Date.now()
  let modelReasoned = false
  let separated = false
  const stream = createThinkingStream((delta) => {
    // The model's own reasoning (Claude's thinking, a reasoning field) streams
    // first; keep elia's written-out thinking visibly separate from it.
    if (modelReasoned && !separated) {
      separated = true
      options.onThinking?.('\n\n')
    }
    options.onThinking?.(delta)
  })
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  // "Build this" next to a screenshot is only plannable with the screenshot.
  const images = (options.messages.at(-1)?.content ?? []).filter((block) => block.type === 'image')
  try {
    const result = await options.provider.streamTurn({
      cwd: options.cwd,
      system: options.system,
      systemDynamic: options.systemDynamic,
      messages: [
        {
          role: 'user',
          content: [...images, { type: 'text', text: plannerPrompt(options.request, conversationDigest(options.messages.slice(0, -1))) }],
        },
      ],
      tools: [],
      onText: (delta) => stream.push(delta),
      onThinking: (delta) => {
        modelReasoned = true
        options.onThinking?.(delta)
      },
      signal,
      // The written-out THINKING is the deliberation the user sees; long hidden
      // reasoning on top of it only delays the plan (≈1.5 s at low vs 3–5 s).
      reasoningEffort: 'low',
    })
    const streamed = stream.finish()
    const reply = streamed || result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    const parsed = parsePlannerReply(reply)
    if (!parsed) {
      // NONE is the planner doing its job on a small ask and stays quiet. A
      // reply that simply could not be read is a different event and says so.
      if (reply.trim() && !NONE_REPLY.test(reply.trim())) {
        options.onProblem?.('The planner replied with something that was not a plan, so this turn runs unplanned.')
      }
      return undefined
    }
    return { ...parsed, usage: result.usage, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    // Esc is not a failure worth narrating.
    if (!signal.aborted) {
      const detail = error instanceof Error ? error.message : String(error)
      options.onProblem?.(`Could not draft a plan — ${detail.split('\n', 1)[0]}. Running unplanned.`)
    }
    return undefined
  }
}

/** The drafted steps as the working todo list — the first one already under way. */
export function planTodoItems(steps: string[]): TodoItem[] {
  return steps.map((content, index) => ({ content, status: index === 0 ? 'in_progress' : 'pending' }))
}

/** The plan as a durable activity: a checklist in scrollback, and the pinned plan panel in the Ink UI. */
export function planActivity(steps: string[]): ProviderActivity {
  return {
    kind: 'plan',
    status: 'completed',
    title: `Plan · ${steps.length} steps`,
    detail: steps.map((step, index) => `${index === 0 ? '◐' : '□'} ${step}`).join('\n'),
  }
}

/** What the lead model is told: the plan exists, it is its todo list, and how to keep it current. */
export function planBriefing(steps: string[]): string {
  return [
    '<elia-plan>',
    'Before starting, elia thought this request through and showed the user this plan. It is already your todo list, with step 1 in progress:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    'Work through it in order. When a step is done, call todo_write to mark it completed and the next one in_progress; if the plan turns out wrong, rewrite the list instead of silently diverging from it. Before each batch of tool calls, say in one short sentence what you are about to do.',
    'A step is not permission to invent. If a search shows that something the request names does not exist, stop: tell the user what you looked for and found, and ask what they meant. Never create a stub, placeholder, or file whose only content claims the work is done.',
    '</elia-plan>',
  ].join('\n')
}

/** `ELIA_UPFRONT_PLAN=off` restores the old behaviour: the model plans (or doesn't) on its own. */
export function upfrontPlanEnabled(): boolean {
  return process.env.ELIA_UPFRONT_PLAN !== 'off'
}

/**
 * The same question, asked before an autonomous run instead of a chat turn:
 * what is this, how will I go at it, what is most likely to go wrong.
 *
 * The pipeline writes its own plan (the planner's `submit_proposal` call), so
 * this call produces only the thinking. It exists because the orient phase is
 * otherwise silent: between "elia will research it first" and a finished
 * five-step plan the user saw nothing for a minute, and read it — fairly — as
 * elia planning without thinking. mercury-2.5 returns no reasoning of its own,
 * and the planner prompt tells the model not to narrate its plan in prose, so
 * on an escalated run there was nothing left to show.
 */
export function runThinkingPrompt(goal: string, context = ''): string {
  return [
    context ? `<project>\n${clip(context, 1_500)}\n</project>\n` : '',
    `<request>\n${goal}\n</request>`,
    '',
    'You are about to investigate this project and then propose a plan for it. Before you start, think it through where the user can see it.',
    'Reply with 2-4 short first-person sentences and nothing else: what the user actually wants, how you mean to approach it, and the one thing most likely to go wrong. Name the frameworks, files, or commands you expect to be involved.',
    'Do not write the plan, do not use a numbered or bulleted list, and do not say anything is done or created — none of the work has started.',
  ]
    .filter((line, index) => index !== 0 || line)
    .join('\n')
}

export interface DraftRunThinkingOptions {
  provider: Provider
  cwd: string
  /** The planner's own system prompt, so the thinking obeys the same rules. */
  system: string
  systemDynamic?: string
  goal: string
  /** The project snapshot the planner is about to work from, if there is one. */
  context?: string
  onThinking?: (delta: string) => void
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * One tool-less call whose whole output is reasoning. Never throws and never
 * reports a problem: a run must not fail, or grow an error line, because its
 * opening thought could not be drafted.
 */
export async function draftRunThinking(
  options: DraftRunThinkingOptions,
): Promise<{ thinking: string; usage: Usage } | undefined> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let thinking = ''
  let modelReasoned = false
  let separated = false
  try {
    const result = await options.provider.streamTurn({
      cwd: options.cwd,
      system: options.system,
      systemDynamic: options.systemDynamic,
      messages: [{ role: 'user', content: [{ type: 'text', text: runThinkingPrompt(options.goal, options.context) }] }],
      tools: [],
      onText: (delta) => {
        if (thinking.length >= MAX_THINKING_CHARS) return
        // mercury-2.5 opens its reply with a blank line or two, and the ✻ mark
        // sits on the first line of whatever it is handed — so the block on screen
        // was a lone ✻ above a gap above the thought.
        const piece = thinking ? delta : delta.replace(/^\s+/, '')
        if (!piece) return
        // The model's own reasoning streams first on the providers that return
        // it; keep elia's written-out thinking visibly separate from it.
        if (modelReasoned && !separated) {
          separated = true
          options.onThinking?.('\n\n')
        }
        thinking += piece
        options.onThinking?.(piece)
      },
      onThinking: (delta) => {
        modelReasoned = true
        options.onThinking?.(delta)
      },
      signal,
      reasoningEffort: 'low',
    })
    const written = thinking || result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    return written.trim() ? { thinking: written.trim().slice(0, MAX_THINKING_CHARS), usage: result.usage } : undefined
  } catch {
    return undefined
  }
}
