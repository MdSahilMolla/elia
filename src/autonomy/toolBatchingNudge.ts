/**
 * A deterministic mid-run correction for a model that reads files one at a time.
 *
 * The single biggest lever on agent wall-clock is the number of model
 * round-trips: every one costs a full request + generation. elia already runs a
 * batch of tool calls in parallel, and the system prompt asks the model to
 * batch — but smaller / faster models (and some larger ones under load) still
 * walk a directory one `read_file` per turn, turning a one-turn job into six.
 *
 * This watches for that exact shape — consecutive turns of a single read-only
 * tool call — and, once it's clearly a pattern, injects one plain reminder. It
 * fires at most once per run of serial reads (the streak resets after), so a
 * model that course-corrects is never nagged again.
 */

const BATCHABLE_READS = new Set(['read_file', 'grep', 'list_files'])

/** True when a turn's tool calls are exactly one batchable read — the shape we want to discourage repeating. */
export function isLoneBatchableRead(toolNames: string[]): boolean {
  return toolNames.length === 1 && BATCHABLE_READS.has(toolNames[0]!)
}

/** Turns to let slide before nudging — enough that it's a habit, not a legitimate dependent read. */
export const SERIAL_READ_NUDGE_THRESHOLD = 3

/**
 * The reminder to inject, or undefined if the streak isn't long enough yet.
 * `streak` is the number of consecutive lone-read turns just observed.
 */
export function serialReadNudge(streak: number): string | undefined {
  if (streak < SERIAL_READ_NUDGE_THRESHOLD) return undefined
  return (
    `[elia] You've issued ${streak} read-only tool calls one per turn. When you need to read or search several things, ` +
    `put every one of those calls in a SINGLE response — elia runs them in parallel, so one batched turn is several ` +
    `times faster than one call per turn. Keep them separate only when a later call genuinely depends on an earlier result.`
  )
}

/**
 * Tracks which files the model has already been shown, so a re-read of an
 * unchanged file can be called out. Weak agent models burn whole round-trips
 * re-reading a file they already have in context (or reading two of six and
 * calling it done); a plain reminder that they already have the content, and
 * should act on it, converges them faster than letting the loop run out.
 */
export interface RedundantReadTracker {
  /**
   * Record a completed batch. Returns the nudge text if this batch re-read
   * files the model was already shown and hasn't written to since, else
   * undefined.
   */
  observe(calls: { name: string; path?: string }[]): string | undefined
}

export function createRedundantReadTracker(): RedundantReadTracker {
  const seen = new Set<string>()

  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

  return {
    observe(calls) {
      const reReads: string[] = []
      for (const call of calls) {
        if (!call.path) continue
        const path = norm(call.path)
        if (call.name === 'read_file') {
          if (seen.has(path)) reReads.push(path)
          seen.add(path)
        } else if (call.name === 'edit_file' || call.name === 'write_file') {
          // The file changed — a later read of it is legitimate again.
          seen.delete(path)
        }
      }
      if (reReads.length === 0) return undefined
      const unique = [...new Set(reReads)]
      return (
        `[elia] You just re-read ${unique.length === 1 ? `${unique[0]}, which you` : `${unique.length} files you`} already ` +
        `read this turn and haven't changed. You already have that content in the conversation — don't re-read files. ` +
        `Use what you have and take the next real step, or give your answer.`
      )
    },
  }
}

/**
 * A nudge for an agent doing substantial multi-step work with no written plan.
 *
 * The system prompt already asks for `todo_write` on anything past a couple of
 * real steps, and every role is allowed the tool — but across four end-to-end
 * runs it was called **zero times in 578 actions**, while one worker made 19
 * tool calls in a single assignment with nothing written down. That is the exact
 * shape the instruction exists to prevent: no externally visible plan, so the
 * model loses track of what it has finished, and neither the user nor the loop
 * can see what it thinks is left.
 *
 * Deliberately not a mandate. A step whose whole job is writing one file should
 * not produce a checklist, and the prompt says so. This fires only once the work
 * is unambiguously multi-step — several actions in, with real changes made — and
 * never again for that agent, whether or not it takes the advice.
 */
const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])

/** Total tool calls before an absent plan is worth mentioning. */
export const PLANLESS_CALL_THRESHOLD = 8

/** Of those, how many must have actually changed something. */
export const PLANLESS_CHANGE_THRESHOLD = 3

export interface PlanlessWorkTracker {
  /** Record a completed batch; returns the nudge text the first time it is warranted. */
  observe(toolNames: string[]): string | undefined
}

export function createPlanlessWorkTracker(): PlanlessWorkTracker {
  let calls = 0
  let changes = 0
  let done = false

  return {
    observe(toolNames) {
      if (done) return undefined
      for (const name of toolNames) {
        // It wrote a plan. Nothing to say, now or later.
        if (name === 'todo_write') {
          done = true
          return undefined
        }
        calls += 1
        if (CHANGING_TOOLS.has(name)) changes += 1
      }
      if (calls < PLANLESS_CALL_THRESHOLD || changes < PLANLESS_CHANGE_THRESHOLD) return undefined
      done = true
      return (
        `[elia] You are ${calls} tool calls into this task and have changed ${changes} thing(s) without writing down a plan. ` +
        `Call todo_write now with the remaining steps, keep exactly one item in_progress, and mark each one completed the ` +
        `moment it is actually done. It keeps you from losing a step, and it is the only way the user can see what you think is left.`
      )
    },
  }
}
