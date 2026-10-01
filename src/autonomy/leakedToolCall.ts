/**
 * A tool call the model wrote as text, which therefore never ran.
 *
 * Some models (measured: mercury-2.5 on the battmann tool) now and then answer
 * with `<function=battmann> <parameter=action> feed_query </parameter> …
 * </function>` in the message body instead of a structured tool call. The
 * provider hands that back as ordinary text, so the turn ends with no tool
 * calls: nothing ran, no data came back, and the UI says "Worked for 14s". Asked
 * "what are you doing", the model then invented a status ("retrieval is in
 * progress") because nothing in its history said otherwise — and its own leaked
 * text sitting in that history made it write the next call the same way.
 *
 * This never executes the text. Running a call parsed out of prose would widen
 * what a page the model quoted can trigger. It only makes the failure true:
 * strip the markup out of the history, say plainly that nothing ran, and let the
 * model issue the call properly — a bounded number of times, then give up loudly.
 */

import type { ContentBlock } from '../providers/types.ts'

/** How many times one run corrects a leaked call before letting the turn end as it is. */
export const MAX_LEAKED_TOOL_CALL_RETRIES = 2

const FUNCTION_OPEN = /<function=([\w.:-]+)>/g
const FUNCTION_BLOCK = /<function=[\w.:-]+>[\s\S]*?<\/function>/g
const FUNCTION_UNCLOSED = /<function=[\w.:-]+>[\s\S]*$/
const HERMES_BLOCK = /<tool_call>\s*\{[\s\S]*?\}\s*<\/tool_call>/g
const HERMES_NAME = /<tool_call>\s*\{\s*"name"\s*:\s*"([\w.:-]+)"/g
const CALL_TOKEN = /<\|tool_calls?_(?:section_)?(?:begin|end)\|>/g

const PLACEHOLDER = '[a tool call written as text here did not run]'

/** Names of the tools a message tried to call as text, or undefined when it did no such thing. */
export function findLeakedToolCalls(text: string): string[] | undefined {
  const names = [...text.matchAll(FUNCTION_OPEN), ...text.matchAll(HERMES_NAME)].map((match) => match[1]!)
  if (names.length > 0) return [...new Set(names)]
  return new RegExp(CALL_TOKEN.source).test(text) ? [] : undefined
}

/** The message with every text-form call replaced by a marker, so the history no longer shows the model a pattern to copy. */
export function stripLeakedToolCalls(text: string): string {
  return text
    .replace(FUNCTION_BLOCK, PLACEHOLDER)
    .replace(FUNCTION_UNCLOSED, PLACEHOLDER)
    .replace(HERMES_BLOCK, PLACEHOLDER)
    .replace(CALL_TOKEN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || PLACEHOLDER // a bare `<|tool_call_end|>` would otherwise leave an empty text block, which some providers reject
}

export function leakedToolCallNote(names: string[]): string {
  const which = names.length > 0 ? ` (${names.join(', ')})` : ''
  return (
    `[elia] Your last message wrote a tool call as plain text${which} instead of using the tool-calling interface, so it did not run and nothing came back. ` +
    'Do not describe it as running or waiting. Make the call again as a real tool call, or say that you are not going to.'
  )
}

export interface LeakedToolCallVerdict {
  /** The message wrote at least one tool call as text. */
  leaked: boolean
  /** Set while retries remain: the note to send the model, after which the loop should go around again. */
  note?: string
}

/**
 * Judges each assistant message that made no structured tool call. Strips the
 * markup from its text blocks in place (whatever happens next), and hands back a
 * correction until the run's retries are spent.
 */
export function createLeakedToolCallGuard(maxRetries = MAX_LEAKED_TOOL_CALL_RETRIES): { observe(content: ContentBlock[]): LeakedToolCallVerdict } {
  let retries = 0
  return {
    observe(content) {
      const names = new Set<string>()
      let leaked = false
      for (const block of content) {
        if (block.type !== 'text') continue
        const found = findLeakedToolCalls(block.text)
        if (!found) continue
        leaked = true
        for (const name of found) names.add(name)
        block.text = stripLeakedToolCalls(block.text)
      }
      if (!leaked) return { leaked: false }
      if (retries >= maxRetries) return { leaked: true }
      retries += 1
      return { leaked: true, note: leakedToolCallNote([...names]) }
    },
  }
}
