/**
 * The tools a tree gives its agent, read by running that tree's own registry.
 *
 * Most of what every model call costs is tool definitions — about 80% of a
 * step's fixed input when this was written — so the cheapest "efficiency win"
 * on offer is to hand the agent fewer tools. The benchmark cannot see that as a
 * loss: no coding task calls github or browser. The first proposal made after
 * the proposer was shown where the tokens go was exactly that — keep eleven
 * tools, "without affecting correctness on the current suite". Stated in the
 * brief as unacceptable, and nothing enforced it.
 *
 * So `engine.ts` compares the live tree's tool names with the candidate's
 * before paying for a benchmark, and any tool that disappeared rejects the
 * candidate. Describing a tool in fewer words is still open; owning fewer
 * tools is not.
 *
 * Run as an entry (`bun run src/evolve/toolSurface.ts`) from the tree being
 * measured, it prints one line of JSON. Immutable to the loop (sandbox.ts): a
 * candidate that could edit this could report the live tree's list.
 */

/** Tools the baseline gives its agent that the candidate no longer does. */
export function removedTools(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set(after)
  return [...new Set(before)].filter((name) => !kept.has(name)).sort()
}

if (import.meta.main) {
  try {
    const { allWorkerTools } = await import('../tools/registry.ts')
    process.stdout.write(`${JSON.stringify({ tools: allWorkerTools().map((tool) => tool.name) })}\n`)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  }
}
