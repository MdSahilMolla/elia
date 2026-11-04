/**
 * A response the provider cut off at its output limit.
 *
 * Nothing used to notice. A long answer stopped mid-sentence and the turn ended
 * as if it were finished. Worse, a big write_file was cut mid-argument: the
 * half-streamed JSON failed to parse, the call ran with no input, failed on a
 * missing path, and the model tried the same oversized file again.
 *
 * The provider says when it stopped for length (finish_reason "length",
 * stop_reason "max_tokens"). Then the call it was in the middle of — always the
 * last block — is dropped, since its arguments are incomplete, and the model is
 * told what happened: continue a cut-off answer where it stopped, or write a
 * file too big for one response in parts. Bounded, so a model that keeps
 * running long cannot loop.
 */

import type { ContentBlock } from '../providers/types.ts'

/** Continuations one run gives a cut-off response before letting it stand. */
export const MAX_OUTPUT_LIMIT_CONTINUATIONS = 4

export interface CutOffResponse {
  /** The response to keep: everything but a tool call left incomplete. */
  content: ContentBlock[]
  /** The note to send the model, or undefined once continuations are spent. */
  note?: string
  /** The tool call that was dropped, if one was. */
  dropped?: string
}

export function cutOffToolNote(name: string): string {
  const parts = name === 'write_file'
    ? 'Write it in parts instead: write_file the first few hundred lines with partial: true, then write_file each next part with append: true (partial: true until the last part). '
    : 'Make the call again with smaller arguments, splitting the work across several calls. '
  return (
    `[elia] Your last response hit the output limit while writing a ${name} call, so that call was cut off and did not run. ` +
    parts +
    'Do not repeat calls that already ran.'
  )
}

export const CUT_OFF_TEXT_NOTE =
  '[elia] Your last message was cut off by the output limit. Continue exactly where it stopped, without repeating anything you already wrote. ' +
  'If what remains is long, put it in a file with write_file (in parts) rather than in the message.'

export function createOutputLimitGuard(maxContinuations = MAX_OUTPUT_LIMIT_CONTINUATIONS): { observe(content: ContentBlock[]): CutOffResponse } {
  let used = 0
  return {
    observe(content) {
      const last = content[content.length - 1]
      const dropped = last?.type === 'tool_use' ? last.name : undefined
      const kept = dropped ? content.slice(0, -1) : content
      if (used >= maxContinuations) return { content: kept, ...(dropped ? { dropped } : {}) }
      used += 1
      return { content: kept, note: dropped ? cutOffToolNote(dropped) : CUT_OFF_TEXT_NOTE, ...(dropped ? { dropped } : {}) }
    },
  }
}
