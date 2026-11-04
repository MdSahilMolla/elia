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

/**
 * A model-supplied commit reference. `git show <ref>` reads a leading `-` as an
 * option (`--output=<file>` writes the patch to disk), so the reference must be
 * a plain revision spelling, never an option.
 */
export function validateCommitRef(ref: string): string {
  if (!/^[0-9A-Za-z._/@^~-]{1,200}$/.test(ref) || ref.startsWith('-')) throw new Error(`"${ref}" is not a commit reference`)
  return ref
}

/**
 * The `git show` argv for one commit's patch: the ref is validated, resolved
 * through `rev-parse --verify <ref>^{commit}` by the caller, and passed after
 * `--end-of-options` so it can never be parsed as a flag.
 */
export function gitShowPatchArgs(resolvedCommit: string): string[] {
  return ['show', '--patch', '--end-of-options', resolvedCommit]
}

/** Resolve a validated commit reference to its full object name, or throw. */
export async function resolveCommitRef(cwd: string, ref: string): Promise<string> {
  validateCommitRef(ref)
  const proc = Bun.spawn(['git', 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = (await new Response(proc.stdout).text()).trim()
  await proc.exited.catch(() => undefined)
  if (proc.exitCode !== 0 || !out) throw new Error(`no commit "${ref}" exists in this repository`)
  return out
}
