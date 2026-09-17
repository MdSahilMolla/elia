/**
 * Google's OpenAI-compatible Gemini endpoint streams each tool call whole, in
 * one delta, and leaves out the `index` every other endpoint puts on it. The
 * openai SDK builds tool calls up by that index and throws on a missing one
 * ("invalid tool call index: undefined"), so every Gemini step that called a
 * tool failed before elia saw it. This fetch numbers them on the way in.
 */

type Fetch = typeof fetch

interface StreamChoice {
  index?: number
  delta?: { tool_calls?: Array<Record<string, unknown>> }
}

/** Gives each streamed tool call without an index the next free one for its choice. */
export function numberToolCalls(chunk: { choices?: StreamChoice[] }, next: Map<number, number>): boolean {
  let changed = false
  for (const choice of chunk.choices ?? []) {
    const calls = choice.delta?.tool_calls
    if (!Array.isArray(calls)) continue
    const key = choice.index ?? 0
    for (const call of calls) {
      if (typeof call.index === 'number') {
        next.set(key, Math.max(next.get(key) ?? 0, call.index + 1))
        continue
      }
      const index = next.get(key) ?? 0
      call.index = index
      next.set(key, index + 1)
      changed = true
    }
  }
  return changed
}

/** Rewrites an SSE body line by line, numbering tool calls; anything it cannot parse passes through untouched. */
export function numberToolCallsInStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const next = new Map<number, number>()
  let buffered = ''

  const rewrite = (line: string): string => {
    const match = /^data:\s?(.*)$/.exec(line)
    if (!match || !match[1]!.startsWith('{')) return line
    try {
      const chunk = JSON.parse(match[1]!) as { choices?: StreamChoice[] }
      return numberToolCalls(chunk, next) ? `data: ${JSON.stringify(chunk)}` : line
    } catch {
      return line
    }
  }

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffered += decoder.decode(bytes, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(rewrite).join('\n') + '\n'))
    },
    flush(controller) {
      buffered += decoder.decode()
      if (buffered) controller.enqueue(encoder.encode(rewrite(buffered)))
    },
  }))
}

/** A fetch for the openai SDK that repairs Gemini's streamed tool calls. */
export function geminiFetch(inner: Fetch = fetch): Fetch {
  const wrapped = async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const response = await inner(input, init)
    const type = response.headers.get('content-type') ?? ''
    if (!response.body || !type.includes('text/event-stream')) return response
    return new Response(numberToolCallsInStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  return wrapped as Fetch
}
