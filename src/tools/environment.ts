import { detectProject } from '../project.ts'
import { currentAgent } from '../autonomy/context.ts'
import { runShell } from '../shell.ts'
import { detectGitHubContext } from '../github/context.ts'
import { assessEnvironment } from '../autonomy/envReadiness.ts'
import { reliabilitySignal } from '../autonomy/reliability.ts'
import type { Tool } from './types.ts'

const COMMANDS = ['bun', 'node', 'npm', 'pnpm', 'yarn', 'python3', 'python', 'pip3', 'pytest', 'docker', 'kubectl', 'terraform', 'vercel', 'netlify', 'git', 'gh', 'psql', 'mysql', 'curl']
import { browserMcpReadiness } from '../mcp/browserRegistry.ts'
import { useOwnedBrowserByDefault } from './browserOwned.ts'
// Derived rather than hardcoded so a newly added provider preset (which keeps
// its API-key env name in PROVIDER_PRESETS) shows up here automatically instead
// of staying invisible to the readiness report until someone edits it by hand.
import { PROVIDER_PRESET_NAMES, providerPresetApiKeyEnv } from '../providers/registry.ts'

const PROVIDER_API_KEY_NAMES = PROVIDER_PRESET_NAMES.map(providerPresetApiKeyEnv).filter((name): name is string => Boolean(name))

const SECRET_ENV_NAMES = [...new Set([
  ...PROVIDER_API_KEY_NAMES,
  'ELIA_API_KEY',
  'EXA_API_KEY', 'SERPER_API_KEY', 'ELIA_SEARCH_API_KEY',
  'ELIA_BROWSER_MCP_SERVER', 'ELIA_BROWSER_BRIDGE_COMMAND', 'ELIA_BROWSER_CDP_URL',
  'VERCEL_TOKEN', 'NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID',
])]

/**
 * `env` without elia's own credentials: provider keys, search keys and deploy
 * tokens. For running code elia did not write (a project's own checks), which
 * has no business with them.
 */
export function withoutEliaSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const secret = new Set(SECRET_ENV_NAMES)
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !secret.has(entry[0])))
}

function envPresence(): Record<string, boolean> {
  return Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, Boolean(process.env[name])]))
}

function trimOutput(value: string, limit = 2000): string {
  return value.trim().slice(0, limit)
}

/** A `--version` that has not answered in this long is not going to; don't let it hang the readiness report. */
const VERSION_TIMEOUT_MS = 5_000

/**
 * `<cmd> --version` output, empty string when the command is absent, errors, or hangs.
 *
 * Async, and awaited in parallel with the rest of discovery. It used to be
 * `spawnSync`: each probe blocked the event loop for up to the full timeout, and
 * they ran one after another. On Windows that is not theoretical — `python3`
 * resolves to the Store app-execution alias, which hangs until it is killed — so
 * environment discovery routinely took ~20s and its own test timed out at 5s.
 */
export async function versionOf(command: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<string> {
  try {
    const proc = Bun.spawn([command, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    // A timeout kills the process with `killSignal`; the async Subprocess
    // reports that as a signal rather than a flag. Any signalled exit means the
    // output is partial at best, so it is not a version string.
    if (proc.signalCode) return ''
    return stdout.trim() || stderr.trim()
  } catch {
    return ''
  }
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

function capabilityReadiness(
  availableRuntimes: Record<string, string>,
  configured: Record<string, boolean>,
  github?: { ghInstalled: boolean; ghAuthenticated: boolean; hasRemote: boolean },
): Record<string, CapabilityReadiness> {
  const connectedBrowserMcp = browserMcpReadiness().tools.length > 0
  const browserConfigured = connectedBrowserMcp || configured.ELIA_BROWSER_MCP_SERVER || configured.ELIA_BROWSER_BRIDGE_COMMAND || configured.ELIA_BROWSER_CDP_URL
  const modelConfigured = PROVIDER_API_KEY_NAMES.some((name) => configured[name]) || configured.ELIA_API_KEY
  const deploymentCommands = ['vercel', 'netlify', 'docker', 'kubectl', 'terraform'].filter((command) => availableRuntimes[command] && availableRuntimes[command] !== 'unavailable')
  const missingDataRuntime = ['python3', 'python'].every((command) => !availableRuntimes[command] || availableRuntimes[command] === 'unavailable')

  return {
    llm: modelConfigured
      ? readiness('ready', 'At least one model credential is present in the process environment; authorization and quota were not tested.')
      : readiness('missing-config', 'No supported model credential was detected in the process environment.', [`${PROVIDER_API_KEY_NAMES.concat('ELIA_API_KEY').join(' or ')}`]),
    // With no bridge configured, `browser` now falls back to elia's own headless
    // browser. Reporting that as missing-config would tell the agent it has no
    // browser when it does, and the agent reads this before deciding what to try.
    browser: browserConfigured
      ? readiness('ready', 'At least one browser transport is configured; reachability, login, permissions, and authorization were not tested.')
      : useOwnedBrowserByDefault()
        ? readiness('ready', "No browser bridge is configured, so elia's own headless browser will be used. It has no login state: it cannot see anything behind the user's own signed-in sessions.")
        : readiness('missing-config', 'No browser MCP, bridge, or CDP transport is configured, and the built-in headless browser is unavailable (turned off, or no Chromium-family browser installed).', ['ELIA_BROWSER_MCP_SERVER or ELIA_BROWSER_BRIDGE_COMMAND or ELIA_BROWSER_CDP_URL, or install Chrome/Edge/Brave/Chromium']),
    sourceControl: availableRuntimes.git && availableRuntimes.git !== 'unavailable'
      ? readiness('ready', 'The git executable is available; repository permissions and remote access were not tested.')
      : readiness('unavailable', 'The git executable is not available.', ['git']),
    github: !github || !github.hasRemote
      ? readiness('unavailable', 'No GitHub remote is configured for this repository.', ['git remote add origin <github-url>'])
      : !github.ghInstalled
        ? readiness('missing-config', 'A GitHub remote exists but the gh CLI is not installed.', ['gh'])
        : !github.ghAuthenticated
          ? readiness('missing-config', 'The gh CLI is installed but not authenticated.', ['gh auth login'])
          : readiness('ready', 'A GitHub remote is set and gh is authenticated; push and PR permission on the repo were not tested.'),
    dataScience: missingDataRuntime
      ? readiness('unavailable', 'No Python executable was detected for local data-science helpers.', ['python3 or python'])
      : readiness('ready', 'A Python executable is available; packages and dataset-specific dependencies were not tested.'),
        deployment: deploymentCommands.length > 0
      ? readiness('ready', `Detected local deployment command(s): ${deploymentCommands.join(', ')}; credentials, project/site access, and mutation authorization were not tested.`)
      : readiness('unavailable', 'No supported local deployment command was detected.', ['vercel or netlify or docker or kubectl or terraform']),

  }
}

export const environmentTool: Tool = {
  name: 'environment',
  description: 'Inspect the current execution environment without changing it: repository/project shape, branch and dirty state, installed runtimes/CLIs, GitHub remote and whether the gh CLI is logged in, configured capability presence without exposing secret values, available browser transport presence, an `environmentReadiness` assessment of what the project declares it needs (lockfiles, version pins, compose services, devcontainer, nix) versus what this machine has — with suggested setup commands — and a `projectTrackRecord` of whether past autonomous runs here tended to over-claim completion. Use this before acting on an unfamiliar or real-world task. Apart from checking gh login state, it does not test credentials by making external requests, and it never claims a configured tool is authorized for the repo at hand.',
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
    const [project, branch, status, runtimes, diffStat, github] = await Promise.all([
      Promise.resolve(detectProject(cwd)),
      runShell('git branch --show-current && git log -1 --oneline', 10_000, cwd, agent.signal),
      runShell('git status --porcelain=v1 --branch', 10_000, cwd, agent.signal),
      Promise.resolve(Object.fromEntries(COMMANDS.map((command) => [command, Bun.which(command) ?? 'unavailable']))),
      input.includeGitDiffStat === true ? runShell('git diff --stat', 10_000, cwd, agent.signal) : Promise.resolve(undefined),
      detectGitHubContext(cwd, { signal: agent.signal }).catch(() => undefined),
    ])
    const availableRuntimes = runtimes
    const configured = envPresence()
    const present = (command: string): boolean => Boolean(availableRuntimes[command] && availableRuntimes[command] !== 'unavailable')
    // Both probes at once rather than one after the other: a hung `python3`
    // should not add its whole timeout to what `node` already cost.
    const [nodeVersion, pythonVersion] = await Promise.all([
      present('node') ? versionOf('node') : Promise.resolve(''),
      present('python3') ? versionOf('python3') : Promise.resolve(''),
    ])
    // Declared-vs-available: what the project expects that this machine does not
    // have, so the orient phase catches a broken environment before the run
    // spends its budget discovering it.
    const readiness = assessEnvironment({
      cwd,
      has: present,
      versions: { node: nodeVersion, python3: pythonVersion },
    })
    // The project's own track record: do past autonomous runs here tend to
    // claim more than the facts support? Feeds the acceptance contract the
    // orient phase writes for this run.
    const trackRecord = reliabilitySignal(cwd)
    return JSON.stringify({
      cwd,
      project,
      environmentReadiness: readiness,
      projectTrackRecord: trackRecord,
      git: {
        branch: trimOutput(branch.stdout.split(/\r?\n/)[0] ?? ''),
        head: trimOutput(branch.stdout.split(/\r?\n/)[1] ?? ''),
        status: trimOutput(status.stdout),
        diffStat: diffStat ? trimOutput(diffStat.stdout) : undefined,
      },
      github: github
        ? {
            repo: github.slug,
            defaultBranch: github.defaultBranch,
            currentBranch: github.currentBranch,
            ahead: github.ahead,
            behind: github.behind,
            aheadBehindUnknown: github.aheadBehindUnknown ?? false,
            dirty: github.dirty,
            ghInstalled: github.ghInstalled,
            ghAuthenticated: github.ghAuthenticated,
            ghAuthUnknown: github.ghAuthUnknown ?? false,
            openPr: github.openPr ? { number: github.openPr.number, title: github.openPr.title, url: github.openPr.url } : undefined,
            autonomousReady: github.isRepo && github.hasRemote && github.ghInstalled && github.ghAuthenticated,
            note: 'ghAuthenticated means a token is present; repo push/PR permission was not tested. ghAuthUnknown/aheadBehindUnknown true means gh/git output did not match any recognized pattern, so the corresponding field above is an unconfirmed default (false/0), not a verified result.',
          }
        : undefined,
      runtimes: availableRuntimes,
      configuredCapabilityPresence: configured,
      capabilityReadiness: capabilityReadiness(availableRuntimes, configured, github),
      browser: {
        configured: Boolean(browserMcpReadiness().tools.length || process.env.ELIA_BROWSER_MCP_SERVER || process.env.ELIA_BROWSER_BRIDGE_COMMAND || process.env.ELIA_BROWSER_CDP_URL),
        transports: {
          mcp: Boolean(browserMcpReadiness().tools.length || process.env.ELIA_BROWSER_MCP_SERVER),
          bridge: Boolean(process.env.ELIA_BROWSER_BRIDGE_COMMAND),
          cdp: Boolean(process.env.ELIA_BROWSER_CDP_URL),
        },
        note: 'Presence is not proof of login, permission, reachability, or safe authorization.',
      },
      limitations: ['Environment discovery is a local snapshot and may become stale during a run.', 'Secret values are never returned and credentials are not tested by outbound requests.', 'A binary or environment variable being present does not prove that the current task is authorized to use it.'],
    }, null, 2)
  },
}
