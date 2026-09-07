import type { Tool } from './types.ts'
import { currentAgent } from '../autonomy/context.ts'
import { runShell, formatShellResult } from '../shell.ts'
import { assessEnvironment, type EnvironmentAssessment } from '../autonomy/envReadiness.ts'

/**
 * Provision the dev environment a task needs — install dependencies, create a
 * venv, bring up compose services, run a Makefile setup target — as one
 * governed step instead of a scatter of `run_command` approvals.
 *
 * It only runs commands that match a strict allowlist of known setup shapes.
 * Anything else is refused with a pointer to `run_command`, so this can't become
 * a way around the command governor. Each command is a single invocation (no
 * `;`, `|`, redirects, substitution); a `&&` chain is split and every part must
 * pass the allowlist on its own.
 *
 * With no `commands` argument it provisions exactly what `assessEnvironment`
 * recommends for the current project.
 */

const ALLOWLIST: RegExp[] = [
  /^(?:bun|npm|pnpm|yarn) (?:install|ci)$/,
  /^pnpm install --frozen-lockfile$/,
  /^yarn install --immutable$/,
  /^npm install --no-audit --no-fund$/,
  /^poetry install$/,
  /^uv sync$/,
  /^pipenv install(?: --dev)?$/,
  /^pip install -r [\w./-]+$/,
  /^python3? -m venv [\w./-]+$/,
  /^\.venv\/bin\/pip install -r [\w./-]+$/,
  /^bundle install$/,
  /^go mod (?:download|tidy)$/,
  /^cargo fetch$/,
  /^docker(?:-| )compose up -d$/,
  /^make [\w-]{1,40}$/,
]

// Forbids `;`, `|`, backtick, redirects, `$(...)`, `||`, and a lone `&`
// (background) — but allows `&&`, which planSteps splits on.
const FORBIDDEN_SHELL = /[;|`><]|\$\(|\|\||(?<!&)&(?!&)/

const MAX_COMMANDS = 6
const PROVISION_TIMEOUT_MS = 300_000

interface Step {
  command: string
  parts: string[]
}

function planSteps(raw: string[]): { steps: Step[]; rejected: { command: string; reason: string }[] } {
  const steps: Step[] = []
  const rejected: { command: string; reason: string }[] = []
  for (const original of raw.slice(0, MAX_COMMANDS)) {
    const command = original.trim()
    if (!command) continue
    if (FORBIDDEN_SHELL.test(command)) {
      rejected.push({ command, reason: 'contains shell control syntax — run it through run_command instead' })
      continue
    }
    const parts = command.split(/\s*&&\s*/).map((p) => p.trim())
    const bad = parts.find((p) => !ALLOWLIST.some((re) => re.test(p)))
    if (bad) {
      rejected.push({ command, reason: `"${bad}" is not a recognised setup command — run it through run_command instead` })
      continue
    }
    steps.push({ command, parts })
  }
  return { steps, rejected }
}

function summariseRemaining(before: EnvironmentAssessment, after: EnvironmentAssessment): string {
  if (after.ready && !before.ready) return 'Environment is now ready — all blockers cleared.'
  if (after.blockers.length === 0) return 'No blockers remain.'
  return `Still blocked:\n${after.blockers.map((b) => `  - ${b.what}${b.fix ? ` [${b.fix}]` : ''}`).join('\n')}`
}

export const provisionEnvironmentTool: Tool = {
  name: 'provision_environment',
  description:
    "Set up the dev environment for this project — install dependencies, create a venv, bring up docker-compose services, run a Makefile setup target — in one governed step. With no arguments it runs exactly what the environment tool's `environmentReadiness.setup` recommends. Only known setup commands are allowed; use run_command for anything else. Run this in the orient/setup phase when `environmentReadiness` reports blockers, so the rest of the run isn't spent failing on a missing toolchain or an uninstalled dependency.",
  input_schema: {
    type: 'object',
    properties: {
      commands: {
        type: 'array',
        items: { type: 'string' },
        description: 'Setup commands to run in order. Omit to use the recommendations from environmentReadiness.',
      },
      cwd: { type: 'string', description: 'Project directory (absolute or workspace-relative). Defaults to the run cwd.' },
    },
    required: [],
  },
  async execute(input) {
    const agent = currentAgent()
    const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : agent.cwd ?? process.cwd()

    const has = (command: string): boolean => Boolean(Bun.which(command))
    const before = assessEnvironment({ cwd, has, versions: {} })

    const requested = Array.isArray(input.commands)
      ? input.commands.filter((c): c is string => typeof c === 'string')
      : before.setup
    if (requested.length === 0) {
      return before.ready
        ? 'Nothing to provision — the project declares nothing this machine is missing.'
        : `No runnable setup command for the current blockers:\n${before.blockers.map((b) => `  - ${b.what}`).join('\n')}\nResolve these manually (a toolchain install, credentials) and re-check with the environment tool.`
    }

    const { steps, rejected } = planSteps(requested)
    const log: string[] = []
    for (const { command } of rejected) log.push(`SKIPPED  ${command} — ${rejected.find((r) => r.command === command)?.reason}`)

    let failed = false
    for (const step of steps) {
      if (agent.signal?.aborted) {
        log.push('ABORTED  (run cancelled)')
        break
      }
      for (const part of step.parts) {
        const result = await runShell(part, PROVISION_TIMEOUT_MS, cwd, agent.signal)
        if (result.exitCode === 0) {
          log.push(`OK       ${part}`)
        } else {
          log.push(`FAILED   ${part} (exit ${result.exitCode})`)
          log.push(formatShellResult(result).split('\n').slice(0, 12).map((l) => `         ${l}`).join('\n'))
          failed = true
          break
        }
      }
      if (failed) break
    }

    const after = assessEnvironment({ cwd, has, versions: {} })
    return [
      failed ? 'provision_environment: a setup command failed.' : 'provision_environment: done.',
      ...log,
      '',
      summariseRemaining(before, after),
    ].join('\n')
  },
}
