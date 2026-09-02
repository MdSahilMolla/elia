import type { ContentBlock, Provider, StreamTurnParams, Usage } from '../../providers/types.ts'

/**
 * A deterministic stand-in for a real model, for latency measurement.
 *
 * A real provider makes elia's wall clock depend on network conditions, model
 * load, and sampling — none of which elia controls and all of which drown out
 * the thing a latency benchmark is trying to see: how much time elia's own loop,
 * tool dispatch, speculation, and startup add on top of the model. This provider
 * removes that variance. It replays a fixed script of assistant turns and can
 * simulate a model's pacing (time-to-first-token, per-token delay) with exact,
 * repeatable numbers, so a regression in elia's overhead shows up cleanly.
 */

export interface ScriptedToolCall {
  name: string
  input: Record<string, unknown>
}

/** One assistant turn: optional reasoning, optional text, and any tool calls it makes. */
export interface ScriptedTurn {
  thinking?: string
  text?: string
  toolCalls?: ScriptedToolCall[]
}

export interface ScriptedProviderOptions {
  /** Delay before the first streamed token of every turn. 0 = measure pure elia overhead. */
  ttftMs?: number
  /** Delay per ~4 characters of streamed text/reasoning, modelling generation speed. */
  tokenMs?: number
  /**
   * Synthetic usage reported for every call. Defaults to a cache-heavy split so
   * the numbers look like a warm agent loop rather than a cold first request.
   */
  usage?: Usage
}

const DEFAULT_USAGE: Usage = { inputTokens: 40, outputTokens: 60, cacheReadTokens: 8_000, cacheWriteTokens: 0 }

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

/** Splits text into ~4-char chunks so streaming pacing is roughly per-token. */
function chunk(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += 4) out.push(text.slice(i, i + 4))
  return out
}

export interface ScriptedProvider extends Provider {
  /** Number of streamTurn calls served so far. */
  readonly calls: number
}

/**
 * Builds a provider that serves `turns` in order. Once the script is exhausted
 * every further call returns a bare "done." text turn, so a loop that takes an
 * unexpected extra step still terminates instead of hanging the benchmark.
 */
export function createScriptedProvider(turns: ScriptedTurn[], options: ScriptedProviderOptions = {}): ScriptedProvider {
  const ttftMs = options.ttftMs ?? 0
  const tokenMs = options.tokenMs ?? 0
  const usage = options.usage ?? DEFAULT_USAGE
  let calls = 0

  return {
    get calls() {
      return calls
    },

    async streamTurn({ onText, onThinking, onToolBlock, signal }: StreamTurnParams): Promise<{ content: ContentBlock[]; usage: Usage }> {
      const turn = turns[calls] ?? { text: 'done.' }
      calls += 1

      await sleep(ttftMs)
      if (signal?.aborted) throw new Error('aborted')

      if (turn.thinking) {
        for (const piece of chunk(turn.thinking)) {
          onThinking?.(piece)
          await sleep(tokenMs)
        }
      }
      if (turn.text) {
        for (const piece of chunk(turn.text)) {
          onText(piece)
          await sleep(tokenMs)
        }
      }

      const content: ContentBlock[] = []
      if (turn.text) content.push({ type: 'text', text: turn.text })

      turn.toolCalls?.forEach((call, index) => {
        const block: ContentBlock = { type: 'tool_use', id: `scripted_${calls}_${index}`, name: call.name, input: call.input }
        content.push(block)
        // Fire mid-stream exactly as a real adapter does at content_block_stop —
        // this is what lets the harness see the value of speculative dispatch.
        onToolBlock?.(block)
      })

      return { content, usage }
    },
  }
}
