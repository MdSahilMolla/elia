/**
 * A copy of an existing page, reported done without being held up to the original.
 *
 * "Recreate their website", then "I want the exact design", "copy them
 * exactly", "no, I want the design to be exact": four turns, each logged as a
 * verified pass, because what was checked was that the preview opened. Nothing
 * compared the copy with the page it copied, so "done" meant only "written".
 *
 * When a request asks to reproduce a page, the run wrote HTML or CSS, and an
 * original is named somewhere in the conversation, the model is sent back once
 * to measure the copy with compare_page and report what still differs.
 */

import { COPY_REQUEST } from '../tools/lazyTools.ts'

/** A URL or a bare domain — something compare_page can be pointed at. */
const NAMES_A_SITE = /https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|in|org|net|io|co|dev|app|ai|uk|us|de|fr|shop|store|site|xyz|me)\b/i
const WEB_FILE = /\.(?:html?|css)$/i
const WRITES = new Set(['write_file', 'edit_file'])

export const COPY_CHECK_NOTE =
  '[elia] This turn reproduced an existing page, and nothing has checked the copy against the original. ' +
  "Run compare_page with the original's URL and your HTML file, fix what it reports missing, and run it again. " +
  'Tell the user the likeness it measured and what still differs; do not call the copy exact unless the comparison supports it.'

export interface CopyCheckGuard {
  observe(calls: { name: string; input: Record<string, unknown> }[]): void
  /** At a final answer: the note to send back, or undefined to let the turn end. */
  beforeFinish(): string | undefined
}

/** `request` is this run's message; `conversation` is the text the original may be named in; `canCompare` is whether compare_page exists here. */
export function createCopyCheckGuard(request: string, conversation: string, canCompare: boolean): CopyCheckGuard {
  const applies = canCompare && COPY_REQUEST.test(request) && NAMES_A_SITE.test(conversation)
  let wroteWeb = false
  let compared = false
  let sent = false
  return {
    observe(calls) {
      for (const call of calls) {
        if (call.name === 'compare_page') compared = true
        if (WRITES.has(call.name) && typeof call.input.path === 'string' && WEB_FILE.test(call.input.path)) wroteWeb = true
      }
    },
    beforeFinish() {
      if (!applies || !wroteWeb || compared || sent) return undefined
      sent = true
      return COPY_CHECK_NOTE
    },
  }
}
