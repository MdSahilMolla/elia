// A process-wide mutex around file-mutating tool execution.
//
// elia runs tools in parallel — within one turn (the fleet) and, increasingly,
// across concurrent turns. Two `edit_file`/`write_file` calls landing on the
// same file at the same instant would interleave reads and writes and corrupt
// it. Reads and commands stay fully parallel; only the actual mutation is
// serialized, and only for as long as the write takes.
const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'visualize'])

let tail: Promise<unknown> = Promise.resolve()

export function isRepoMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name)
}

/** Runs `fn` once every earlier repo-lock holder has finished. FIFO. */
export function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn)
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
