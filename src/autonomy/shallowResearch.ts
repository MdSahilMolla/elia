/**
 * A research request answered from search snippets alone.
 *
 * In the recorded sessions "do a research about gemini new model" and "do a
 * research on meat us india" each got one web_search and then a confident,
 * formatted report — written from the result snippets, with no source ever
 * opened. web_search's own description says to fetch pages before treating
 * snippets as evidence; the model read past it. A snippet is a lead: it can be
 * stale, cut mid-sentence, or about something else with the same name.
 *
 * So when a request asks for research and the model is about to answer having
 * read no page, it is sent back once to open the sources it is relying on.
 * Once only: a second short answer is the model's call, not a loop.
 */

/** Asked for research in so many words, common misspellings included. "Investigate the failing test" is debugging, so it is not here. */
const RESEARCH_REQUEST = /\b(?:re(?:sea|se|a?se|sa)rch(?:ing)?|deep[\s-]?dive|find\s+out\s+(?:about|what|whether))\b/i

export function isResearchRequest(text: string): boolean {
  return RESEARCH_REQUEST.test(text)
}

export const SHALLOW_RESEARCH_NOTE =
  '[elia] This was a research request, and you answered from search snippets without opening a single source. ' +
  'Before answering, web_fetch the two or three results your answer relies on most (in one batch), check your claims against what the pages actually say, and cite them. ' +
  'If none of them can be opened, say so in your answer.'

export interface ShallowResearchGuard {
  /** Record the tools one batch called. */
  observe(toolNames: string[]): void
  /** At a final answer: the note to send back, or undefined to let the turn end. */
  beforeFinish(): string | undefined
}

/**
 * Fires only when the answer stands on nothing but snippets: it searched and
 * opened nothing. A run that called no tool may be chat ("help with my research
 * paper"), and one that read or wrote local files was doing some other kind of
 * research; both are left alone.
 *
 * `request` is the user's message for this run; `canFetch` is whether this
 * agent has web_fetch at all (a guard that asks for a tool the agent lacks
 * would only waste a round trip).
 */
export function createShallowResearchGuard(request: string, canFetch: boolean): ShallowResearchGuard {
  const applies = canFetch && isResearchRequest(request)
  let searched = false
  let otherWork = false
  let sent = false
  return {
    observe(toolNames) {
      for (const name of toolNames) {
        if (name === 'web_search') searched = true
        else if (name !== 'todo_write') otherWork = true
      }
    },
    beforeFinish() {
      if (!applies || !searched || otherWork || sent) return undefined
      sent = true
      return SHALLOW_RESEARCH_NOTE
    },
  }
}
