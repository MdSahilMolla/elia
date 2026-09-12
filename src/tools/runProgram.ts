import type { Tool } from './types.ts'
import { DEFAULT_SHELL_TIMEOUT_MS, formatShellResult, runProcess } from '../shell.ts'
import { currentAgent } from '../autonomy/context.ts'
import { commandMayReadSensitiveData } from '../autonomy/sensitivePaths.ts'
import { defaultTimeoutForCommand, resolveRunCwd, workspaceScopedEnv } from './runCommand.ts'

const MAX_ARGUMENTS = 128
const MAX_INPUT_LENGTH = 100_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 600_000

function programText(program: string, args: string[]): string {
  return [program, ...args].join(' ')
}

function hasShellChangeDirectoryArg(args: string[]): boolean {
  return args.some((arg) => /^(?:cd|chdir|pushd|popd)\b/i.test(arg))
}

function parseProgram(input: Record<string, unknown>): { program: string; args: string[] } {
  if (typeof input.program !== 'string' || input.program.trim().length === 0) throw new Error('program must be a non-empty string')
  const program = input.program.trim()
  if (program.length > MAX_INPUT_LENGTH || program.includes('\0')) throw new Error('program contains invalid characters or exceeds the input limit')
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > MAX_ARGUMENTS || input.args.some((arg) => typeof arg !== 'string'))) {
    throw new Error(`args must be an array of at most ${MAX_ARGUMENTS} strings`)
  }
  const args = (input.args as string[] | undefined) ?? []
  if (args.some((arg) => arg.includes('\0')) || program.length + args.reduce((total, arg) => total + arg.length, 0) > MAX_INPUT_LENGTH) {
    throw new Error(`program and args exceed ${MAX_INPUT_LENGTH} characters or contain invalid characters`)
  }
  return { program, args }
}

export const runProgramTool: Tool = {
  name: 'run_program',
  description: `Run one executable with an explicit argument array, without cmd.exe or sh reparsing it. Prefer this for ordinary commands with arguments, paths containing spaces, or nested quoting. Use run_command only when you actually need shell syntax such as a pipeline, redirection, a conditional, or a shell builtin. The working directory never persists; pass cwd explicitly.`,
  input_schema: {
    type: 'object',
    properties: {
      program: { type: 'string', description: 'Executable name or path, for example "bun", "git", or "C:\\Program Files\\tool.exe".' },
      args: { type: 'array', items: { type: 'string' }, description: 'Literal argument values. They are passed directly and never interpreted as shell syntax.' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace. Defaults to the workspace root.' },
      timeoutMs: { type: 'number', description: `Timeout in milliseconds, from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.` },
    },
    required: ['program'],
  },
  async execute(input) {
    const { program, args } = parseProgram(input)
    if (hasShellChangeDirectoryArg(args)) throw new Error('Do not use cd, chdir, pushd, or popd in run_program. These commands change the shell directory; instead, pass cwd as a separate field.')
    if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs < MIN_TIMEOUT_MS || input.timeoutMs > MAX_TIMEOUT_MS)) {
      throw new Error(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
    }
    const command = programText(program, args)
    if (commandMayReadSensitiveData(command)) throw new Error('program arguments would read a protected sensitive path; that disclosure is denied')
    const cwd = resolveRunCwd(typeof input.cwd === 'string' ? input.cwd.trim() : '')
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : defaultTimeoutForCommand(command)
    const result = await runProcess({
      executable: program,
      args,
      timeoutMs,
      cwd,
      signal: currentAgent().signal,
      env: workspaceScopedEnv(cwd),
    })
    return formatShellResult(result)
  },
}
