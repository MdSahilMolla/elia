import { availableParallelism, cpus } from 'node:os'
import { SPECULABLE_TOOLS } from '../speculation/cache.ts'

/** Any batch that mutates the repo or touches the outside world stays on this conservative ceiling. */
export const MAX_PARALLEL_WRITE_TOOLS = 4
/** Hard cap on the read-only pool, whatever the machine or the env override asks for. */
export const MAX_SAFE_PARALLEL_TOOLS = 8

/**
 * Default read-only pool when nothing is configured: one per core, leaving a
 * core for everything else, clamped to [MAX_PARALLEL_WRITE_TOOLS, MAX_SAFE_PARALLEL_TOOLS].
 * A 4-core box keeps the old behaviour; an 8+-core box gets a wider recon fan-out.
 */
function detectCoreCount(): number {
  try {
    return availableParallelism()
  } catch {
    try {
      return cpus().length
    } catch {
      return 4
    }
  }
}
export const DEFAULT_PARALLEL_TOOLS = Math.max(MAX_PARALLEL_WRITE_TOOLS, Math.min(MAX_SAFE_PARALLEL_TOOLS, detectCoreCount() - 1))

/** One tool call's evidence of whether it mutates anything. */
export type ToolBatch = Array<{ name: string; input: Record<string, unknown> }>

/**
 * How many tool calls from one assistant turn may run at once: a read-only
 * batch can safely use a larger pool because they do not compete on file
 * mutations, while any batch containing a write or external side effect stays
 * on the conservative default. The environment override is bounded so a fast
 * setting cannot create an unbounded fan-out against a provider or local
 * machine.
 */
export function toolBatchConcurrency(batch: ToolBatch): number {
  const configured = Number.parseInt(process.env.ELIA_TOOL_CONCURRENCY ?? '', 10)
  const requested = Number.isInteger(configured) && configured > 0 ? Math.min(configured, MAX_SAFE_PARALLEL_TOOLS) : DEFAULT_PARALLEL_TOOLS
  if (batch.length === 0) return requested
  return batch.every(isReadOnlyToolCall) ? requested : Math.min(requested, MAX_PARALLEL_WRITE_TOOLS)
}

function isReadOnlyToolCall(block: { name: string; input: Record<string, unknown> }): boolean {
  if (SPECULABLE_TOOLS.has(block.name)) return true
  if (block.name === 'read_spreadsheet' || block.name === 'web_search' || block.name === 'web_fetch') return true
  if (block.name === 'spreadsheet') return ['inspect', 'analyze', 'audit'].includes(String(block.input.action ?? ''))
  // Browser sessions are shared state: only pure observations may run together.
  // Navigation, scrolling, waits, and verification can race with another page
  // action even when they do not create an external side effect.
  if (block.name === 'browser') return ['status', 'snapshot', 'extract'].includes(String(block.input.action ?? ''))
  if (block.name === 'communication') return ['status', 'inspect', 'list', 'verify'].includes(String(block.input.action ?? ''))
  if (block.name === 'project_profile' || block.name === 'recall' || block.name === 'board_read') return true
  return false
}

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving result order. */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}