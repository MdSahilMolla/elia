/**
 * A compact preview of what an about-to-be-approved action would do, so the
 * approval card carries the actual change instead of just its name. Diff-style
 * (`-` / `+`) lines are colored by the Confirm component; other lines render
 * muted.
 */
export function approvalPreviewLines(name: string, input: Record<string, unknown>): string[] | undefined {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')

  if (name === 'edit_file') {
    const path = str(input.path)
    const before = str(input.old_string)
    const after = str(input.new_string)
    if (!before && !after) return undefined
    return [
      ...(path ? [`  ${path}`] : []),
      ...(input.replace_all === true ? ['  (every occurrence)'] : []),
      ...before.split('\n').map((line) => `- ${line}`),
      ...after.split('\n').map((line) => `+ ${line}`),
    ]
  }

  if (name === 'write_file') {
    const path = str(input.path)
    const lines = str(input.content).split('\n')
    return [
      ...(path ? [`  ${path}  (${lines.length} line${lines.length === 1 ? '' : 's'})`] : []),
      ...lines.slice(0, 30).map((line) => `+ ${line}`),
    ]
  }

  if (name === 'run_command') {
    const command = str(input.command)
    if (!command) return undefined
    return [`  $ ${command}`, ...(str(input.cwd) ? [`  in ${str(input.cwd)}`] : [])]
  }

  return undefined
}
