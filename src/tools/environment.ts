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
      runShell(`for command in ${COMMANDS.join(' ')}; do if command -v "$command" >/dev/null 2>&1; then printf '%s=%s\\n' "$command" "$(command -v "$command")"; else printf '%s=unavailable\\n' "$command"; fi; done`, 10_000, cwd, agent.signal),
      input.includeGitDiffStat === true ? runShell('git diff --stat', 10_000, cwd, agent.signal) : Promise.resolve(undefined),
    ])
    const availableRuntimes = Object.fromEntries(runtimes.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
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
      configuredCapabilityPresence: envPresence(),
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
