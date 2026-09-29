import { calculationBriefing, checkArithmetic, describeCalculations, type CalculationCheck } from './arithmetic.ts'
import { checkGrounding, describeGrounding, extractCitations, groundingBriefing, type GroundingResult } from './grounding.ts'

/**
 * The part of the reasoning layer every reply gets, whatever produced it.
 *
 * The search and the answer check are bought per request: they cost extra
 * attempts, so decide.ts spends them only where a check can tell the attempts
 * apart. That leaves most replies — a persona's, a plan's, one from another
 * mode, one sent back to the editor — with nothing checking them at all. What
 * every reply can have is the checks that cost no model call and cannot be
 * argued with: a citation either names a file and line that exist or it does
 * not (grounding.ts), and a stated calculation either holds or it does not
 * (arithmetic.ts).
 *
 * The same rule as those two modules: a clean audit proves nothing about the
 * reply beyond its citations and its sums, so it is never recorded as a pass.
 * It can only find something provably wrong, and then buys exactly one
 * correction — a second would be the model arguing with a file system.
 */

export interface ReplyAudit {
  grounding: GroundingResult
  arithmetic: CalculationCheck
  /** Citations that do not exist plus calculations that do not hold. */
  problems: number
}

export function auditReply(reply: string, options: { cwd: string; touched?: Iterable<string> }): ReplyAudit {
  const grounding = checkGrounding(extractCitations(reply), options.cwd, { touched: options.touched ?? [] })
  const arithmetic = checkArithmetic(reply)
  return { grounding, arithmetic, problems: grounding.ungrounded.length + arithmetic.wrong.length }
}

/** One message covering everything wrong, so one correction fixes all of it. Undefined when nothing is. */
export function auditBriefing(audit: ReplyAudit): string | undefined {
  const parts = [
    audit.grounding.ungrounded.length > 0 ? groundingBriefing(audit.grounding) : '',
    audit.arithmetic.wrong.length > 0 ? calculationBriefing(audit.arithmetic) : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

export function describeAudit(audit: ReplyAudit): string {
  const parts = [
    audit.grounding.ungrounded.length > 0 ? describeGrounding(audit.grounding) : '',
    audit.arithmetic.wrong.length > 0 ? describeCalculations(audit.arithmetic) : '',
  ].filter(Boolean)
  if (parts.length > 0) return parts.join('; ')
  const checked = audit.grounding.checked + audit.arithmetic.checked
  return checked === 0 ? 'nothing checkable in the reply' : `${audit.grounding.checked} citation(s) and ${audit.arithmetic.checked} calculation(s) checked, all hold`
}

export interface AuditOutcome {
  before: ReplyAudit
  /** Present only when a correction ran. */
  after?: ReplyAudit
}

/**
 * Audits a finished reply and, when something in it is provably wrong, spends
 * one correction on it. The caller owns how a correction runs — a plain turn, a
 * persona's turn, a sub-agent — because that is the one thing that differs
 * between the places a reply comes from.
 */
export async function auditAndCorrect(options: {
  reply: () => string
  cwd: string
  touched?: () => Iterable<string>
  /** Runs the correction; handed the audit that asked for it, for the caller to say what it found. */
  correct: (briefing: string, before: ReplyAudit) => Promise<void>
  signal?: AbortSignal
}): Promise<AuditOutcome> {
  const audit = () => auditReply(options.reply(), { cwd: options.cwd, ...(options.touched ? { touched: options.touched() } : {}) })
  const before = audit()
  const briefing = auditBriefing(before)
  if (!briefing || options.signal?.aborted) return { before }
  await options.correct(briefing, before)
  return { before, after: audit() }
}

interface ToolCallBlock {
  type: string
  input?: unknown
}

/**
 * The paths a turn's own tool calls named, from `messages[fromIndex]` on — for
 * the callers that have no file tracker. A citation to one of them is left
 * alone: "I removed src/old.ts:12" is true, and the file is gone because of it.
 */
export function pathsNamedByTools(messages: ReadonlyArray<{ content: ReadonlyArray<ToolCallBlock> }>, fromIndex = 0): string[] {
  const paths = new Set<string>()
  for (const message of messages.slice(fromIndex)) {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || !block.input || typeof block.input !== 'object') continue
      for (const key of ['path', 'file_path', 'from', 'to', 'destination']) {
        const value = (block.input as Record<string, unknown>)[key]
        if (typeof value === 'string' && value.trim()) paths.add(value)
      }
    }
  }
  return [...paths]
}
