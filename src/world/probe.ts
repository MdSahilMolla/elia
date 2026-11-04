/**
 * What every model call of a tree pays before the conversation starts, read by
 * running that tree's own code.
 *
 * The same trap as the tool surface and the value probes: a check that runs
 * in-process measures the live installation whatever a candidate contains, so a
 * candidate that grew its prompt would look free. Run as an entry
 * (`bun run src/world/probe.ts`) from the tree being measured, it prints one
 * line of JSON — the size of the system prompt and of every tool definition a
 * benchmark task's agent is given, exactly the set `benchTask.ts` hands it.
 *
 * Immutable to the loop (sandbox.ts): a candidate that could edit this could
 * report the live tree's sizes while shipping bigger ones.
 */

export interface PrefixSizes {
  promptChars: number
  /** Every tool the benchmark's agent gets, with the size of its serialized definition. */
  tools: Array<{ name: string; chars: number }>
}

/** Characters per token the twin assumes. Only the ratio matters: calibration absorbs the rest. */
export const CHARS_PER_TOKEN = 4

export function prefixChars(sizes: PrefixSizes): number {
  return sizes.promptChars + sizes.tools.reduce((sum, tool) => sum + tool.chars, 0)
}

export function isPrefixSizes(value: unknown): value is PrefixSizes {
  const candidate = value as PrefixSizes | undefined
  return (
    typeof candidate?.promptChars === 'number' &&
    Array.isArray(candidate.tools) &&
    candidate.tools.every((tool) => typeof tool?.name === 'string' && typeof tool.chars === 'number')
  )
}

if (import.meta.main) {
  try {
    const { DEV_SYSTEM_PROMPT } = await import('../config.ts')
    const { allWorkerTools } = await import('../tools/registry.ts')
    const { taskTool } = await import('../tools/task.ts')
    const all = [...allWorkerTools(), taskTool]
    // What a call actually sends: with load-on-demand tools (tools/lazyTools.ts),
    // the core definitions plus the catalog, not every definition. A tree from
    // before that module existed sends them all.
    const lazy = await import('../tools/lazyTools.ts').catch(() => undefined)
    const sent = lazy ? lazy.createLazyToolSet(all, lazy.deferredToolsForMode('dev'), new Set()).definitions() : all
    const tools = sent.map((tool) => ({
      name: tool.name,
      chars: JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.input_schema }).length,
    }))
    const sizes: PrefixSizes = { promptChars: DEV_SYSTEM_PROMPT.length, tools }
    process.stdout.write(`${JSON.stringify(sizes)}\n`)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  }
}
