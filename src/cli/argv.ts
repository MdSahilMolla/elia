/**
 * The command line, parsed once.
 *
 * `index.ts` used to own all of this alongside every command it dispatches to.
 * Splitting the commands out needs the argument helpers to live somewhere both
 * sides can reach, and they are the natural floor of that dependency graph:
 * pure functions over one array, no imports of elia's own modules, so a command
 * module can depend on this without dragging the REPL in behind it.
 *
 * `args` deliberately excludes the subcommand. `elia bench --harvest` and
 * `elia --harvest` should look identical to `hasFlag`, and making every call
 * site remember to offset by one is how that stops being true.
 */

export const SUBCOMMANDS = [
  'auto', 'agent', 'evolve', 'gap', 'values', 'distill', 'compounding', 'jev',
  'bench', 'bench-latency', 'skills', 'runs', 'sessions', 'fork', 'resume', 'schedule',
  'daemon', 'doctor', 'config', 'codex-login', 'control', 'bridge', 'workspace', 'battmann', 'autopilot',
] as const

export type Subcommand = (typeof SUBCOMMANDS)[number]

export const rawArgs = process.argv.slice(2)

export const subcommand = SUBCOMMANDS.includes(rawArgs[0] as Subcommand) ? (rawArgs[0] as Subcommand) : undefined

export const args = subcommand ? rawArgs.slice(1) : rawArgs

export function hasFlag(...names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg === `${name}=true`))
}

export function flagValue(...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name)
    if (index !== -1) {
      const value = args[index + 1]
      return value === undefined || value.startsWith('--') ? '' : value
    }
    const inline = args.find((arg) => arg.startsWith(`${name}=`))
    if (inline) return inline.slice(name.length + 1)
  }
  return undefined
}

export function strictInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function sessionFlagName(): string | undefined {
  return flagValue('--session')
}

/** Positional arguments, with flags and their values removed. */
export function positionals(valueFlags: string[] = []): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (valueFlags.includes(arg)) {
      i += 1
      continue
    }
    if (valueFlags.some((flag) => arg.startsWith(`${flag}=`))) continue
    if (arg.startsWith('-')) continue
    result.push(arg)
  }
  return result
}
