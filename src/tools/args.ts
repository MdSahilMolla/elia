/**
 * Argument normalization shared by tools.
 *
 * Models fill an optional field they have nothing for with an empty string —
 * `path: ""`, `cwd: ""`, `topic: ""` — which is the natural reading of "no
 * value". Rejecting that costs an action, and the error names a field the model
 * believed it had left out, so it tends to try again the same way: one run
 * wasted five actions across grep, list_files and board_read on exactly this.
 *
 * There is no optional argument where an empty string means something different
 * from omitting it, so an empty or whitespace-only value is read as absent. A
 * value of the wrong type is still an error — that is a real mistake.
 */
export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string when provided`)
  return value.trim().length === 0 ? undefined : value
}
