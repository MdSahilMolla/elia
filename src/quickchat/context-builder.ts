/**
 * /quickchat context builder.
 *
 * Turns a live `SessionHandle` plus whatever cheap summaries the caller already
 * has into a bounded, model-safe `QuickchatContext`:
 *
 *  - Hard 4000-token cap on the WHOLE snapshot (measured with `estimateTokens`,
 *    a simple ~4 chars/token rule over the serialized snapshot).
 *  - `recentAgentOutputs` is pre-capped at ~2000 tokens, newest-first. When
 *    there is more output than budget, the OLDEST outputs are elided (they are
 *    the tail of the newest-first list) and a single ellipsis marker entry is
 *    appended, so the newest observations always survive.
 *  - Never reads files from disk. It only consumes caller-supplied summaries;
 *    raw file contents never enter the snapshot.
 *  - Any residual over-budget state is trimmed in a deterministic priority
 *    order (errors, reviews, files, plan steps, current task, memory), so the
 *    model always sees a snapshot within the token budget.
 */

import type { MemorySlice, QuickchatContext, QuickchatPlanStep, SessionHandle } from '../session/types.ts'

/** The whole snapshot, in elia's ~4 chars/token accounting, may never exceed this. */
export const QUICKCHAT_CONTEXT_TOKEN_CAP = 4000
/** The recent sub-agent output window alone is pre-capped at ~2000 tokens. */
export const QUICKCHAT_AGENT_OUTPUT_TOKEN_CAP = 2000

const CHARS_PER_TOKEN = 4
const ELLIPSIS_MARKER = '…'

/** Cheap token estimate: ~4 characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export interface BuildQuickchatContextOptions {
  /** Recent sub-agent outputs, NEWEST FIRST. Each item is a summary, never raw file contents. */
  recentAgentOutputs?: string[]
  /** Files the session changed, with human-readable summaries (not diffs). */
  filesModified?: Array<{ path: string; summary: string }>
  /** Pending review findings needing the session's attention. */
  pendingReviews?: string[]
  /** Current hard errors the session is fighting. */
  currentErrors?: string[]
  /** The session's plan steps, when the caller tracks them. */
  planSteps?: QuickchatPlanStep[]
  /** Current task label. Defaults to the session's `lastTask`. */
  currentTask?: string
}

interface MutableSnapshot {
  sessionId: SessionHandle['id']
  sessionName: SessionHandle['name']
  currentTask?: string
  planSteps: QuickchatPlanStep[]
  /** Recent agent outputs that were kept, newest first. The marker is separate so it is never popped. */
  outputs: string[]
  /** Number of older outputs elided to fit the budget. */
  droppedOutputs: number
  files: Array<{ path: string; summary: string }>
  reviews: string[]
  errors: string[]
  memory: MemorySlice
}

/** Every optional field falls back to the session handle when the caller did not supply it. */
export function buildQuickchatContext(session: SessionHandle, opts: BuildQuickchatContextOptions = {}): QuickchatContext {
  const { outputs, dropped } = capAgentOutputs(opts.recentAgentOutputs ?? [], QUICKCHAT_AGENT_OUTPUT_TOKEN_CAP)
  const snapshot: MutableSnapshot = {
    sessionId: session.id,
    sessionName: session.name,
    currentTask: opts.currentTask ?? session.lastTask,
    planSteps: opts.planSteps ?? [],
    outputs,
    droppedOutputs: dropped,
    files: opts.filesModified ?? [],
    reviews: opts.pendingReviews ?? [],
    errors: opts.currentErrors ?? [],
    memory: copyMemorySlice(session.memorySlice),
  }
  return enforceTokenCap(snapshot)
}

/** Rebuilds the read-only snapshot arrays so no session state is shared by reference. */
function copyMemorySlice(slice: MemorySlice): MemorySlice {
  return {
    lessons: [...slice.lessons],
    projectNotes: [...slice.projectNotes],
    localLessons: [...slice.localLessons],
    localNotes: [...slice.localNotes],
  }
}

/** Pre-caps recent outputs at `capTokens`, newest-first, dropping the oldest surpluses. */
function capAgentOutputs(outputs: string[], capTokens: number): { outputs: string[]; dropped: number } {
  if (outputs.length === 0) return { outputs: [], dropped: 0 }
  const kept: string[] = []
  let used = 0
  for (const output of outputs) {
    const cost = estimateTokens(output)
    if (kept.length > 0 && used + cost > capTokens) break
    kept.push(output)
    used += cost
  }
  // A single newest output alone larger than the cap is truncated, never dropped whole.
  if (kept.length === 0) {
    const first = outputs[0]
    if (first !== undefined) kept.push(fitToTokens(first, capTokens))
  } else if (kept.length === 1 && estimateTokens(kept[0]!) > capTokens) {
    kept[0] = fitToTokens(kept[0]!, capTokens)
  }
  return { outputs: kept, dropped: outputs.length - kept.length }
}

function agentOutputMarker(dropped: number): string {
  const noun = dropped === 1 ? 'output' : 'outputs'
  return `${ELLIPSIS_MARKER} +${dropped} older agent ${noun} elided to fit the context budget`
}

/** Serializes the public shape so the token cap is measured the way callers measure it. */
function publicize(s: MutableSnapshot): QuickchatContext {
  return {
    sessionId: s.sessionId,
    sessionName: s.sessionName,
    currentTask: s.currentTask,
    planSteps: s.planSteps,
    recentAgentOutputs: s.droppedOutputs > 0 ? [...s.outputs, agentOutputMarker(s.droppedOutputs)] : s.outputs,
    filesModified: s.files,
    pendingReviews: s.reviews,
    memorySlice: s.memory,
    currentErrors: s.errors,
  }
}

function tokenCost(ctx: QuickchatContext): number {
  return estimateTokens(JSON.stringify(ctx))
}

function enforceTokenCap(s: MutableSnapshot): QuickchatContext {
  const areas: Array<{ shrink(): boolean }> = [
    { shrink: () => shrinkTextList(s, 'errors') },
    { shrink: () => shrinkTextList(s, 'reviews') },
    { shrink: () => shrinkFiles(s) },
    { shrink: () => shrinkPlanSteps(s) },
    { shrink: () => shrinkTask(s) },
    { shrink: () => shrinkMemory(s) },
    { shrink: () => shrinkOutputs(s) },
  ]
  for (;;) {
    const current = publicize(s)
    if (tokenCost(current) <= QUICKCHAT_CONTEXT_TOKEN_CAP) return current
    let shrank = false
    for (const area of areas) {
      if (area.shrink()) {
        shrank = true
        break
      }
    }
    if (!shrank) {
      // Hard fallback: this state is over budget but nothing normal can shrink
      // further. Shave the largest single text down by one token at a time.
      const big = s.outputs[0] ?? s.currentTask
      if (big === undefined) return publicize(s)
      if (s.outputs[0] !== undefined) s.outputs[0] = fitToTokens(big, Math.max(1, estimateTokens(big) - 1))
      else s.currentTask = fitToTokens(big, Math.max(1, estimateTokens(big) - 1))
    }
  }
}

function shrinkTextList(s: MutableSnapshot, key: 'errors' | 'reviews'): boolean {
  const items = s[key]
  if (items.length === 0) return false
  if (items.length > 1) {
    s[key] = items.slice(0, -1)
    return true
  }
  const only = items[0]!
  const shrunken = fitToTokens(only, Math.max(1, Math.floor(estimateTokens(only) * 0.6)))
  if (shrunken === only) return false
  s[key] = [shrunken]
  return true
}

function shrinkFiles(s: MutableSnapshot): boolean {
  if (s.files.length === 0) return false
  if (s.files.length > 1) {
    s.files = s.files.slice(0, -1)
    return true
  }
  const only = s.files[0]!
  const shrunkenSummary = fitToTokens(only.summary, Math.max(1, Math.floor(estimateTokens(only.summary) * 0.6)))
  if (shrunkenSummary === only.summary) return false
  s.files = [{ path: only.path, summary: shrunkenSummary }]
  return true
}

function shrinkPlanSteps(s: MutableSnapshot): boolean {
  if (s.planSteps.length === 0) return false
  if (s.planSteps.length > 1) {
    s.planSteps = s.planSteps.slice(0, -1)
    return true
  }
  const only = s.planSteps[0]!
  const shrunkenTitle = fitToTokens(only.title, Math.max(1, Math.floor(estimateTokens(only.title) * 0.6)))
  if (shrunkenTitle === only.title) return false
  s.planSteps = [{ id: only.id, title: shrunkenTitle, status: only.status }]
  return true
}

function shrinkTask(s: MutableSnapshot): boolean {
  if (s.currentTask === undefined) return false
  const shrunken = fitToTokens(s.currentTask, Math.max(1, Math.floor(estimateTokens(s.currentTask) * 0.6)))
  if (shrunken === s.currentTask) return false
  s.currentTask = shrunken
  return true
}

function shrinkMemory(s: MutableSnapshot): boolean {
  // Drop from the most disposable arrays first; shared read-only lessons are kept longest.
  const order = ['localNotes', 'localLessons', 'projectNotes', 'lessons'] as const
  for (const key of order) {
    const items = s.memory[key]
    if (items.length === 0) continue
    s.memory = { ...s.memory, [key]: items.slice(0, -1) }
    return true
  }
  return false
}

function shrinkOutputs(s: MutableSnapshot): boolean {
  if (s.outputs.length > 1) {
    s.outputs.pop()
    s.droppedOutputs += 1
    return true
  }
  if (s.outputs.length === 1) {
    const only = s.outputs[0]!
    const shrunken = fitToTokens(only, Math.max(1, Math.floor(estimateTokens(only) * 0.6)))
    if (shrunken === only) return false
    s.outputs = [shrunken]
    return true
  }
  return false
}

function fitToTokens(text: string, capTokens: number): string {
  if (capTokens <= 0) return ''
  const maxChars = Math.floor(capTokens * CHARS_PER_TOKEN)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}${ELLIPSIS_MARKER}`
}