import { detectProject } from '../project.ts'
import { currentAgent } from '../autonomy/context.ts'
import { runShell } from '../shell.ts'
import type { Tool } from './types.ts'

const COMMANDS = ['bun', 'node', 'npm', 'pnpm', 'yarn', 'python3', 'python', 'pip3', 'pytest', 'docker', 'kubectl', 'terraform', 'git', 'gh', 'psql', 'mysql', 'curl']
const SECRET_ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'ELIA_SEARCH_API_KEY', 'ELIA_BROWSER_MCP_SERVER', 'ELIA_BROWSER_BRIDGE_COMMAND', 'ELIA_BROWSER_CDP_URL']

function envPresence(): Record<string, boolean> {
  return Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, Boolean(process.env[name])]))
}

function trimOutput(value: string, limit = 2000): string {
  return value.trim().slice(0, limit)
}

type ReadinessStatus = 'ready' | 'missing-config' | 'unavailable'

interface CapabilityReadiness {
  status: ReadinessStatus
  basis: string
  missing?: string[]
}

function readiness(status: ReadinessStatus, basis: string, missing?: string[]): CapabilityReadiness {
  return missing && missing.length > 0 ? { status, basis, missing } : { status, basis }
}

function capabilityReadiness(availableRuntimes: Record<string, string>, configured: Record<string, boolean>): Record<string, CapabilityReadiness> {
  const browserConfigured = configured.ELIA_BROWSER_MCP_SERVER || configured.ELIA_BROWSER_BRIDGE_COMMAND || configured.ELIA_BROWSER_CDP_URL
  const modelConfigured = configured.ANTHROPIC_API_KEY || configured.OPENAI_API_KEY || configured.GEMINI_API_KEY || configured.NVIDIA_API_KEY
  const deploymentCommands = ['docker', 'kubectl', 'terraform'].filter((command) => availableRuntimes[command] && availableRuntimes[command] !== 'unavailable')
  const missingDataRuntime = ['python3', 'python'].every((command) => !availableRuntimes[command] || availableRuntimes[command] === 'unavailable')

  return {
    llm: modelConfigured
      ? readiness('ready', 'At least one model credential is present in the process environment; authorization and quota were not tested.')
      : readiness('missing-config', 'No supported model credential was detected in the process environment.', ['ANTHROPIC_API_KEY or OPENAI_API_KEY or GEMINI_API_KEY or NVIDIA_API_KEY']),
    browser: browserConfigured
      ? readiness('ready', 'At least one browser transport is configured; reachability, login, permissions, and authorization were not tested.')
      : readiness('missing-config', 'No browser MCP, bridge, or CDP transport is configured.', ['ELIA_BROWSER_MCP_SERVER or ELIA_BROWSER_BRIDGE_COMMAND or ELIA_BROWSER_CDP_URL']),
    sourceControl: availableRuntimes.git && availableRuntimes.git !== 'unavailable'
      ? readiness('ready', 'The git executable is available; repository permissions and remote access were not tested.')
      : readiness('unavailable', 'The git executable is not available.', ['git']),
    dataScience: missingDataRuntime
      ? readiness('unavailable', 'No Python executable was detected for local data-science helpers.', ['python3 or python'])
      : readiness('ready', 'A Python executable is available; packages and dataset-specific dependencies were not tested.'),
    deployment: deploymentCommands.length > 0
      ? readiness('ready', `Detected local deployment command(s): ${deploymentCommands.join(', ')}; credentials, cluster/account access, and mutation authorization were not tested.`)
      : readiness('unavailable', 'No supported local deployment command was detected.', ['docker or kubectl or terraform']),
  }
}

export const environmentTool: Tool = {
  name: 'environment',
  description: 'Inspect the current execution environment without changing it: repository/project shape, branch and dirty state, installed runtimes/CLIs, configured capability presence without exposing secret values, and available browser transport presence. Use this before acting on an unfamiliar or real-world task. It does not test credentials by making external requests and does not claim that a configured tool is authorized or healthy.',
  input_schema: {
    type: 'object',
    properties: {
      includeGitDiffStat: { type: 'boolean', description: 'Include a bounded git diff --stat for local context' },
    },
    required: [],
  },
  async execute(input) {
    const agent = currentAgent()
    const cwd = agent.cwd ?? process.cwd()
    const [project, branch, status, runtimes, diffStat] = await Promise.all([
      Promise.resolve(detectProject(cwd)),
      runShell('git branch --show-current && git log -1 --oneline', 10_000, cwd, agent.signal),
      runShell('git status --porcelain=v1 --branch', 10_000, cwd, agent.signal),
      Promise.resolve(Object.fromEntries(COMMANDS.map((command) => [command, Bun.which(command) ?? 'unavailable']))),
      input.includeGitDiffStat === true ? runShell('git diff --stat', 10_000, cwd, agent.signal) : Promise.resolve(undefined),
    ])
    const availableRuntimes = runtimes
    const configured = envPresence()
    return JSON.stringify({
      cwd,
      project,
      git: {
        branch: trimOutput(branch.stdout.split(/\r?\n/)[0] ?? ''),
        head: trimOutput(branch.stdout.split(/\r?\n/)[1] ?? ''),
        status: trimOutput(status.stdout),
        diffStat: diffStat ? trimOutput(diffStat.stdout) : undefined,
      },
      runtimes: availableRuntimes,
      configuredCapabilityPresence: configured,
      capabilityReadiness: capabilityReadiness(availableRuntimes, configured),
      browser: {
        configured: Boolean(process.env.ELIA_BROWSER_MCP_SERVER || process.env.ELIA_BROWSER_BRIDGE_COMMAND || process.env.ELIA_BROWSER_CDP_URL),
        transports: {
          mcp: Boolean(process.env.ELIA_BROWSER_MCP_SERVER),
          bridge: Boolean(process.env.ELIA_BROWSER_BRIDGE_COMMAND),
          cdp: Boolean(process.env.ELIA_BROWSER_CDP_URL),
        },
        note: 'Presence is not proof of login, permission, reachability, or safe authorization.',
      },
      limitations: ['Environment discovery is a local snapshot and may become stale during a run.', 'Secret values are never returned and credentials are not tested by outbound requests.', 'A binary or environment variable being present does not prove that the current task is authorized to use it.'],
    }, null, 2)
  },
}
