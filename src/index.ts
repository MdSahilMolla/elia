#!/usr/bin/env bun
import * as readline from 'node:readline/promises'
import * as pathModule from 'node:path'
import type { ConversationMessage, AgentMode } from './agent.ts'
import { writeNotice, writeError, writeUsageLine } from './ui/stream.ts'
import { sessionTranscript } from './ui/transcript.ts'
import { colorizeDiffBlock } from './ui/render.ts'
import { approvalPreviewLines } from './ui/approvalPreview.ts'
import { lastAssistantText, type ToolEvent } from './agentLoop.ts'
import type { ProviderActivity } from './providers/types.ts'
import type { SlashOutcome as InkSlashOutcome } from './ui/app/index.tsx'
import type { PackageKind } from './marketplace/registry.ts'

interface TurnUiHooks {
  onText?: (delta: string) => void
  onThinking?: (delta: string) => void
  onActivity?: (activity: ProviderActivity) => void
  onTool?: (event: ToolEvent) => void
  onToolStart?: (call: { id: string; name: string; input: Record<string, unknown> }) => void
  /** External cancellation (the Ink app's Esc handler). */
  signal?: AbortSignal
  /** Read-only "propose a plan first" turn. */
  planMode?: boolean
  /** Mid-run steering: drained at each step boundary and spliced into the turn. */
  drainSteering?: () => string[]
}
import { playIntro } from './ui/character.ts'
import { ZERO_USAGE, getSessionSummaryLine, recordTopLevelTurn, formatUsageLine } from './usage.ts'
import { createSlashPrompt, type SlashCommand } from './ui/slashPrompt.ts'
import { confirmOnce } from './ui/confirm.ts'
import { gold, dim } from './ui/theme.ts'
import { box, table } from './ui/layout.ts'
import { pick } from './ui/picker.ts'
import { openTaskDashboard, renderTaskSummary, updateTerminalTaskTitle } from './ui/taskDashboard.ts'
import { inferTaskKind, taskSessions } from './taskSessions.ts'
import { isAgentPersona, type AgentPersona } from './agents/types.ts'
import { CAPABILITIES } from './capabilities.ts'
import { MAX_GOVERNED_ACTIONS, type ActionApproval, type ActionAssessment, type ActionRequest } from './autonomy/governor.ts'
import { emitEvent, interactiveTerminal, machineReadable, plainOutput, quietOutput } from './ui/runtime.ts'
import { renderWorkspacePanel } from './ui/workspacePanel.ts'
import { installShutdownHandlers, registerShutdownCleanup } from './ui/shutdown.ts'
import { redactText } from './ui/redact.ts'
import { loadUserConfig, userConfigPath, writeUserConfig } from './userConfig.ts'
import { activeProviderNeedsSetup, removeProviderConfiguration, savedProviderNames, saveProviderConfiguration, type SavedProviderConfiguration } from './providerSettings.ts'

const REPL_COMMANDS: SlashCommand[] = [
  { name: '/capabilities', description: 'list specialist capabilities, risk classes, and output contracts' },
  { name: '/mode', description: 'pick a mode/persona with arrow keys, or /mode dev, /mode cyber, /mode sports, /mode fitness, /mode battmann, /mode marketing, ...' },
  { name: '/rewind', description: 'list rewind points (add a number to restore one, e.g. /rewind 2)' },
  { name: '/model', description: 'pick a model with arrow keys, or /model groq, /model claude-opus-5' },
  { name: '/thinking', description: 'pick reasoning effort with arrow keys, or /thinking off/low/medium/high/<n>' },
  { name: '/task', description: 'browse browser, coding, and pending tasks with arrow keys' },
  { name: '/sessions', description: 'see every other elia session running in this project — what each is doing, its model, and its session id to resume it' },
  { name: '/artifact', description: 'browse saved plan artifacts with arrow keys and search, or /artifact <name> to view one directly' },
  { name: '/settings', description: 'browse every setting — model, reasoning effort, risk checks, skills — and switch with arrow keys' },
  { name: '/expand', description: 'reprint the last tool result in full (or /expand <n> for the nth), undoing scrollback folding' },
  { name: '/why', description: 'show recorded rationale for a file or topic — the decisions and constraints behind it (/why src/foo.ts)' },
  { name: '/lessons', description: 'show what earlier sessions learned about this project' },
  { name: '/brain', description: "elia's cross-session project memory — /brain to see what's stored, /brain <query> to search it, /brain consolidate to tidy it" },
  { name: '/verify', description: 'run the project checks now, or /verify on|off to toggle the automatic post-turn check' },
  { name: '/track', description: "elia's track record on this project — how many changes landed clean, by area, and where it's weakest" },
  { name: '/skills', description: 'list the loaded skills (learned tools) available this session' },
  { name: '/marketplace', description: 'per source (npm, pip, skills, mcp, connector): what is installed, a suggested shortlist, and search/add' },
  { name: '/packages', description: 'everything installed for this project — packages and skills — select one to remove it' },
  { name: '/mcp', description: 'connected MCP servers and their tools — add one from the catalog, reload, enable/disable, or remove' },
  { name: '/connector', description: 'hosted MCP connectors (Notion, Linear, Sentry, GitHub, …) — add by URL, test the connection, enable/disable, remove' },
  { name: '/status', description: 'show the workspace panel — session, other chats, plan, subagents, artifacts' },
  { name: '/team', description: 'show deep/fast model tiers and per-role routes used by parallel workers' },
  { name: '/cost', description: 'show the session token and estimated-dollar breakdown' },
  { name: '/export', description: 'write the whole conversation to Markdown (/export <path> to choose the file)' },
  { name: '@skills', description: 'browse loaded skills and choose which skill tools are active for the next turn' },
]

const rawArgs = process.argv.slice(2)

function requestedAgentMode(): AgentMode {
  return hasFlag('--cyber') ? 'cyber' : hasFlag('--sports') ? 'sports' : hasFlag('--fitness') ? 'fitness' : hasFlag('--battmann') ? 'battmann' : 'dev'
}

const SUBCOMMANDS = ['auto', 'agent', 'evolve', 'bench', 'skills', 'runs', 'fork', 'resume', 'schedule', 'daemon', 'config', 'codex-login', 'control', 'bridge'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

function printHelp(): void {
  console.log(`elia — a general-purpose autonomous agent for your terminal

Usage:
  elia                        Start an interactive session
  elia "<prompt>"             Run a single prompt and exit
  elia --continue, -c         Resume the most recent session in this directory
  elia --resume <id>          Resume a specific session by id

Dev mode (default): elia is the general-purpose development mode for building,
debugging, testing, refactoring, and operating software.

Execution policy (manual by default): before running a command, elia checks whether it looks
risky (deletes, sends, spending, publishing, system changes, ...) — only
risky commands get an "About to: ... run it?" prompt, safe ones just run.
Once a command starts, safe and reversible work finishes end to end without
interruptions; irreversible tool actions are separately governed. Pass --yolo/-y
(or pick "Risk checks" in "/settings" during a session) to skip the pre-flight
risk prompt while keeping that action governor active.

Autonomous work:
  elia auto "<goal>"                Plan the work, show you the plan, then execute it with a
                                     fleet of sub-agents, verify it, repair what failed, and
                                     record what it learned
  elia auto "<goal>" --yolo         Same, without waiting for you to approve the plan
  elia auto "<goal>" --autonomous   Self-supervised alias for --yolo; executes, verifies, repairs, and polishes
  elia auto "<goal>" --unattended   Run safe, bounded work without routine prompts; critical actions still block
  elia auto "<goal>" --no-polish     Skip the bounded final quality pass
  elia auto "<goal>" --fast          Bounded fast path: no polish, one reviewer, one repair, no lesson pass
  elia auto "<goal>" --thorough      Extra bounded review and repair depth for high-risk changes
  elia auto "<goal>" --max-run-ms N  Abort the run after N milliseconds (also ELIA_MAX_RUN_MS)
  elia auto "<goal>" --max-actions N  Bound governed tool requests for this run
  elia auto "<goal>" --variants N   Run N independent implementation attempts in parallel,
                                     each in its own isolated git worktree, and keep only
                                     the one that verification — not an LLM's opinion — likes
                                     best. Costs roughly Nx the execute phase; default is 1
                                     (today's single-attempt behavior, unchanged)

Multi-agent:
  elia agent "<request>"      Route the request to one or more specialist personas — Business,
                              Data, Research, Cybersecurity, Automation, Communications, AI/ML,
                              Sports, Fitness, Marketing, Finance, or Tech — and answer in their voice. Multi-domain
                              requests get labeled "## X take" sections plus a combined recommendation.
  elia agent "<request>" --dry-run  Show routing/persona plan without executing tools or side effects

Office workflows:
  Agent/autonomous requests can use spreadsheet to inspect, analyze, audit, or safely write
  Excel workbooks; presentation creates an editable management .pptx plus analysis sidecar.

Self-improvement:
  elia bench                  Score the current elia against its own benchmark suite
  elia evolve                 Improve elia's own source: hypothesise one change, build it
                              in a sandbox, and promote it only if the benchmark agrees
  elia evolve -n 3            Run three generations, each building on the last
  elia evolve --dry-run       Evaluate candidates but never modify the live source

Learned tools:
  elia skills                 List the tools elia has written for itself
  elia skills bundles         List declarative groups of loaded skills
  elia skills candidates      Show repeated work that could become a new tool
  elia skills synth           Write a tool for the strongest candidate

Time travel:
  elia runs                   List autonomous runs
  elia runs <id>              Show one run's timeline and its forkable decision points
  elia fork <id> --at <n> --with "<change>"
                              Replay that run up to checkpoint <n> and re-plan from there
  elia resume <id>            Continue a durable goal from its persisted graph and approvals

Background autonomy:
  elia schedule add --every 1h [--mode battmann] [--max-actions N] "<goal>"  Persist a recurring goal for the local daemon
  elia schedule list                       Show scheduled goals and last outcomes
  elia schedule pause|resume|remove <id>  Control a scheduled goal
  elia schedule run <id>                   Run one scheduled goal immediately
  elia daemon --once                       Run due schedules once and exit
  elia daemon --poll-ms 30000             Keep checking due schedules in the foreground

Editor / external integration:
  elia bridge                              Start the local JSONL-over-stdio bridge (used by the Elia VS Code extension)
  elia bridge --http [--port 4319] [--host 127.0.0.1]  Same bridge protocol over WebSocket instead of stdio,
                                            for any external client — SDKs, other editors. Binds to
                                            localhost only unless --host is set explicitly.

Provider setup:
  First interactive run                    Ask for provider, hidden API key, and model
  elia config                               Show provider readiness without printing keys
  elia config set --provider nvidia        Store a provider API key in ~/.elia/config.env
  elia config set --provider custom --base-url <url>
                                           Configure any OpenAI-compatible endpoint
  elia config remove --provider <name>     Remove that provider's saved API key
  elia codex-login                         Sign in to the installed Codex CLI with ChatGPT
  Use --api-key-env <NAME> or pipe a key with --api-key-stdin; never pass keys as arguments.
  In a session, /settings → Provider API keys adds, updates, selects, or removes profiles.

Supervisor controls:
  elia control status                       Show durable runs and pending operator controls
  elia control pause <run-id>               Request a safe pause of an active autonomous run
  elia control stop <run-id>                Request a safe stop of an active autonomous run
  elia resume <run-id>                      Resume only after reviewing the stopped run receipt
  --supervised                             Require an interactive approval boundary for auto work

Inside an interactive session:
  /                            Type "/" to see available commands — up/down to highlight,
                              tab to accept, enter to run, left/right to edit as usual
  rewind                      List rewind points for this session
  rewind <n>                  Restore conversation + files to just before turn <n>
  /capabilities               List specialist capabilities, risk classes, and output contracts
  /mode                       Pick a mode/persona with arrow keys: dev, cyber, sports, fitness, battmann,
                              marketing, finance, business, data, research, cybersecurity,
                              automation, communications, ai, production
  /mode <name>                Switch directly, e.g. /mode cyber, /mode dev ("tech" is an alias for dev)
  /settings                   Risk checks (auto/manual), model, reasoning effort, and skills
  /model                      Pick a provider/model or enable auto fallback
  /model auto                 Keep the selected model primary; fail over to another ready provider
  /model <provider>           Switch provider (e.g. /model groq), keeping its default model
  /model <model-id>           Switch just the model id, keeping the current provider
  /thinking                   Pick a reasoning effort with up/down or left/right, enter to switch
  /thinking off|on            Turn reasoning off, or back on at its last budget
  /thinking low|medium|high   Switch reasoning effort to a preset token budget
  /thinking <n>               Switch reasoning to an exact token budget (Anthropic only)

  Other:
  elia --dev                  Start explicitly in dev mode (the default)
  elia --sports               Start (or run a one-shot prompt) in Sports mode
  elia --fitness              Start (or run a one-shot prompt) in Fitness mode
  elia --battmann             Start (or run a one-shot prompt) in Battmann mode — strategic
                              intelligence across trade, geopolitics, financial markets,
                              supply chain, policy, and commodities
  elia --cyber                Start (or run a one-shot prompt) in cyber mode
  elia --json                 Emit stable JSONL lifecycle events for automation
  elia --plain                Disable color, animation, and in-place terminal redraws
  elia --quiet                Print the final answer and essential failures only; keep TTY editing
  elia --verbose              Include detailed progress output
  ELIA_MAX_RUN_MS             Default wall-clock budget for autonomous runs; --max-run-ms overrides it
  --max-actions <n>            Bound governed tool requests for one autonomous run
  ELIA_TOOL_CONCURRENCY       Read-only tool batches can use up to 8; mutating batches stay capped at 4
  elia --help                 Show this help
  elia --version              Print the version

  UI output: --json/--jsonl emits machine-readable JSONL events; --plain disables color and redraws;
  --quiet minimizes progress; --verbose includes additional progress detail. Errors go to stderr
  in human modes. Sessions auto-save to .elia/sessions/. Configure a provider with elia config set
  or via .env — see .env.example.

  Diagnostics: --profile-turns (or ELIA_PROFILE=1) records every model call's
  cache-read/write split and time-to-first-token and prints a table at the end —
  use it to see how well the prompt cache is holding across a session.

Set ELIA_FAST_PROVIDER/ELIA_FAST_MODEL to give elia a cheap fast tier for recon work; it
routes investigation there and keeps the strong model for planning, building, and review.`)
}

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  printHelp()
  process.exit(0)
}

if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  const pkg = JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text())
  console.log(pkg.version)
  process.exit(0)
}

const subcommand = SUBCOMMANDS.includes(rawArgs[0] as Subcommand) ? (rawArgs[0] as Subcommand) : undefined
const args = subcommand ? rawArgs.slice(1) : rawArgs

function hasFlag(...names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg === `${name}=true`))
}

// `--profile-turns` is a session-wide diagnostic: every model round-trip records
// its cache-read/write split and time-to-first-token, and a table prints at the
// end. Distinct from `elia auto --profile <fast|balanced|thorough>`, which
// selects a run profile. `ELIA_PROFILE=1` in the environment does the same.
if (hasFlag('--profile-turns')) process.env.ELIA_PROFILE = '1'

/**
 * Running elia from a filesystem root (`C:\`, `D:\`, `/`) is pathological: the
 * scratch `workspace/` resolves to `C:\workspace`, recursive searches descend
 * into `System Volume Information` / `$RECYCLE.BIN` and fail, and the model has
 * no project to orient against. Warn loudly rather than let a whole session go
 * sideways.
 */
function warnIfAtFilesystemRoot(): void {
  const cwd = process.cwd()
  const { root } = pathModule.parse(cwd)
  if (cwd === root || cwd === root.replace(/[\\/]$/, '')) {
    writeError(
      `elia is running at a filesystem root (${cwd}). This works badly — the workspace folder, searches, and project detection all assume a project directory. cd into an actual project first.`,
    )
  }
}

async function printTurnProfileReport(): Promise<void> {
  const { renderProfileReport } = await import('./profile.ts')
  const report = renderProfileReport()
  if (report && !machineReadable) process.stdout.write(`\n${dim(report)}\n`)
}


function flagValue(...names: string[]): string | undefined {
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

function strictInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Positional arguments, with flags and their values removed. */
function positionals(valueFlags: string[] = []): string[] {
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

function userMessage(text: string): ConversationMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

async function classifyCommandRisk(command: string): Promise<{ risky: boolean; reason?: string }> {
  // Codex is an autonomous workspace-writing agent, not an Elia tool-calling
  // model — every prompt hands the whole task to it. That hand-off is always
  // worth an explicit confirmation, so flag it risky rather than skipping the
  // check. (The Ink REPL confirms this directly; this covers the classic path.)
  const { config } = await import('./config.ts')
  if (config.providerName === 'codex') {
    return { risky: true, reason: `${config.model} (Codex) will run this task autonomously in your workspace — it can read, edit, and run commands.` }
  }
  const { classifyRisk } = await import('./autonomy/risk.ts')
  return classifyRisk(command)
}

/** The plan-approval gate for `elia auto`/`elia fork` — thin wrapper over the shared confirmOnce helper. */
function createInteractiveApprover(rl: readline.Interface) {
  return () => confirmOnce(rl, 'Approve this plan? [y]es / [n]o / [e]dit <what to change>: ')
}

function actionApprovalPrompt(assessment: ActionAssessment, request: ActionRequest): string {
  const rawIntent = request.input.command ?? request.input.target ?? request.input.action ?? request.name
  const intent = redactText(typeof rawIntent === 'string' ? rawIntent : JSON.stringify(rawIntent), 500)
  return `\n${redactText(assessment.reason, 500)}\nRisk: ${assessment.risk} · reversible: ${assessment.reversible ? 'yes' : 'no'}\nAbout to run ${request.name}: ${intent}\nApprove this exact action? [y]es / [n]o: `
}

async function loadRuntimeSkills(): Promise<void> {
  const { loadSkills } = await import('./skills/loader.ts')
  const skills = await loadSkills()
  if (skills.loaded.length > 0 && subcommand !== 'skills') {
    writeUsageLine(`${skills.loaded.length} learned tool(s): ${skills.loaded.map((skill) => skill.name).join(', ')}`)
  }

  const { loadMcpTools } = await import('./mcp/registry.ts')
  const mcp = await loadMcpTools()
  if (mcp.loaded.length > 0 && subcommand !== 'skills') {
    writeUsageLine(`${mcp.loaded.length} MCP tool(s) from ${mcp.servers.length} server(s): ${mcp.loaded.map((tool) => tool.name).join(', ')}`)
  }
  for (const failure of mcp.failed) writeNotice(`MCP server "${failure.server}" unavailable: ${failure.reason}`)
  for (const error of mcp.configErrors) writeNotice(`MCP config: ${error}`)
}

async function runAgentCommand(): Promise<void> {
  const request = positionals().join(' ').trim()
  if (!request) {
    writeError('Give elia a request: elia agent "write 3 instagram captions for our new product"')
    process.exitCode = 1
    return
  }

  const dryRun = hasFlag('--dry-run')
  const startedAt = Date.now()
  if (dryRun) {
    const { deterministicRoute } = await import('./agents/router.ts')
    const route = deterministicRoute(request)
    const elapsedMs = Date.now() - startedAt
    recordTopLevelTurn(elapsedMs)
    writeUsageLine(`routing plan: ${route.personas.join(' -> ')}${route.rationale ? ` — ${route.rationale}` : ''}`)
    writeNotice('Dry run complete: no specialist tools or side effects were executed.')
    writeUsageLine(formatUsageLine(ZERO_USAGE, elapsedMs, 'dry-run'))
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { runAgentRequest } = await import('./agents/orchestrator.ts')
  const { config } = await import('./config.ts')
  const result = await runAgentRequest(request)
  const elapsedMs = Date.now() - startedAt
  recordTopLevelTurn(elapsedMs)

  writeUsageLine(`agent(s): ${result.personas.join(' -> ')}${result.rationale ? ` — ${result.rationale}` : ''}`)
  writeUsageLine(formatUsageLine(result.usage, elapsedMs, config.model))
}

async function runAuto(): Promise<void> {
  const goal = positionals(['--variants', '--run-id', '--max-run-ms', '--max-actions']).join(' ').trim()
  if (!goal) {
    writeError('Give elia a goal: elia auto "add rate limiting to the API client"')
    process.exitCode = 1
    return
  }

  const profile = hasFlag('--fast') ? 'fast' : hasFlag('--thorough') ? 'thorough' : 'balanced'
  const resumeGraph = hasFlag('--resume')
  const resumeRunId = flagValue('--run-id')
  if (resumeGraph && !resumeRunId) {
    writeError('--resume requires --run-id <run-id> so Elia can locate the durable goal graph')
    process.exitCode = 1
    return
  }
  if (resumeGraph) writeNotice(`resuming durable run: ${resumeRunId}`)
  const maxActionsRaw = flagValue('--max-actions')
  const maxActions = maxActionsRaw === undefined ? undefined : strictInteger(maxActionsRaw)
  if (maxActionsRaw !== undefined && (maxActions === undefined || maxActions < 1 || maxActions > MAX_GOVERNED_ACTIONS)) {
    writeError(`--max-actions must be a positive integer between 1 and ${MAX_GOVERNED_ACTIONS}, got "${maxActionsRaw}"`)
    process.exitCode = 1
    return
  }
  if (maxActions !== undefined) writeNotice(`action budget: ${maxActions} governed tool requests`)
  const maxRunMsRaw = flagValue('--max-run-ms')
  const maxRunMs = maxRunMsRaw === undefined ? undefined : strictInteger(maxRunMsRaw)
  if (maxRunMsRaw !== undefined && (maxRunMs === undefined || maxRunMs < 1)) {
    writeError(`--max-run-ms must be a positive integer in milliseconds, got "${maxRunMsRaw}"`)
    process.exitCode = 1
    return
  }
  if (maxRunMs !== undefined) writeNotice(`wall-clock budget: ${(maxRunMs / 1000).toFixed(1)}s`)
  if (profile !== 'balanced') writeNotice(`autonomy profile: ${profile}`)

  const variantsRaw = flagValue('--variants')
  const variants = variantsRaw === undefined ? undefined : strictInteger(variantsRaw)
  if (variantsRaw !== undefined && (variants === undefined || variants < 1)) {
    writeError(`--variants must be a positive integer, got "${variantsRaw}"`)
    process.exitCode = 1
    return
  }
  if (variants && variants > 1) {
    writeNotice(
      `--variants ${variants}: running ${variants} independent implementation attempts in isolated git worktrees, keeping the one that verifies best.`,
    )
  }

  const supervisionEnv = process.env.ELIA_SUPERVISION?.trim().toLowerCase()
  if (supervisionEnv !== undefined && supervisionEnv !== 'supervised' && supervisionEnv !== 'unattended') {
    writeError('ELIA_SUPERVISION must be either supervised or unattended')
    process.exitCode = 1
    return
  }
  const unattendedFlag = hasFlag('--yolo', '-y', '--autonomous', '--self-supervise', '--unattended')
  const supervisedFlag = hasFlag('--supervised') || supervisionEnv === 'supervised'
  if (supervisedFlag && (unattendedFlag || supervisionEnv === 'unattended')) {
    writeError('Supervision conflict: choose --supervised/ELIA_SUPERVISION=supervised or an unattended flag, not both')
    process.exitCode = 1
    return
  }
  const yolo = !supervisedFlag && (unattendedFlag || supervisionEnv === 'unattended' || process.env.ELIA_AUTO_APPROVE === '1')
  writeNotice(`supervision: ${yolo ? 'unattended (critical actions remain blocked)' : 'supervised (approval required for review and critical actions)'}`)
  let approveAction: ActionApproval | undefined
  if (!yolo && !process.stdin.isTTY) {
    writeError('elia auto needs a terminal to approve the plan. Re-run with --unattended to skip routine approval.')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { runAutonomousTask, autoApprove } = await import('./autonomy/loop.ts')
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  let rl: readline.Interface | undefined
  try {
    if (yolo) {
      const result = await runAutonomousTask({ goal, approve: autoApprove, mode: requestedAgentMode(), variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'unattended', signal: controller.signal, maxWallClockMs: maxRunMs, maxActions })
      if (result.outcome !== 'completed') process.exitCode = 1
      return
    }

  rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const interactiveRl = rl
    if (!interactiveRl) throw new Error('interactive approval input was not initialized')
    approveAction = async (assessment, request) => {
      const label = actionApprovalPrompt(assessment, request)
      const result = await confirmOnce(interactiveRl, label)
      return result.action === 'approve'
    }
    const result = await runAutonomousTask({ goal, approve: createInteractiveApprover(interactiveRl), mode: requestedAgentMode(), variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'supervised', approveAction, signal: controller.signal, maxWallClockMs: maxRunMs, maxActions })
    if (result.outcome !== 'completed' && result.outcome !== 'rejected') process.exitCode = 1
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}

async function runBench(): Promise<void> {
  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { measureFitness, renderScorecard } = await import('./evolve/fitness.ts')
  const { ELIA_ROOT } = await import('./config.ts')

  writeNotice('Scoring the current elia against its own benchmark suite — this runs real agent loops.')
  const card = await measureFitness({
    sourceRoot: ELIA_ROOT,
    onTaskDone: (outcome) =>
      writeUsageLine(`  ${outcome.passed ? '✓' : '✗'} ${outcome.taskId} — ${outcome.error ?? outcome.detail}`),
  })
  if (machineReadable) emitEvent('benchmark_scorecard', { stage: 'current', scorecard: card })
  else process.stdout.write(renderScorecard(card, 'elia'))
  if (card.passRate < 1) process.exitCode = 1
}

async function runEvolve(): Promise<void> {
  const generationsRaw = flagValue('--generations', '-n') ?? '1'
  const generations = strictInteger(generationsRaw)
  if (generations === undefined || generations < 1) {
    writeError('--generations must be a positive integer.')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { evolve } = await import('./evolve/engine.ts')
  const result = await evolve({ generations, dryRun: hasFlag('--dry-run') })
  const promoted = result.generations.filter((record) => record.verdict === 'promoted')

  writeNotice(
    `${promoted.length} of ${result.generations.length} generation(s) promoted · pass rate ${Math.round(result.baseline.passRate * 100)}% → ${Math.round(result.final.passRate * 100)}%`,
  )
  for (const record of result.generations) {
    writeUsageLine(`  gen ${record.generation}: ${record.verdict} — ${record.hypothesis || record.reason}`)
  }
}

async function runSkills(): Promise<void> {
  const { listSkillFiles } = await import('./skills/loader.ts')
  const { listSkillBundles } = await import('./skills/bundles.ts')
  const { skillCandidates } = await import('./skills/detector.ts')
  const { PROJECT_SKILLS_DIR, USER_SKILLS_DIR, SKILL_SUFFIX, SKILL_BUNDLES_FILE } = await import('./skills/paths.ts')
  const action = positionals()[0] ?? 'list'

  if (action === 'path' || action === 'folder' || action === 'folders') {
    writeNotice(`Project skills: ${PROJECT_SKILLS_DIR}`)
    writeNotice(`User skills:    ${USER_SKILLS_DIR}`)
    writeNotice(`File contract:  create a self-contained ${SKILL_SUFFIX} module exporting a default Tool with name, description, input_schema, and execute(input).`)
    writeNotice(`Bundle file:    ${SKILL_BUNDLES_FILE}`)
    writeNotice('Skills are validated at startup; invalid modules are moved to the quarantine folder instead of stopping Elia.')
    return
  }

  if (action === 'list') {
    const files = listSkillFiles()
    if (files.length === 0) {
      writeNotice('No synthesized skills yet. Run "elia skills candidates" to see what elia keeps doing by hand.')
      return
    }
    for (const line of table([{ header: 'source' }, { header: 'file' }], files.map(({ source, file }) => [source, file]))) {
      writeUsageLine(`  ${line}`)
    }
    return
  }

  if (action === 'bundles') {
    const bundles = listSkillBundles()
    if (bundles.length === 0) {
      writeNotice(`No skill bundles configured. Create ${SKILL_BUNDLES_FILE} with a JSON object mapping bundle names to { skills: [...] }.`)
      return
    }
    for (const bundle of bundles) {
      const detail = bundle.description ? ` — ${bundle.description}` : ''
      writeUsageLine(`  ${bundle.name}: ${bundle.skills.join(', ')}${detail}`)
    }
    return
  }

  if (action === 'candidates') {
    const candidates = skillCandidates()
    if (candidates.length === 0) {
      writeNotice('Nothing has repeated often enough yet. Keep using elia — it is counting.')
      return
    }
    const rows = table(
      [{ header: 'seen', align: 'right' }, { header: 'kind' }, { header: 'pattern' }],
      candidates.map((c) => [`${c.count}×`, c.kind, c.pattern]),
    )
    const [header, separator, ...dataRows] = rows
    writeUsageLine(`  ${header}`)
    writeUsageLine(`  ${separator}`)
    candidates.forEach((candidate, i) => {
      writeUsageLine(`  ${dataRows[i]}`)
      for (const example of candidate.examples) writeUsageLine(`         ${dim('e.g.')} ${example}`)
    })
    writeNotice('Turn the strongest one into a real tool with: elia skills synth')
    return
  }

  if (action === 'synth') {
    const { synthesizeSkill } = await import('./skills/synthesize.ts')
    const candidate = skillCandidates()[0]
    if (!candidate) {
      writeNotice('No candidate has crossed the threshold yet.')
      return
    }

    writeNotice(`Writing a tool for "${candidate.pattern}" (seen ${candidate.count}×)…`)
    const result = await synthesizeSkill(candidate)
    if (result.ok) writeNotice(`✓ ${result.detail}`)
    else {
      writeError(`✗ ${result.detail}`)
      process.exitCode = 1
    }
    return
  }

  writeError(`Unknown skills action "${action}". Use: list, bundles, path, candidates, or synth.`)
  process.exitCode = 1
}

async function runControl(): Promise<void> {
  const { listRuns, readEvents } = await import('./autonomy/journal.ts')
  const { readRunControl, requestRunControl, runControlPath } = await import('./autonomy/control.ts')
  const values = positionals()
  const action = values[0] ?? 'status'
  const runId = values[1]

  if (action === 'status') {
    const runs = listRuns(20)
    if (runs.length === 0) {
      writeNotice('No autonomous runs found in this project.')
      return
    }
    for (const run of runs) {
      const ended = readEvents(run.runId).some((event) => event.kind === 'run-end')
      const request = readRunControl(run.runId)
      const state = ended ? `finished:${run.outcome}` : request ? `control-requested:${request.action}` : 'active-or-interrupted'
      writeUsageLine(`${run.runId} · ${state} · ${redactText(run.goal, 120)}`)
    }
    return
  }

  if (action !== 'pause' && action !== 'stop') {
    writeError('Usage: elia control status | elia control pause <run-id> | elia control stop <run-id>')
    process.exitCode = 1
    return
  }
  if (!runId) {
    writeError(`control ${action} requires <run-id>`)
    process.exitCode = 1
    return
  }
  try {
    runControlPath(runId)
    if (readEvents(runId).some((event) => event.kind === 'run-end')) {
      writeError(`Run ${runId} has already finished; inspect its receipt before resuming or forking it.`)
      process.exitCode = 1
      return
    }
    if (!requestRunControl(runId, action)) {
      writeError(`No durable run found for ${runId}`)
      process.exitCode = 1
      return
    }
  } catch {
    writeError(`Invalid run id: ${runId}`)
    process.exitCode = 1
    return
  }
  writeNotice(`Supervisor ${action} requested for run ${runId}. The owning process will stop at its next control poll.`)
}

async function runConfig(): Promise<void> {
  const { PROVIDER_PRESET_NAMES, isProviderPresetConfigured, providerPresetApiKeyEnv, providerPresetBaseURL, providerPresetDefaultModel } =
    await import('./providers/registry.ts')
  const action = positionals()[0] ?? 'status'
  const configPath = userConfigPath()

  if (action === 'status') {
    const active = process.env.ELIA_PROVIDER ?? 'anthropic'
    writeNotice(`User config: ${configPath}`)
    for (const provider of PROVIDER_PRESET_NAMES) {
      const marker = provider === active ? ' (active)' : ''
      writeUsageLine(`  ${provider}${marker}: ${isProviderPresetConfigured(provider) ? 'configured' : 'not configured'}`)
    }
    writeNotice('API key values are never displayed. Use: elia config set --provider <name>')
    return
  }

  if (action === 'remove') {
    const provider = (flagValue('--provider') || '').toLowerCase()
    if (!provider) {
      writeError('Usage: elia config remove --provider <name>')
      process.exitCode = 1
      return
    }
    try {
      const removed = removeProviderConfiguration(provider)
      writeNotice(removed.removed ? `Removed saved credentials for ${removed.provider} from ${removed.path}.` : `No saved credentials found for ${removed.provider}.`)
      writeNotice('The API key value was never displayed.')
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }

  if (action !== 'set') {
    writeError('Usage: elia config [status|set|remove] [--provider <name>] [--model <id>] [--base-url <url>] [--api-key-env <NAME>|--api-key-stdin]')
    process.exitCode = 1
    return
  }

  const provider = (flagValue('--provider') || process.env.ELIA_PROVIDER || 'anthropic').toLowerCase()
  if (!PROVIDER_PRESET_NAMES.includes(provider)) {
    writeError(`Unknown provider "${provider}". Choose one of: ${PROVIDER_PRESET_NAMES.join(', ')}`)
    process.exitCode = 1
    return
  }

  const modelFlag = flagValue('--model')
  if (modelFlag === '') {
    writeError('--model requires a non-empty model id')
    process.exitCode = 1
    return
  }
  const baseURLFlag = flagValue('--base-url')
  if (baseURLFlag === '') {
    writeError('--base-url requires a non-empty URL')
    process.exitCode = 1
    return
  }
  const sourceKeyEnv = flagValue('--api-key-env')
  if (sourceKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceKeyEnv)) {
    writeError('--api-key-env must be a valid environment variable name')
    process.exitCode = 1
    return
  }
  if (sourceKeyEnv !== undefined && hasFlag('--api-key-stdin')) {
    writeError('Choose either --api-key-env or --api-key-stdin, not both')
    process.exitCode = 1
    return
  }

  const targetKeyEnv = providerPresetApiKeyEnv(provider)
  if (!targetKeyEnv) {
    writeError(`Provider "${provider}" does not define an API key variable`)
    process.exitCode = 1
    return
  }

  let apiKey: string | undefined
  if (sourceKeyEnv !== undefined) {
    apiKey = process.env[sourceKeyEnv]?.trim()
    if (!apiKey) {
      writeError(`Environment variable ${sourceKeyEnv} is not set or is empty`)
      process.exitCode = 1
      return
    }
  } else if (hasFlag('--api-key-stdin')) {
    apiKey = (await readStdinText()).trim()
  } else if (process.stdin.isTTY) {
    apiKey = await readSecretInput(`Enter ${targetKeyEnv} (input hidden): `)
  } else {
    writeError('API key input requires --api-key-stdin, --api-key-env <NAME>, or an interactive terminal')
    process.exitCode = 1
    return
  }

  if (!apiKey) {
    writeError('API key cannot be empty')
    process.exitCode = 1
    return
  }

  const defaultModel = providerPresetDefaultModel(provider)
  const model = modelFlag ?? defaultModel
  if (provider === 'custom' && !model) {
    writeError('Custom providers require --model <model-id>')
    process.exitCode = 1
    return
  }
  const baseURL = baseURLFlag
  if (provider === 'custom' && !baseURL) {
    writeError('Custom providers require --base-url <url>')
    process.exitCode = 1
    return
  }

  const values: Record<string, string | undefined> = {
    ELIA_PROVIDER: provider,
    [targetKeyEnv]: apiKey,
    ELIA_MODEL: model,
    ELIA_BASE_URL: baseURL,
  }
  writeUserConfig(values)
  process.env.ELIA_PROVIDER = provider
  process.env[targetKeyEnv] = apiKey
  if (model) process.env.ELIA_MODEL = model
  else delete process.env.ELIA_MODEL
  if (baseURL) process.env.ELIA_BASE_URL = baseURL
  else delete process.env.ELIA_BASE_URL

  const knownBaseURL = baseURL ?? providerPresetBaseURL(provider)
  writeNotice(`Saved ${provider} configuration to ${configPath}.`)
  writeNotice(`Model: ${model ?? defaultModel ?? 'set by ELIA_MODEL'}`)
  if (knownBaseURL) writeNotice(`Endpoint: ${knownBaseURL}`)
  writeNotice('The API key was saved without displaying its value. Run `elia config` to inspect readiness.')
}

/**
 * Subscription authentication belongs to the official Codex CLI, not Elia's
 * OpenAI API adapter. Keeping it in the external client means Elia never reads
 * or persists a ChatGPT session token; the subscription provider invokes the
 * signed-in client only for its responses.
 */
async function runCodexLogin(): Promise<boolean> {
  const { codexAvailable } = await import('./tools/codex.ts')
  if (!(await codexAvailable())) {
    writeError('Codex CLI is not installed or not on PATH. Install @openai/codex, then run `elia codex-login` again.')
    process.exitCode = 1
    return false
  }

  writeNotice('Opening the Codex sign-in flow. Complete authentication in Codex; Elia never receives or stores your ChatGPT credentials.')
  try {
    const proc = Bun.spawn(['codex', 'login'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    const exitCode = await proc.exited
    if (exitCode === 0) {
      writeNotice('Codex sign-in finished. You can now select ChatGPT subscription (Codex) as Elia’s active model.')
      return true
    }
    else {
      writeError(`Codex sign-in ended with exit code ${exitCode}. Your existing Elia API-provider configuration was not changed.`)
      process.exitCode = 1
      return false
    }
  } catch (error) {
    writeError(`Could not start Codex sign-in: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return false
  }
}

async function readStdinText(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += Buffer.from(chunk as Uint8Array).toString('utf8')
  return text
}

async function readLineInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return ''
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(prompt)).trim()
  } finally {
    rl.close()
  }
}

async function readSecretInput(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY || !stdin.setRawMode) return ''
  process.stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return await new Promise<string>((resolve) => {
    let value = ''
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          process.stdout.write('\n')
          cleanup()
          resolve('')
          return
        }
        if (char === '\r' || char === '\n') {
          process.stdout.write('\n')
          cleanup()
          resolve(value)
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
    }
    stdin.on('data', onData)
  })
}

async function chooseProviderForSetup(title: string): Promise<string | undefined> {
  const { PROVIDER_PRESET_NAMES, isProviderPresetConfigured, providerPresetDefaultModel } = await import('./providers/registry.ts')
  const options = PROVIDER_PRESET_NAMES.map((provider) => ({
    label: provider,
    detail: `${isProviderPresetConfigured(provider) ? 'configured' : 'not configured'} · ${providerPresetDefaultModel(provider) ?? 'custom endpoint and model'}`,
    value: provider,
  }))
  const result = await pick(title, options)
  if (result.type === 'select') return result.value
  if (result.type === 'cancel') return undefined
  const entered = (await readLineInput(`Provider [${options[0]?.value ?? 'anthropic'}]: `)).toLowerCase()
  const selected = entered || options[0]?.value
  if (!selected || !PROVIDER_PRESET_NAMES.includes(selected)) {
    writeError(`Unknown provider "${entered}". No credentials were changed.`)
    return undefined
  }
  return selected
}

async function chooseModelForSetup(provider: string, suggestedModel?: string): Promise<string | undefined> {
  const { listProviderModels, providerPresetDefaultModel } = await import('./providers/registry.ts')
  const discovery = await listProviderModels(provider)
  const defaultModel = suggestedModel ?? providerPresetDefaultModel(provider)
  if (discovery.models.length > 0) {
    const options = discovery.models.map((model) => ({
      label: model.id === defaultModel ? `${model.id} (recommended)` : model.id,
      detail: model.name ?? model.ownedBy ?? 'available model',
      value: model.id,
    }))
    const result = await pick(`Select a model for ${provider}`, options, Math.max(0, options.findIndex((option) => option.value === defaultModel)))
    if (result.type === 'select') return result.value
    if (result.type === 'cancel') return undefined
  }
  if (discovery.error) writeNotice(`Model discovery unavailable: ${discovery.error}`)
  if (!defaultModel) return readLineInput(`Enter the model id for ${provider}: `)
  const entered = await readLineInput(`Model id [${defaultModel}]: `)
  return entered || defaultModel
}

async function interactiveProviderSetup(reason: 'first-run' | 'settings'): Promise<SavedProviderConfiguration | undefined> {
  const provider = await chooseProviderForSetup(reason === 'first-run' ? 'First-run provider setup' : 'Add or update provider')
  if (!provider) {
    writeNotice('Provider setup cancelled. No credentials were changed.')
    return undefined
  }
  if (provider === 'codex') {
    if (!(await runCodexLogin())) return undefined
    const model = 'default'
    const path = userConfigPath()
    writeUserConfig({ ELIA_PROVIDER: provider, ELIA_MODEL: model, ELIA_BASE_URL: undefined }, path)
    process.env.ELIA_PROVIDER = provider
    process.env.ELIA_MODEL = model
    delete process.env.ELIA_BASE_URL
    return { provider, apiKeyEnv: 'managed by Codex', model, path }
  }
  const { providerPresetApiKeyEnv } = await import('./providers/registry.ts')
  const apiKeyEnv = providerPresetApiKeyEnv(provider)
  if (!apiKeyEnv) {
    writeError(`Provider "${provider}" does not define an API key variable`)
    return undefined
  }
  const baseURL = provider === 'custom' ? await readLineInput('Custom HTTPS base URL: ') : undefined
  if (provider === 'custom' && !baseURL) {
    writeNotice('Provider setup cancelled. A custom provider requires a base URL.')
    return undefined
  }
  const apiKey = await readSecretInput(`Enter ${apiKeyEnv} (input hidden): `)
  if (!apiKey) {
    writeNotice('Provider setup cancelled. No credentials were changed.')
    return undefined
  }

  const previousKey = process.env[apiKeyEnv]
  const previousBaseURL = process.env.ELIA_BASE_URL
  process.env[apiKeyEnv] = apiKey
  if (baseURL) process.env.ELIA_BASE_URL = baseURL
  let savedConfiguration: SavedProviderConfiguration | undefined
  try {
    const model = await chooseModelForSetup(provider)
    if (!model) {
      writeNotice('Provider setup cancelled. No credentials were changed.')
      return undefined
    }
    savedConfiguration = saveProviderConfiguration({ provider, apiKey, model, baseURL })
    writeNotice(`Saved ${provider} configuration to ${savedConfiguration.path}.`)
    writeNotice(`Model: ${savedConfiguration.model}`)
    writeNotice('The API key was saved without displaying its value.')
    return savedConfiguration
  } catch (error) {
    writeError(`Provider setup failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    if (!savedConfiguration) {
      if (process.env[apiKeyEnv] === apiKey && previousKey !== undefined) process.env[apiKeyEnv] = previousKey
      else if (previousKey === undefined && process.env[apiKeyEnv] === apiKey) delete process.env[apiKeyEnv]
      if (baseURL && process.env.ELIA_BASE_URL === baseURL && previousBaseURL !== undefined) process.env.ELIA_BASE_URL = previousBaseURL
      else if (baseURL && previousBaseURL === undefined && process.env.ELIA_BASE_URL === baseURL) delete process.env.ELIA_BASE_URL
    }
  }
}

async function ensureFirstRunProviderSetup(): Promise<boolean> {
  if (!activeProviderNeedsSetup()) return true
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    writeError('No provider is configured. Run `elia config set --provider <name> --api-key-stdin --model <model-id>` from a secure shell, or run elia in an interactive terminal for first-run setup.')
    process.exitCode = 1
    return false
  }
  writeNotice('No complete provider configuration was found. Elia will ask for a provider, hidden API key, and model before starting.')
  return Boolean(await interactiveProviderSetup('first-run'))
}

async function runSchedule(): Promise<void> {
  const { MAX_SCHEDULE_ACTIONS, ScheduleStore, formatScheduleInterval, parseScheduleInterval } = await import('./autonomy/scheduler.ts')
  const action = positionals(['--every', '--title', '--profile', '--mode', '--max-run-ms', '--max-actions'])[0] ?? 'list'
  const store = ScheduleStore.open()

  if (action === 'list') {
    const records = store.list()
    if (records.length === 0) {
      writeNotice('No scheduled goals. Add one with: elia schedule add --every 1h "<goal>"')
      return
    }
    for (const line of table(
      [{ header: 'id' }, { header: 'title' }, { header: 'mode' }, { header: 'status' }, { header: 'every' }, { header: 'actions' }, { header: 'next run' }, { header: 'runs', align: 'right' }, { header: 'last outcome' }, { header: 'goal' }],
      records.map((record) => [record.id, record.title, record.mode, record.status, formatScheduleInterval(record.intervalMs), record.maxActions ? String(record.maxActions) : 'profile default', new Date(record.nextRunAt).toISOString(), String(record.runCount), record.lastOutcome ?? '—', record.goal.slice(0, 60)]),
    )) writeUsageLine(`  ${line}`)
    return
  }

  const id = positionals()[1]
  if (action === 'pause' || action === 'resume' || action === 'remove') {
    if (!id) {
      writeError(`Usage: elia schedule ${action} <id>`)
      process.exitCode = 1
      return
    }
    if (action === 'remove') {
      store.remove(id)
      writeNotice(`Removed scheduled goal ${id}.`)
    } else {
      const record = action === 'pause' ? store.pause(id) : store.resume(id)
      writeNotice(`${action === 'pause' ? 'Paused' : 'Resumed'} ${record.title} (${record.id}).`)
    }
    return
  }

  if (action === 'run') {
    if (!id) {
      writeError('Usage: elia schedule run <id>')
      process.exitCode = 1
      return
    }
    store.resume(id, Date.now())
    await loadRuntimeSkills()
    const { runScheduledDaemon } = await import('./autonomy/daemon.ts')
    await runScheduledDaemon({ once: true })
    return
  }

  if (action !== 'add') {
    writeError(`Unknown schedule action "${action}". Use: add, list, pause, resume, remove, or run.`)
    process.exitCode = 1
    return
  }

  const goal = positionals(['--every', '--title', '--profile', '--mode', '--max-run-ms', '--max-actions']).slice(1).join(' ').trim()
  const every = flagValue('--every')
  if (!goal || !every) {
    writeError('Usage: elia schedule add --every 1h [--mode battmann] [--title "Short title"] [--max-actions N] "<goal>"')
    process.exitCode = 1
    return
  }
  let intervalMs: number
  try {
    intervalMs = parseScheduleInterval(every)
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  const profileValue = flagValue('--profile')
  const profile = profileValue === 'fast' || profileValue === 'thorough' ? profileValue : 'balanced'
  if (profileValue !== undefined && !['fast', 'balanced', 'thorough'].includes(profileValue)) {
    writeError('--profile must be fast, balanced, or thorough')
    process.exitCode = 1
    return
  }
  const modeValue = flagValue('--mode') ?? 'dev'
  if (!['dev', 'cyber', 'sports', 'fitness', 'battmann'].includes(modeValue)) {
    writeError('--mode must be dev, cyber, sports, fitness, or battmann')
    process.exitCode = 1
    return
  }
  const maxRunMsRaw = flagValue('--max-run-ms')
  const maxRunMs = maxRunMsRaw === undefined ? undefined : strictInteger(maxRunMsRaw)
  if (maxRunMsRaw !== undefined && (maxRunMs === undefined || maxRunMs < 1)) {
    writeError('--max-run-ms must be a positive integer in milliseconds')
    process.exitCode = 1
    return
  }
  const maxActionsRaw = flagValue('--max-actions')
  const maxActions = maxActionsRaw === undefined ? undefined : strictInteger(maxActionsRaw)
  if (maxActionsRaw !== undefined && (maxActions === undefined || maxActions < 1 || maxActions > MAX_SCHEDULE_ACTIONS)) {
    writeError(`--max-actions must be an integer between 1 and ${MAX_SCHEDULE_ACTIONS}`)
    process.exitCode = 1
    return
  }
  const title = flagValue('--title') || goal.slice(0, 80)
  const record = store.create({ title, goal, intervalMs, profile, mode: modeValue as AgentMode, maxRunMs, maxActions })
  writeNotice(`Scheduled ${record.title} every ${formatScheduleInterval(record.intervalMs)}. id=${record.id}`)
  writeNotice('Run it with: elia daemon --once')
}

async function runDaemon(): Promise<void> {
  const pollMsRaw = flagValue('--poll-ms')
  const pollMs = pollMsRaw === undefined ? undefined : strictInteger(pollMsRaw)
  if (pollMsRaw !== undefined && (pollMs === undefined || pollMs < 1_000)) {
    writeError('--poll-ms must be an integer of at least 1000 milliseconds')
    process.exitCode = 1
    return
  }
  await loadRuntimeSkills()
  const { runScheduledDaemon } = await import('./autonomy/daemon.ts')
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  try {
    if (!hasFlag('--once')) writeNotice(`Background daemon active; polling every ${(pollMs ?? 30_000) / 1000}s. Ctrl+C stops it.`)
    await runScheduledDaemon({ pollMs, once: hasFlag('--once'), signal: controller.signal })
  } finally {
    unregisterShutdown()
  }
}

async function runRuns(): Promise<void> {
  const { listRuns } = await import('./autonomy/journal.ts')
  const runId = positionals()[0]

  if (runId) {
    const { renderRunTimeline } = await import('./autonomy/rewind.ts')
    const timeline = renderRunTimeline(runId)
    if (machineReadable) emitEvent('run_timeline', { runId, timeline })
    else process.stdout.write(`${timeline}\n`)
    return
  }

  const runs = listRuns()
  if (runs.length === 0) {
    writeNotice('No autonomous runs in this directory yet. Start one with: elia auto "<goal>"')
    return
  }
  for (const line of table(
    [{ header: 'id' }, { header: 'outcome' }, { header: 'checkpoints', align: 'right' }, { header: 'recovered', align: 'right' }, { header: 'task' }, { header: 'goal' }],
    runs.map((run) => [run.runId, run.outcome, String(run.checkpoints), String(run.recoveredNodes ?? 0), run.taskSessionId ?? '—', run.goal.slice(0, 60)]),
  )) {
    writeUsageLine(`  ${line}`)
  }
  const { renderCalibrationLine } = await import('./autonomy/calibration.ts')
  const calibration = renderCalibrationLine()
  if (calibration && !machineReadable) writeNotice(calibration)
  writeNotice('Inspect one with: elia runs <id>')
}

async function runResume(): Promise<void> {
  const { runDir, readEvents } = await import('./autonomy/journal.ts')
  const runId = positionals()[0]
  if (!runId) {
    writeError('Usage: elia resume <runId> [--yolo]')
    process.exitCode = 1
    return
  }
  const start = readEvents(runId).find((event) => event.kind === 'run-start')
  const goal = typeof start?.data.goal === 'string' ? start.data.goal : undefined
  if (!goal) {
    writeError(`No durable run found for ${runId}`)
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  const { GoalGraphStore } = await import('./autonomy/goalGraph.ts')
  const graph = GoalGraphStore.open({ runId, goal, dir: runDir(runId) })
  const recovery = graph.leaseRecoverySummary()
  if (recovery.nodes || recovery.actions) writeNotice(`Recovered stale execution leases: ${recovery.nodes} node(s), ${recovery.actions} action(s).`)
  const pending = graph.pendingApprovals()
  if (pending.length > 0 && !process.stdin.isTTY && !hasFlag('--yolo', '-y')) {
    writeError(`Run ${runId} has ${pending.length} pending approval(s); resume from a terminal or pass --yolo to keep them blocked.`)
    process.exitCode = 1
    return
  }

  const rl = process.stdin.isTTY && !hasFlag('--yolo', '-y')
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : undefined
  await loadRuntimeSkills()
  const { runAutonomousTask, autoApprove } = await import('./autonomy/loop.ts')
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  try {
    for (const approval of pending) {
      if (!rl) break
      const result = await confirmOnce(rl, `Resume ${approval.kind} approval ${approval.subject}? [y]es / [n]o: `)
      graph.resolveApproval(approval.id, result.action === 'approve', result.action)
    }

    const approveAction: ActionApproval | undefined = rl
      ? async (assessment, request) => {
          const result = await confirmOnce(rl, actionApprovalPrompt(assessment, request))
          return result.action === 'approve'
        }
      : undefined
    const result = await runAutonomousTask({
      goal,
      runId,
      resumeGraph: true,
      approve: rl ? createInteractiveApprover(rl) : autoApprove,
      approveAction,
      governanceMode: rl ? 'supervised' : 'unattended',
      polish: !hasFlag('--no-polish'),
      signal: controller.signal,
    })
    if (result.outcome !== 'completed') process.exitCode = 1
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}

async function runFork(): Promise<void> {
  const runId = positionals(['--at', '--with']).at(0)
  const at = strictInteger(flagValue('--at'))
  const instruction = flagValue('--with')

  if (!runId || at === undefined || !instruction) {
    writeError('Usage: elia fork <runId> --at <checkpoint> --with "<what to do differently>"')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { forkRun } = await import('./autonomy/rewind.ts')
  const { autoApprove } = await import('./autonomy/loop.ts')
  const rl = process.stdin.isTTY && !hasFlag('--yolo', '-y')
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : undefined
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())

  try {
    const result = await forkRun({
      runId,
      checkpointId: at,
      instruction,
      approve: rl ? createInteractiveApprover(rl) : autoApprove,
      signal: controller.signal,
    })
    if (!result.ok) {
      writeError(result.error)
      process.exitCode = 1
    }
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}

async function runInteractive(): Promise<void> {
  const continueFlag = hasFlag('--continue', '-c')
  const resumeId = flagValue('--resume')
  if (hasFlag('--resume') && !resumeId) {
    writeError('--resume requires a session id.')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  warnIfAtFilesystemRoot()
  await loadRuntimeSkills()
  const { runTurn } = await import('./agent.ts')
  const { config, describeThinking, getThinking, switchModel, switchThinking, THINKING_EFFORT_BUDGETS, DEFAULT_THINKING_BUDGET } =
    await import('./config.ts')
  const { PROVIDER_PRESET_NAMES, isProviderPresetConfigured, providerPresetDefaultModel, listProviderModels } = await import('./providers/registry.ts')
  const { newSessionId, loadSession, loadLatestSession, saveSession } = await import('./session.ts')
  const { createFileTracker, setActiveTracker, loadCheckpoints, saveCheckpoints, restoreCheckpoint, renderCheckpointList } =
    await import('./checkpoint.ts')
  const { setActiveLedgerSession, countEpisodes } = await import('./ledger.ts')
  const { renderContextStatus } = await import('./compaction.ts')
  const { writeSessionHeartbeat, writeSessionEnded } = await import('./sessionRegistry.ts')

  const oneShotPrompt = positionals(['--resume']).join(' ').trim()

  let mode: AgentMode = requestedAgentMode()

  let persona: AgentPersona | undefined
  let selectedSkillNames: string[] | undefined

  const renderTeamStatus = (): string => {
    const roles = Object.entries(config.roleOverrides).flatMap(([role, route]) => route ? [`${role.padEnd(13)} ${route.providerName}/${route.model}`] : [])
    return [
      `deep          ${config.tiers.deep.providerName}/${config.tiers.deep.model}`,
      `fast          ${config.tiers.fast.providerName}/${config.tiers.fast.model}${config.cascadeEnabled ? '' : ' (same as deep)'}`,
      ...(roles.length > 0 ? ['', 'role routes', ...roles] : ['', 'role routes   none configured; roles use their fast/deep tier']),
      '',
      'Independent dependency-wave workers run concurrently; shared-provider capacity is bounded and file collisions are serialized.',
    ].join('\n')
  }
  let messages: ConversationMessage[] = []
  let sessionId = newSessionId()
  // manual (default): a cheap risk check runs before each command — only
  // commands flagged risky (deletes, sends, spend, publishing, system
  // changes, ...) get an "About to: ... run it?" prompt; everything else just
  // runs. auto (--yolo, or "/settings" → Risk checks): skips the pre-flight prompt while the
  // shared governor still blocks or requests approval for critical actions.
  // Safe and reversible work runs end to end without interruption.
  let replMode: 'manual' | 'auto' = hasFlag('--yolo', '-y') ? 'auto' : 'manual'
  // After a turn that changed code, run the project's own checks and repair any
  // failure before reporting done. On by default; --no-verify or /verify off.
  let autoVerify = !hasFlag('--no-verify')
  // Output from `!cmd` lines, held until the next real prompt so the model sees
  // what the user just ran without an extra round-trip.
  const carriedShellContext: string[] = []

  if (continueFlag || resumeId) {
    const loaded = resumeId ? await loadSession(resumeId) : await loadLatestSession()
    if (loaded) {
      messages = loaded.messages
      sessionId = loaded.id
      writeNotice(`Resumed session ${sessionId} (${messages.length} messages)`)
    } else {
      writeNotice(
        resumeId ? `No session found with id "${resumeId}" — starting fresh.` : 'No previous session found — starting fresh.',
      )
    }
  }

  const checkpoints = await loadCheckpoints(sessionId)
  const sessionStartedAt = Date.now()

  // Opportunistically tidy the cross-session brain: merge duplicate lessons and
  // drop stale ones so every future prompt isn't paying to carry them. Fire and
  // forget — it is one cheap fast-tier call, gated to run at most once a day and
  // only once there is enough to be worth it, and a failure changes nothing.
  if (mode === 'dev') {
    void import('./brain/consolidate.ts')
      .then(({ consolidateBrain }) => consolidateBrain())
      .catch(() => {})
  }

  /**
   * Lets every other elia process running in this project see this one's
   * live status via sessionRegistry.ts (`/sessions`) — separate from and in
   * addition to taskSessions.ts's own in-process dashboard (`/task`).
   */
  function pushHeartbeat(busy: boolean, lastAction: string): void {
    writeSessionHeartbeat({
      sessionId,
      pid: process.pid,
      mode: persona ?? mode,
      providerLabel: config.providerLabel,
      model: config.model,
      startedAt: sessionStartedAt,
      busy,
      lastAction,
      taskSummary: renderTaskSummary(taskSessions),
      messageCount: messages.length,
    })
  }
  pushHeartbeat(false, 'Idle at prompt')
  // The single source of truth for "this session ended," covering every exit
  // path at once — normal completion (one-shot prompts return before ever
  // reaching the interactive loop's own Goodbye code below), Ctrl+C, and
  // signals — since registerShutdownCleanup's callbacks run on process 'exit'
  // regardless of why the process is exiting (see ui/shutdown.ts).
  registerShutdownCleanup(() =>
    writeSessionEnded({ sessionId, pid: process.pid, mode: persona ?? mode, providerLabel: config.providerLabel, model: config.model, startedAt: sessionStartedAt, busy: false, lastAction: 'Session ended', taskSummary: renderTaskSummary(taskSessions), messageCount: messages.length }),
  )

  /** Snapshots messages + touched files around one turn, then records a rewind point. */
  async function runCheckpointedTurn(userText: string, approveAction?: ActionApproval, skillNames = selectedSkillNames, uiHooks?: TurnUiHooks): Promise<void> {
    const tracker = createFileTracker()
    const task = taskSessions.create(inferTaskKind(userText, userText), redactText(userText, 160), 'Starting request')
    taskSessions.update(task.id, { status: 'running', action: 'Thinking', detail: 'Planning the next action' })
    pushHeartbeat(true, redactText(userText, 160))
    const controller = new AbortController()
    let stopRequested = false
    // Signals for the per-turn outcome record (competence map + regret nudge).
    let toolErrorCount = 0
    let editRetryCount = 0
    let verifyResult: import('./autonomy/outcomes.ts').VerifyResult = 'none'
    let repairAttempts = 0
    const unregisterControls = taskSessions.registerControls(task.id, {
      cancel: () => {
        stopRequested = true
        controller.abort()
        taskSessions.update(task.id, { status: 'paused', action: 'Stopping', detail: 'Cancellation requested by operator' })
      },
    })
    const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
    if (uiHooks?.signal) {
      if (uiHooks.signal.aborted) controller.abort()
      else uiHooks.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    emitEvent('turn_started', { taskId: task.id, sessionId, prompt: redactText(userText, 2000) })
    setActiveTracker(tracker)
    // Lets compaction (mid-loop, several call frames down) and the recall tool
    // find this session's ledger — see ledger.ts's setActiveLedgerSession doc.
    setActiveLedgerSession({ id: sessionId, turn: checkpoints.length })
    const messagesBefore = structuredClone(messages)
    messages.push(userMessage(userText))
    sessionTranscript.appendUser(userText)

    const runModelTurn = () =>
      runTurn(messages, {
        mode,
        approveAction,
        skillNames,
        signal: controller.signal,
        silent: Boolean(uiHooks),
        planMode: uiHooks?.planMode,
        drainSteering: uiHooks?.drainSteering,
        onText: uiHooks?.onText,
        onThinking: uiHooks?.onThinking,
        onToolStart: uiHooks?.onToolStart,
        onActivity: (activity) => {
          const action = redactText(activity.title, 120)
          taskSessions.update(task.id, { status: 'running', action, detail: redactText(activity.detail ?? activity.title, 500) })
          uiHooks?.onActivity?.(activity)
          pushHeartbeat(true, action)
        },
        onTool: (event) => {
          const action = event.isError ? `Retrying after ${event.name}` : event.name
          if (event.isError) {
            toolErrorCount += 1
            if (event.name === 'edit_file' || event.name === 'write_file') editRetryCount += 1
          }
          taskSessions.update(task.id, {
            status: 'running',
            action,
            detail: event.isError ? redactText(event.result, 500) : 'Action completed successfully',
            stepsCompleted: (taskSessions.get(task.id)?.stepsCompleted ?? 0) + 1,
          })
          sessionTranscript.recordTool(event)
          uiHooks?.onTool?.(event)
          pushHeartbeat(true, action)
        },
      })

    try {
      if (persona) {
        const { runPersonaTurn } = await import('./agents/orchestrator.ts')
        await runPersonaTurn(messages, persona, skillNames, controller.signal)
      } else {
        const turnResult = await runModelTurn()
        if (turnResult.stopReason === 'aborted') stopRequested = true
      }
      if (stopRequested || controller.signal.aborted) {
        taskSessions.update(task.id, { status: 'paused', action: 'Stopped', detail: 'Stopped by operator; no further tool calls will run' })
        emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'aborted' })
        return
      }

      // Domain-aware self-defense: if this change touched an area elia has a poor
      // track record in on this project, force one hard self-review of the diff
      // before it can claim done — it reviews itself harder exactly where it has
      // proven unreliable.
      if (!persona && !uiHooks?.planMode && !controller.signal.aborted) {
        const { touchedWeakDomain } = await import('./autonomy/outcomes.ts')
        const weak = touchedWeakDomain(Object.keys(tracker.snapshot()))
        if (weak.length > 0) {
          const label = `Self-reviewing ${weak.join('/')} change (weak area)`
          taskSessions.update(task.id, { status: 'running', action: 'Self-review', detail: label })
          uiHooks?.onActivity?.({ kind: 'status', status: 'updated', title: label })
          if (!uiHooks) writeNotice(label)
          messages.push(
            userMessage(
              `This change is in "${weak.join('/')}", an area where past turns on this project landed clean less than 75% of the time. Before you finish: run \`git diff\`, then dispatch a \`critic\` and a \`bughunter\` sub-agent in parallel against that diff, and fix anything blocking they raise. Do not skip this.`,
            ),
          )
          await runModelTurn()
        }
      }

      // Green-by-construction: a turn that changed code isn't done until the
      // project's own checks pass. Detect them, run them, and hand any failure
      // back for a bounded repair — the "done!" that isn't is the single most
      // common way an autonomous agent wastes your time.
      if (!persona && autoVerify && !uiHooks?.planMode) {
        const { changedCodeFiles, checkRoot, detectChecks } = await import('./autonomy/detectChecks.ts')
        const { runVerification, describeVerification } = await import('./autonomy/verify.ts')
        const changedAll = Object.keys(tracker.snapshot())
        const changed = changedCodeFiles(changedAll)
        const root = checkRoot(changedAll, process.cwd())
        const checks = changed.length > 0 ? detectChecks(root) : []
        if (checks.length > 0) {
          const where = root === process.cwd() ? '' : ` in ${root}`
          taskSessions.update(task.id, { status: 'running', action: 'Verifying', detail: `${checks.join(' && ')}${where}` })
          uiHooks?.onActivity?.({ kind: 'status', status: 'updated', title: `Verifying${where} — ${checks.join(', ')}` })
          if (!uiHooks) writeNotice(`Verifying${where}: ${checks.join(' && ')}`)
          let outcome = await runVerification(checks, root, controller.signal)
          for (let attempt = 1; !outcome.passed && attempt <= 2 && !controller.signal.aborted; attempt += 1) {
            repairAttempts = attempt
            const summary = `Verification failed (repair ${attempt}/2)`
            uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: summary })
            if (!uiHooks) writeNotice(`${summary} — ${describeVerification(outcome).split('\n')[0]}`)
            messages.push(
              userMessage(
                `The project's checks fail after your changes — the task is not done:\n\n${describeVerification(outcome)}\n\nFix what broke. Run the check yourself to confirm before you stop.`,
              ),
            )
            await runModelTurn()
            outcome = await runVerification(checks, root, controller.signal)
          }
          verifyResult = outcome.passed ? 'pass' : 'fail'
          const verdict = outcome.passed
            ? `✓ verified — ${checks.join(', ')} pass`
            : `⚠ checks still failing after 2 repair attempts — ${describeVerification(outcome).split('\n')[0]}`
          uiHooks?.onActivity?.({ kind: 'status', status: outcome.passed ? 'completed' : 'warning', title: verdict })
          if (!uiHooks) writeNotice(verdict)
        }
      }

      taskSessions.update(task.id, { status: 'done', action: 'Finished', detail: 'Request completed and session saved' })
      emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'completed' })
    } catch (error) {
      const detail = redactText(error instanceof Error ? error.message : String(error), 2000)
      if (stopRequested || controller.signal.aborted) {
        taskSessions.update(task.id, { status: 'paused', action: 'Stopped', detail: 'Stopped by operator; no further tool calls will run' })
        emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'aborted' })
      } else {
        taskSessions.update(task.id, { status: 'failed', action: 'Failed', detail, error: detail })
        emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'failed', error: redactText(detail, 2000) })
        throw error
      }
    } finally {
      unregisterControls()
      unregisterShutdown()
      setActiveTracker(undefined)
      sessionTranscript.appendAssistant(lastAssistantText(messages, ''))
      sessionTranscript.endTurn()
      pushHeartbeat(false, taskSessions.get(task.id)?.action ?? 'Idle at prompt')
      if (!persona) {
        const { recordOutcome, domainsOf } = await import('./autonomy/outcomes.ts')
        const changedPaths = Object.keys(tracker.snapshot())
        recordOutcome({
          prompt: redactText(userText, 120),
          filesChanged: changedPaths.length,
          domains: domainsOf(changedPaths),
          editRetries: editRetryCount,
          toolErrors: toolErrorCount,
          verify: verifyResult,
          repairAttempts,
          aborted: stopRequested || controller.signal.aborted,
        })
      }
    }
    checkpoints.push({
      turn: checkpoints.length,
      at: Date.now(),
      label: userText.length > 60 ? `${userText.slice(0, 59)}…` : userText,
      messagesBefore,
      files: tracker.snapshot(),
    })
    await saveCheckpoints(sessionId, checkpoints)
  }

  if (oneShotPrompt) {
    let commandToRun = oneShotPrompt

    // Non-TTY (piped/scripted) runs can't answer a prompt, so they skip straight
    // to execution — same as today. A real terminal gets the same risk-gated
    // ask as the interactive loop below, unless --yolo skips it.
    if (!hasFlag('--yolo', '-y') && process.stdin.isTTY) {
      const { risky, reason } = await classifyCommandRisk(commandToRun)
      if (risky) {
        const confirmPrompt = createSlashPrompt([])
        const label = `${reason ? `${redactText(reason, 500)}\n` : ''}About to: "${redactText(commandToRun, 500)}" — run it? [y]es / [n]o / [e]dit: `
        const result = await confirmOnce(confirmPrompt, label)
        confirmPrompt.close()
        if (result.action === 'reject') {
          writeNotice('Skipped.')
          return
        }
        if (result.action === 'amend') commandToRun = result.feedback
      }
    }

    try {
      await runCheckpointedTurn(commandToRun, process.stdin.isTTY ? async (assessment, request) => {
        const actionPrompt = createSlashPrompt([])
        try {
          const result = await confirmOnce(actionPrompt, actionApprovalPrompt(assessment, request))
          return result.action === 'approve'
        } finally {
          actionPrompt.close()
        }
      } : undefined)
    } catch (err) {
      writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
    await saveSession(sessionId, messages)
    const taskSummary = renderTaskSummary(taskSessions)
    const contextLine = renderContextStatus(messages, await countEpisodes(sessionId))
    writeUsageLine(taskSummary ? `${contextLine}  ·  ${dim(taskSummary)}` : contextLine)
    await printTurnProfileReport()
    return
  }

  if (process.stdout.isTTY && !plainOutput && !machineReadable && !interactiveTerminal) await playIntro()
  // The live Ink REPL renders its own header/greeting; the classic readline path
  // keeps the workspace-panel snapshot.
  if (!machineReadable && !quietOutput && !interactiveTerminal) {
    process.stdout.write(`${renderWorkspacePanel({ sessionId, mode, providerLabel: config.providerLabel, model: config.model })}\n`)
  }
  if (!interactiveTerminal) {
    writeNotice(
      mode === 'cyber'
        ? 'cyber mode on — authorized security testing, vuln research, and CTFs only. type a prompt, "/" to see commands, or "exit" to quit'
        : mode === 'sports'
          ? 'sports mode on — evidence-aware match, scouting, performance, league, event, and sports-business analysis. type a prompt, "/" to see commands, or "exit" to quit'
          : mode === 'fitness'
            ? 'fitness mode on — conservative training, habit, recovery, and wellbeing support; not medical advice. type a prompt, "/" to see commands, or "exit" to quit'
            : mode === 'battmann'
              ? 'Battmann mode on — strategic risk intelligence across trade, geopolitics, markets, supply chain, policy, and commodities. type a prompt, "/" to see commands, or "exit" to quit'
              : 'dev mode on — building, debugging, testing, browser, and task workflows available. type a prompt, "/" to see commands, or "exit" to quit (Ctrl+C also works)',
    )
    writeNotice(
      replMode === 'auto'
        ? 'auto mode (--yolo) — preliminary risk checks are skipped; safe work runs immediately, while governed irreversible actions still require explicit approval. "/settings" → Risk checks to turn checks back on.'
        : 'manual mode — elia flags risky commands and asks before running them; safe commands just run. "/settings" → Risk checks for zero prompts.',
    )
    if (mode === 'dev') {
      try {
        const { detectGitHubContext, renderGitHubBanner } = await import('./github/context.ts')
        const line = renderGitHubBanner(await detectGitHubContext(process.cwd()))
        if (line) writeNotice(line)
      } catch {
        // GitHub context is a convenience readout, never a startup blocker.
      }
    }
  }

  function applyModelChoice(providerName: string, model?: string): void {
    const result = switchModel({ providerName, model })
    if (!result.ok) writeError(result.error)
    else writeNotice(`Model switched: ${result.label}`)
  }

  function activateCodexSubscription(model = 'default'): void {
    const switched = switchModel({ providerName: 'codex', model })
    if (!switched.ok) {
      writeError(switched.error)
      return
    }
    writeUserConfig({ ELIA_PROVIDER: 'codex', ELIA_MODEL: model, ELIA_BASE_URL: undefined })
    process.env.ELIA_PROVIDER = 'codex'
    process.env.ELIA_MODEL = model
    delete process.env.ELIA_BASE_URL
    writeNotice(`Model switched: ${switched.label}`)
  }

  async function handleModelCommand(argLine: string): Promise<void> {
    const args = argLine.split(/\s+/).filter(Boolean)

    async function chooseModelForProvider(providerName: string): Promise<void> {
      const discovery = await listProviderModels(providerName)
      const fallbackModel = providerName === config.providerName ? config.model : providerPresetDefaultModel(providerName)
      if (discovery.models.length === 0) {
        if (discovery.error) writeNotice(`Could not list ${providerName} models: ${discovery.error}`)
        if (fallbackModel) applyModelChoice(providerName, fallbackModel)
        else writeNotice(`No model list or default model is available for ${providerName}. Use /model ${providerName} <model-id>.`)
        return
      }
      const currentModel = providerName === config.providerName
        ? config.model
        : discovery.models.find((model) => model.isDefault)?.id ?? fallbackModel
      const modelOptions = discovery.models.map((model) => ({
        label: model.id === currentModel ? `${model.id} (current)` : model.id,
        detail: model.name ?? model.ownedBy ?? 'available model',
        value: model.id,
      }))
      const result = await pick(`Models for ${providerName} (${modelOptions.length})`, modelOptions, Math.max(0, modelOptions.findIndex((option) => option.value === currentModel)))
      if (result.type === 'select') {
        if (providerName === 'codex') activateCodexSubscription(result.value)
        else applyModelChoice(providerName, result.value)
      }
      else if (result.type === 'unavailable') writeNotice(`${providerName} exposes ${discovery.models.length} selectable model(s).`)
    }

    if (args.length === 0) {
      const selectableProviderNames = PROVIDER_PRESET_NAMES.filter((name) => name !== 'codex')
      const currentIndex = config.routingMode === 'auto'
        ? 0
        : config.providerName === 'codex'
          ? 1
          : selectableProviderNames.indexOf(config.providerName) + 2
      const options = [
        {
          label: config.routingMode === 'auto' ? 'auto (current)' : 'auto',
          detail: 'transparent fallback across every ready provider',
          value: 'auto',
        },
        {
          label: 'ChatGPT subscription (Codex)',
          detail: 'use your signed-in ChatGPT plan as Elia’s active model',
          value: 'codex-subscription',
        },
        ...selectableProviderNames.map((name) => ({
        label: name === config.providerName ? `${name} (current)` : name,
        detail: `${isProviderPresetConfigured(name) ? 'ready' : 'no key set'} · ${providerPresetDefaultModel(name) ?? 'custom'}`,
          value: name,
        })),
      ]
      const result = await pick('Switch model', options, Math.max(0, currentIndex))
      if (result.type === 'select') {
        if (result.value === 'auto') applyModelChoice('auto')
        else if (result.value === 'codex-subscription') {
          await chooseModelForProvider('codex')
        }
        else await chooseModelForProvider(result.value)
        return
      }
      if (result.type === 'unavailable') {
        const rows = [
          [config.routingMode === 'auto' ? `${gold('●')} auto` : '  auto', 'transparent fallback', dim(config.providerLabel)],
          ...PROVIDER_PRESET_NAMES.map((name) => [
            name === config.providerName && config.routingMode !== 'auto' ? `${gold('●')} ${name}` : `  ${name}`,
            isProviderPresetConfigured(name) ? 'ready' : dim('no key set'),
            dim(providerPresetDefaultModel(name) ?? ''),
          ]),
        ]
        for (const line of table([{ header: 'provider' }, { header: 'status' }, { header: 'default model' }], rows)) {
          writeUsageLine(`  ${line}`)
        }
        writeNotice(`Current: ${config.providerLabel}${config.routingMode === 'auto' ? ' · auto fallback on' : ''}. Use "/model auto" to enable transparent failover.`)
      }
      return
    }

    const [first, second] = args
    if (first === 'auto') applyModelChoice('auto')
    else if (first === 'codex') {
      if (second) activateCodexSubscription(second)
      else await chooseModelForProvider('codex')
    }
    else if (PROVIDER_PRESET_NAMES.includes(first!)) {
      if (second) applyModelChoice(first!, second)
      else await chooseModelForProvider(first!)
    } else applyModelChoice(config.providerName, first)
  }

  function applyThinkingChoice(arg: string): void {
    if (arg === 'off') {
      const result = switchThinking({ enabled: false, budgetTokens: 0 })
      if (!result.ok) writeError(result.error)
      else writeNotice(describeThinking())
      return
    }

    let budgetTokens: number
    if (arg === 'on') {
      const current = getThinking()
      budgetTokens = current.budgetTokens > 0 ? current.budgetTokens : DEFAULT_THINKING_BUDGET
    } else if (arg in THINKING_EFFORT_BUDGETS) {
      budgetTokens = THINKING_EFFORT_BUDGETS[arg as keyof typeof THINKING_EFFORT_BUDGETS]
    } else {
      const parsed = strictInteger(arg)
      if (parsed === undefined || parsed < 1024) {
        writeError('Usage: /thinking off|on|low|medium|high|<token budget ≥1024>')
        return
      }
      budgetTokens = parsed
    }

    const result = switchThinking({ enabled: true, budgetTokens })
    if (!result.ok) {
      writeError(result.error)
      return
    }
    writeNotice(describeThinking())
    if (config.providerName !== 'anthropic') {
      writeNotice(
        `Note: ${config.providerLabel} doesn't take a reasoning budget — this only controls whether elia displays reasoning it sends automatically.`,
      )
    }
  }

  async function handleThinkingCommand(argLine: string): Promise<void> {
    const arg = argLine.trim().toLowerCase()

    if (!arg) {
      const current = getThinking()
      const levels: { label: string; value: string; budget: number }[] = [
        { label: 'Off', value: 'off', budget: 0 },
        { label: 'Low', value: 'low', budget: THINKING_EFFORT_BUDGETS.low },
        { label: 'Medium', value: 'medium', budget: THINKING_EFFORT_BUDGETS.medium },
        { label: 'High', value: 'high', budget: THINKING_EFFORT_BUDGETS.high },
      ]
      const currentIndex = current.enabled ? levels.findIndex((level) => level.budget === current.budgetTokens) : 0
      const options = levels.map((level) => ({
        label: level.label,
        detail: level.budget > 0 ? `${level.budget.toLocaleString()} tokens` : undefined,
        value: level.value,
      }))
      const result = await pick('Reasoning effort', options, Math.max(0, currentIndex))
      if (result.type === 'select') applyThinkingChoice(result.value)
      else if (result.type === 'unavailable') writeNotice(describeThinking())
      return
    }

    applyThinkingChoice(arg)
  }

  const prompt = createSlashPrompt(REPL_COMMANDS)

  async function handleSkillsPicker(): Promise<void> {
    const { listLoadedSkills } = await import('./skills/loader.ts')
    const { listSkillBundles } = await import('./skills/bundles.ts')
    const { USER_SKILLS_DIR, PROJECT_SKILLS_DIR } = await import('./skills/paths.ts')
    const skills = listLoadedSkills()
    const bundles = listSkillBundles()
    if (skills.length === 0 && bundles.length === 0) {
      writeNotice(`No loaded skills. Add a validated *.skill.ts file to ${PROJECT_SKILLS_DIR} for this project or ${USER_SKILLS_DIR} for all projects, then restart Elia.`)
      return
    }

    const active = new Set(selectedSkillNames ?? skills.map((skill) => skill.name))
    const options = [
      { label: selectedSkillNames === undefined ? 'all loaded skills (current)' : 'all loaded skills', detail: 'make every loaded skill available', value: '__all__' },
      ...bundles.map((bundle) => ({
        label: active.has(bundle.name) ? `${bundle.name} (current)` : `${bundle.name} (bundle)`,
        detail: `${bundle.description ?? 'skill bundle'} · ${bundle.skills.join(', ')}`,
        value: `__bundle:${bundle.name}`,
      })),
      ...skills.map((skill) => ({
        label: active.has(skill.name) && active.size === 1 ? `${skill.name} (current)` : skill.name,
        detail: `${skill.source} · ${skill.file}`,
        value: skill.name,
      })),
    ]
    const result = await pick('Skills for subsequent turns', options)
    if (result.type !== 'select') return
    const selection = result.value as string
    selectedSkillNames = selection === '__all__' ? undefined : [selection.startsWith('__bundle:') ? selection.slice('__bundle:'.length) : selection]
    writeNotice(selectedSkillNames ? `Skill selection for subsequent turns: ${selectedSkillNames[0]}` : 'All loaded skills are available for subsequent turns.')
  }

  /** Shared by the "/cyber", "/sports", persona slash commands, and the /settings mode picker so both paths stay in sync. */
  function applyModePersonaChoice(choice: string): void {
    if (choice === 'cyber') {
      mode = 'cyber'
      persona = undefined
      writeNotice(
        'cyber mode on — elia will help with authorized security testing, vuln research, and CTFs. Only point it at systems you own or are explicitly authorized to test.',
      )
      return
    }
    if (choice === 'sports') {
      mode = 'sports'
      persona = undefined
      writeNotice('sports mode on — evidence-aware match, scouting, performance, league, event, and sports-business analysis.')
      return
    }
    if (choice === 'fitness') {
      mode = 'fitness'
      persona = undefined
      writeNotice('fitness mode on — conservative training, habit, recovery, and wellbeing support; not medical advice.')
      return
    }
    if (choice === 'battmann') {
      mode = 'battmann'
      persona = undefined
      writeNotice('Battmann mode on — strategic intelligence across trade, geopolitics, financial markets, supply chain, policy, and commodities. Every score and claim is sourced or labelled an estimate; elia surfaces intelligence, you decide.')
      return
    }
    if (choice === 'tech') {
      const hadSpecialist = persona !== undefined || mode !== 'dev'
      mode = 'dev'
      persona = undefined
      writeNotice(hadSpecialist ? "Tech and Dev are the same agent — back to dev mode." : 'dev mode remains active.')
      return
    }
    const requestedPersona = choice === 'cybersecurity' ? 'cyber' : choice
    if (isAgentPersona(requestedPersona)) {
      persona = requestedPersona
      writeNotice(`${persona.charAt(0).toUpperCase()}${persona.slice(1)} agent on — elia will answer in this persona until /mode dev.`)
      return
    }
    const hadSpecialist = persona !== undefined || mode !== 'dev'
    mode = 'dev'
    persona = undefined
    writeNotice(hadSpecialist ? 'Specialist mode/persona off — back to dev mode.' : 'dev mode remains active.')
  }

  const MODE_PERSONA_ENTRIES: { label: string; detail: string; value: string }[] = [
    { label: 'Dev', detail: "elia's development mode — building, debugging, testing, browser & task workflows", value: 'dev' },
    { label: 'Cyber', detail: 'authorized security testing, vuln research, CTFs', value: 'cyber' },
    { label: 'Sports', detail: 'evidence-aware sports intelligence and operations', value: 'sports' },
    { label: 'Fitness', detail: 'conservative fitness planning and wellbeing support', value: 'fitness' },
    { label: 'Battmann', detail: 'strategic risk intelligence — trade, geopolitics, markets, supply chain', value: 'battmann' },
    { label: 'Marketing', detail: 'Marketing agent persona', value: 'marketing' },
    { label: 'Finance', detail: 'Finance agent persona', value: 'finance' },
    { label: 'Business', detail: 'Business Analyst persona', value: 'business' },
    { label: 'Data', detail: 'Data Analyst persona', value: 'data' },
    { label: 'Research', detail: 'Research persona', value: 'research' },
    { label: 'Cybersecurity', detail: 'Cybersecurity persona', value: 'cybersecurity' },
    { label: 'Automation', detail: 'Automation persona', value: 'automation' },
    { label: 'Communications', detail: 'Communications persona', value: 'communications' },
    { label: 'AI / ML', detail: 'AI/ML persona', value: 'ai' },
    { label: 'Production', detail: 'Production Engineering persona', value: 'production' },
  ]

  async function handleModePersonaPicker(): Promise<void> {
    const currentValue = persona ? (persona === 'cyber' ? 'cybersecurity' : persona) : mode
    const currentIndex = Math.max(0, MODE_PERSONA_ENTRIES.findIndex((entry) => entry.value === currentValue))
    const options = MODE_PERSONA_ENTRIES.map((entry) => ({
      ...entry,
      label: entry.value === currentValue ? `${entry.label} (current)` : entry.label,
    }))
    const result = await pick('Mode / persona', options, currentIndex)
    if (result.type === 'select') applyModePersonaChoice(result.value)
    else if (result.type === 'unavailable') writeNotice(`Current: ${currentValue}`)
  }

  /** Set from the /settings risk-checks picker. */
  function applyReplModeChoice(value: 'auto' | 'manual'): void {
    replMode = value
    writeNotice(
      value === 'auto'
        ? 'Auto mode — preliminary risk checks are skipped. Safe work runs immediately; governed irreversible actions still require explicit approval. "/settings" → Risk checks to re-enable checks.'
        : 'Manual mode — elia flags risky commands and asks first; safe commands just run.',
    )
  }

  async function handleReplModePicker(): Promise<void> {
    const options = [
      { label: replMode === 'manual' ? 'Manual (current)' : 'Manual', detail: 'flags risky commands, asks before running them', value: 'manual' },
      { label: replMode === 'auto' ? 'Auto (current)' : 'Auto', detail: 'skips the pre-flight prompt; governed irreversible actions still require approval', value: 'auto' },
    ]
    const result = await pick('Risk checks', options, replMode === 'auto' ? 1 : 0)
    if (result.type === 'select') applyReplModeChoice(result.value as 'auto' | 'manual')
    else if (result.type === 'unavailable') writeNotice(`Current: ${replMode}`)
  }

  async function handleProviderSettings(): Promise<void> {
    const saved = savedProviderNames()
    const options = [
      { label: 'ChatGPT subscription (Codex)', detail: 'sign in now with your ChatGPT plan; no API key is copied into Elia', value: 'codex-login' },
      { label: 'Add or update provider', detail: 'enter a hidden API key and choose a model', value: 'add' },
      ...saved.map((provider) => ({ label: `Remove ${provider}`, detail: 'delete its saved API key', value: `remove:${provider}` })),
    ]
    const result = await pick('Provider connections', options)
    if (result.type === 'unavailable') {
      writeNotice(saved.length > 0 ? `Saved API providers: ${saved.join(', ')}. ChatGPT subscription sign-in: elia codex-login` : 'No saved API providers. ChatGPT subscription sign-in: elia codex-login')
      return
    }
    if (result.type !== 'select') return
    if (result.value === 'codex-login') {
      // pick() has released its key handler. The dormant REPL prompt does not
      // consume input, so the user-controlled Codex login can own the terminal.
      if (await runCodexLogin()) activateCodexSubscription()
      return
    }
    if (result.value === 'add') {
      const configured = await interactiveProviderSetup('settings')
      if (!configured) return
      const switched = switchModel({ providerName: configured.provider, model: configured.model })
      if (switched.ok) writeNotice(`Active model: ${switched.label} · ${configured.model}`)
      else writeError(`Saved the provider, but could not activate it in this session: ${switched.error}`)
      return
    }
    const provider = result.value.slice('remove:'.length)
    const confirmation = await confirmOnce(prompt, `Remove saved API credentials for ${provider}? This cannot be undone from Elia. [y]es / [n]o: `)
    if (confirmation.action !== 'approve') {
      writeNotice('Kept the saved provider credentials.')
      return
    }
    try {
      const removed = removeProviderConfiguration(provider)
      writeNotice(removed.removed ? `Removed saved credentials for ${provider}.` : `No saved credentials found for ${provider}.`)
      writeNotice('The API key value was never displayed.')
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
    }
  }

  /** Top-level settings screen: every switchable setting in one arrow-key menu, looping until esc/cancel. */
  async function handleSettingsCommand(): Promise<void> {
    while (true) {
      const options = [
        { label: 'Risk checks', detail: replMode, value: 'replMode' },
        { label: 'Model & provider', detail: `${config.providerLabel} · ${config.model}`, value: 'model' },
        { label: 'Provider connections', detail: `${savedProviderNames().length} API key(s) · ChatGPT subscription`, value: 'providers' },
        { label: 'Reasoning effort', detail: describeThinking(), value: 'thinking' },
        { label: 'Skills', detail: selectedSkillNames ? selectedSkillNames.join(', ') : 'all loaded', value: 'skills' },
      ]
      const result = await pick('Settings', options)
      if (result.type === 'unavailable') {
        for (const option of options) writeUsageLine(`  ${option.label}: ${option.detail}`)
        return
      }
      if (result.type !== 'select') return
      if (result.value === 'replMode') await handleReplModePicker()
      else if (result.value === 'model') await handleModelCommand('')
      else if (result.value === 'providers') await handleProviderSettings()
      else if (result.value === 'thinking') await handleThinkingCommand('')
      else if (result.value === 'skills') await handleSkillsPicker()
    }
  }

  /** Run a read-only command and return its stdout, or '' if it fails / isn't installed. */
  async function runShellQuiet(command: string): Promise<string> {
    try {
      const { runShell } = await import('./shell.ts')
      const result = await runShell(command, 15_000, process.cwd())
      return result.exitCode === 0 ? result.stdout : ''
    } catch {
      return ''
    }
  }

  async function handleSlashForInk(input: string): Promise<InkSlashOutcome> {
    const trimmed = input.trim()
    const done = (text?: string): InkSlashOutcome => ({ handled: true, text })

    // --- arrow-key pickers, now native to the Ink UI ---

    if (trimmed === '/model' || trimmed === '/provider') {
      const selectable = PROVIDER_PRESET_NAMES.filter((n) => n !== 'codex')
      const options = [
        { label: config.routingMode === 'auto' ? 'auto (current)' : 'auto', detail: 'transparent fallback across every ready provider', value: 'auto' },
        { label: 'ChatGPT subscription (Codex)', detail: 'use your signed-in ChatGPT plan', value: 'codex' },
        ...selectable.map((name) => ({
          label: name === config.providerName ? `${name} (current)` : name,
          detail: `${isProviderPresetConfigured(name) ? 'ready' : 'no key set'} · ${providerPresetDefaultModel(name) ?? 'custom'}`,
          value: name,
        })),
      ]
      return {
        handled: true,
        picker: {
          title: 'Switch model — provider',
          options,
          onSelect: async (provider) => {
            if (!provider) return
            if (provider === 'auto') {
              applyModelChoice('auto')
              return
            }
            const discovery = await listProviderModels(provider)
            if (discovery.models.length === 0) {
              const fallback = provider === config.providerName ? config.model : providerPresetDefaultModel(provider)
              if (provider === 'codex') activateCodexSubscription(fallback ?? 'default')
              else if (fallback) applyModelChoice(provider, fallback)
              else return `${provider}: no model list available — use /model ${provider} <model-id> in the classic prompt.`
              return
            }
            const current = provider === config.providerName ? config.model : discovery.models.find((m) => m.isDefault)?.id
            return {
              handled: true,
              picker: {
                title: `${provider} — model`,
                searchable: discovery.models.length > 8,
                initialIndex: Math.max(0, discovery.models.findIndex((m) => m.id === current)),
                options: discovery.models.map((m) => ({
                  label: m.id === current ? `${m.id} (current)` : m.id,
                  detail: m.name ?? m.ownedBy ?? 'available model',
                  value: m.id,
                })),
                onSelect: (modelId) => {
                  if (!modelId) return
                  if (provider === 'codex') activateCodexSubscription(modelId)
                  else applyModelChoice(provider, modelId)
                },
              },
            }
          },
        },
      }
    }

    const modeArg = /^\/mode(?:\s+(.+))?$/.exec(trimmed)
    if (modeArg) {
      if (modeArg[1]) {
        applyModePersonaChoice(modeArg[1].trim())
        return done()
      }
      const current = persona ? (persona === 'cyber' ? 'cybersecurity' : persona) : mode
      return {
        handled: true,
        picker: {
          title: 'Mode / persona',
          initialIndex: Math.max(0, MODE_PERSONA_ENTRIES.findIndex((e) => e.value === current)),
          options: MODE_PERSONA_ENTRIES.map((e) => ({
            label: e.value === current ? `${e.label} (current)` : e.label,
            detail: e.detail,
            value: e.value,
          })),
          onSelect: (value) => {
            if (value) applyModePersonaChoice(value)
          },
        },
      }
    }

    const thinkingArg = /^\/thinking(?:\s+(.+))?$/.exec(trimmed)
    if (thinkingArg) {
      if (thinkingArg[1]) {
        applyThinkingChoice(thinkingArg[1].trim().toLowerCase())
        return done()
      }
      const levels = [
        { label: 'Off', value: 'off', detail: 'no reasoning' },
        { label: 'Low', value: 'low', detail: `${THINKING_EFFORT_BUDGETS.low.toLocaleString()} tokens` },
        { label: 'Medium', value: 'medium', detail: `${THINKING_EFFORT_BUDGETS.medium.toLocaleString()} tokens` },
        { label: 'High', value: 'high', detail: `${THINKING_EFFORT_BUDGETS.high.toLocaleString()} tokens` },
      ]
      return {
        handled: true,
        picker: {
          title: 'Reasoning effort',
          options: levels,
          onSelect: (value) => {
            if (value) applyThinkingChoice(value)
          },
        },
      }
    }

    if (trimmed === '/settings') {
      return {
        handled: true,
        picker: {
          title: 'Settings',
          options: [
            { label: 'Risk checks', detail: replMode, value: 'risk' },
            { label: 'Model & provider', detail: `${config.providerLabel} · ${config.model}`, value: 'model' },
            { label: 'Reasoning effort', detail: describeThinking(), value: 'thinking' },
            { label: 'Mode / persona', detail: persona ?? mode, value: 'mode' },
          ],
          onSelect: (value) => {
            if (value === 'risk') {
              return {
                handled: true,
                picker: {
                  title: 'Risk checks',
                  options: [
                    { label: replMode === 'manual' ? 'Manual (current)' : 'Manual', detail: 'flag risky commands, ask first', value: 'manual' },
                    { label: replMode === 'auto' ? 'Auto (current)' : 'Auto', detail: 'skip the pre-flight prompt; governor still gates critical actions', value: 'auto' },
                  ],
                  onSelect: (v) => {
                    if (v === 'manual' || v === 'auto') applyReplModeChoice(v)
                  },
                },
              }
            }
            if (value === 'model') return handleSlashForInk('/model')
            if (value === 'thinking') return handleSlashForInk('/thinking')
            if (value === 'mode') return handleSlashForInk('/mode')
          },
        },
      }
    }

    if (trimmed === '@skills' || trimmed === '/skills') {
      const { listLoadedSkills } = await import('./skills/loader.ts')
      const skills = listLoadedSkills()
      if (skills.length === 0) return done('No loaded skills.')
      return {
        handled: true,
        picker: {
          title: 'Skills for subsequent turns',
          searchable: skills.length > 8,
          options: [
            { label: selectedSkillNames === undefined ? 'all loaded skills (current)' : 'all loaded skills', detail: 'every loaded skill available', value: '__all__' },
            ...skills.map((s) => ({ label: s.name, detail: `${s.source} · ${s.file}`, value: s.name })),
          ],
          onSelect: (value) => {
            if (!value) return
            selectedSkillNames = value === '__all__' ? undefined : [value]
            return selectedSkillNames ? `Skills: ${selectedSkillNames[0]}` : 'All loaded skills available.'
          },
        },
      }
    }

    const artifactArg = /^\/artifacts?(?:\s+(.+))?$/.exec(trimmed)
    if (artifactArg) {
      const { listArtifacts, readArtifact } = await import('./autonomy/artifacts.ts')
      const view = (name: string): InkSlashOutcome => {
        const a = readArtifact(name)
        return done(a ? `── ${name} ──\n${a.content}` : `No artifact matches "${name}".`)
      }
      if (artifactArg[1]) return view(artifactArg[1].trim())
      const artifacts = listArtifacts()
      if (artifacts.length === 0) return done('No artifacts yet.')
      return {
        handled: true,
        picker: {
          title: `Artifacts (${artifacts.length})`,
          searchable: artifacts.length > 8,
          options: artifacts.map((a) => ({ label: a.name, detail: `${new Date(a.updatedAt).toLocaleString()} · ${Math.max(1, Math.round(a.sizeBytes / 1024))} KB`, value: a.name })),
          onSelect: (value) => (value ? view(value) : undefined),
        },
      }
    }

    if (trimmed === '/task' || trimmed === '/tasks') {
      const list = taskSessions.list()
      if (list.length === 0) return done('No tasks yet this session.')
      return done(
        list
          .slice(-20)
          .map((t) => `${t.status.padEnd(8)} ${t.role ? `${t.role} · ` : ''}${t.title} — ${t.action}`)
          .join('\n'),
      )
    }

    if (trimmed === '/sessions' || trimmed === '/session') {
      const { listKnownSessions } = await import('./sessionRegistry.ts')
      const others = listKnownSessions().filter((s) => s.sessionId !== sessionId)
      if (others.length === 0) return done('No other elia sessions in this project.')
      return done(
        others
          .map((s) => `${s.sessionId} · ${s.model} · ${s.busy ? 'working' : 'idle'} · ${s.lastAction}`)
          .join('\n'),
      )
    }

    // --- text-only commands ---

    if (trimmed === '/help' || trimmed === '/?') {
      return { handled: true, text: REPL_COMMANDS.map((c) => `${c.name}  —  ${c.description}`).join('\n') }
    }
    if (trimmed === '/status') {
      return { handled: true, text: renderWorkspacePanel({ sessionId, mode, providerLabel: config.providerLabel, model: config.model }) }
    }
    if (trimmed === '/team') return { handled: true, text: renderTeamStatus() }
    const expandMatch = /^\/expand(?:\s+(\d+))?$/.exec(trimmed)
    if (expandMatch) {
      const total = sessionTranscript.toolCount()
      if (total === 0) return { handled: true, text: 'No tool output recorded yet this session.' }
      const item = expandMatch[1] ? sessionTranscript.tool(Number.parseInt(expandMatch[1], 10) - 1) : sessionTranscript.tool()
      if (!item) return { handled: true, text: `No tool call ${expandMatch[1]}. This session has ${total}.` }
      return { handled: true, text: `⎿ ${item.name} · full output (${item.status})\n${colorizeDiffBlock(item.result)}` }
    }
    if (trimmed === '/cost') {
      const { sessionUsageSnapshot, estimateCostUsd, formatCostUsd, formatTokenCount, formatElapsed } = await import('./usage.ts')
      const s = sessionUsageSnapshot()
      return {
        handled: true,
        text: [
          `input       ${formatTokenCount(s.usage.inputTokens)}`,
          `output      ${formatTokenCount(s.usage.outputTokens)}`,
          `cache read  ${formatTokenCount(s.usage.cacheReadTokens)}`,
          `cache write ${formatTokenCount(s.usage.cacheWriteTokens)}`,
          `turns       ${s.turns}`,
          `elapsed     ${formatElapsed(s.elapsedMs)}`,
          `est. cost   ${formatCostUsd(estimateCostUsd(config.model, s.usage))} (${config.model})`,
        ].join('\n'),
      }
    }
    const exportMatch = /^\/export(?:\s+(.+))?$/.exec(trimmed)
    if (exportMatch) {
      const target = exportMatch[1]?.trim() || `.elia/exports/${sessionId}-${Date.now()}.md`
      try {
        await Bun.write(target, sessionTranscript.toMarkdown(`elia session ${sessionId}`))
        return { handled: true, text: `Exported ${sessionTranscript.turns()} turn(s) to ${target}` }
      } catch (error) {
        return { handled: true, text: `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (trimmed === 'rewind' || trimmed === '/rewind') {
      return { handled: true, text: renderCheckpointList(checkpoints) }
    }
    const rewindN = /^\/?rewind\s+(\d+)$/.exec(trimmed)
    if (rewindN) {
      const n = Number.parseInt(rewindN[1]!, 10)
      const checkpoint = checkpoints[n]
      if (!checkpoint) return done(`No rewind point ${n}. Type /rewind to list them.`)
      const result = await restoreCheckpoint(checkpoint)
      messages.length = 0
      messages.push(...checkpoint.messagesBefore)
      checkpoints.length = n
      await saveCheckpoints(sessionId, checkpoints)
      await saveSession(sessionId, messages)
      return done(`Rewound to before turn ${n} ("${checkpoint.label}") — restored ${result.restored} file(s), removed ${result.deleted}.`)
    }
    if (trimmed === '/capabilities') {
      return done(CAPABILITIES.map((c) => `${c.label} [${c.persona}] · risk: ${c.risk} · ${c.summary}`).join('\n'))
    }
    const whyMatch = /^\/why(?:\s+(.+))?$/.exec(trimmed)
    if (whyMatch) {
      const { explainRationale } = await import('./autonomy/rationale.ts')
      return done(whyMatch[1] ? explainRationale(whyMatch[1].trim()) : 'Usage: /why <path or topic>')
    }
    if (trimmed === '/lessons') {
      const { renderLessons } = await import('./autonomy/lessons.ts')
      const rendered = renderLessons()
      return done(rendered.trim() || 'No lessons recorded for this project yet.')
    }
    const brainMatch = /^\/brain(?:\s+(.+))?$/.exec(trimmed)
    if (brainMatch) {
      const { runBrainCommand } = await import('./brain/command.ts')
      return done(await runBrainCommand(brainMatch[1] ?? ''))
    }
    if (trimmed === '/track') {
      const { renderCompetence } = await import('./autonomy/outcomes.ts')
      return done(renderCompetence())
    }

    if (trimmed === '/skills' || trimmed === '@skills-list') {
      const { listLoadedSkills } = await import('./skills/loader.ts')
      const skills = listLoadedSkills()
      if (skills.length === 0) return done('No skills loaded. Add a *.skill.ts file to .elia/skills, or find one with /marketplace.')
      return done(['Loaded skills:', ...skills.map((s) => `  ${s.name}  (${s.source} · ${s.file})`)].join('\n'))
    }

    const marketMatch = /^\/marketplace(?:\s+([a-z]+)?\s*(.*))?$/.exec(trimmed)
    if (marketMatch) {
      const { marketplaceOutcome } = await import('./marketplace/slash.ts')
      return marketplaceOutcome(marketMatch[1], marketMatch[2]?.trim() || undefined)
    }

    if (trimmed === '/packages') {
      const { listInstalled, removeCommand, parsePipList } = await import('./marketplace/registry.ts')
      let items = listInstalled(process.cwd())
      const pip = await runShellQuiet('pip list --format=json')
      if (pip) items = [...items, ...parsePipList(pip)]
      if (items.length === 0) return done('Nothing installed to show (no package.json deps, skills, or pip packages found).')
      return {
        handled: true,
        picker: {
          title: `Installed (${items.length}) — select to remove`,
          searchable: items.length > 8,
          options: items.map((i) => ({ label: `${i.name}`, detail: `${i.kind} · ${i.detail}`, value: `${i.kind}:${i.name}` })),
          onSelect: async (value) => {
            if (!value) return
            const item = items.find((i) => `${i.kind}:${i.name}` === value)
            if (!item) return
            if (item.kind === 'skill' && item.file) {
              return { handled: true, runCommand: { command: process.platform === 'win32' ? `del "${item.file}"` : `rm "${item.file}"`, description: `Delete skill "${item.name}" (${item.file})` } }
            }
            const cmd = removeCommand(item, process.cwd())
            return cmd ? { handled: true, runCommand: { command: cmd, description: `Uninstall ${item.name} (${item.kind}) — removes it from disk` } } : `Cannot remove ${item.name}.`
          },
        },
      }
    }
    const mcpMatch = /^\/mcp(?:\s+(.+))?$/.exec(trimmed)
    if (mcpMatch) {
      const { mcpManageOutcome } = await import('./mcp/slash.ts')
      return mcpManageOutcome(mcpMatch[1] ?? '', false)
    }
    const connectorMatch = /^\/connectors?(?:\s+(.+))?$/.exec(trimmed)
    if (connectorMatch) {
      const { mcpManageOutcome } = await import('./mcp/slash.ts')
      return mcpManageOutcome(connectorMatch[1] ?? '', true)
    }

    const verifyMatch = /^\/verify(?:\s+(on|off))?$/.exec(trimmed)
    if (verifyMatch) {
      if (verifyMatch[1]) {
        autoVerify = verifyMatch[1] === 'on'
        return done(`Automatic post-turn verification ${autoVerify ? 'on' : 'off'}.`)
      }
      const { detectChecks } = await import('./autonomy/detectChecks.ts')
      const { runVerification, describeVerification } = await import('./autonomy/verify.ts')
      const checks = detectChecks(process.cwd())
      if (checks.length === 0) return done('No project checks detected (looked for package.json scripts, Cargo.toml, go.mod, pytest).')
      const outcome = await runVerification(checks, process.cwd())
      return done(`${outcome.passed ? '✓ all checks pass' : '✗ checks failing'}\n${describeVerification(outcome)}`)
    }

    return done(`Unknown command: ${trimmed.split(/\s+/)[0]}. Type /help for the list.`)
  }

  if (interactiveTerminal) {
    const { runInkRepl } = await import('./ui/app/index.tsx')
    const greeting =
      mode === 'dev'
        ? 'dev mode — building, debugging, testing, browser & task workflows. Type a prompt, "/" for commands, "!" to run a shell command.'
        : `${mode} mode. Type a prompt, "/" for commands, "!" to run a shell command.`

    await runInkRepl({
      sessionId,
      getEnv: () => ({ model: config.model, providerLabel: config.providerLabel, providerName: config.providerName }),
      commands: REPL_COMMANDS,
      initialReplMode: replMode,
      messages,
      greeting,
      classifyRisk: (command) => classifyCommandRisk(command),
      runShellLine: async (command) => {
        const { runShell, formatShellResult, clampOutput } = await import('./shell.ts')
        const result = await runShell(command, undefined, process.cwd())
        const rendered = clampOutput(formatShellResult(result), 8_000)
        sessionTranscript.shell(command, rendered)
        carriedShellContext.push(`<local-command>${command}</local-command>\n<output>\n${clampOutput(formatShellResult(result), 4_000)}\n</output>`)
        return rendered
      },
      handleSlash: handleSlashForInk,
      submitTurn: async (text, hooks) => {
        const turnText = carriedShellContext.length > 0
          ? `${carriedShellContext.splice(0).join('\n\n')}\n\n${text}`
          : text
        await runCheckpointedTurn(
          turnText,
          async (assessment, request) =>
            hooks.approve(
              `Approve ${request.name}?`,
              [
                redactText(assessment.reason, 300),
                `risk: ${assessment.risk} · reversible: ${assessment.reversible ? 'yes' : 'no'}`,
              ],
              approvalPreviewLines(request.name, request.input),
            ),
          undefined,
          {
            onText: hooks.onText,
            onThinking: hooks.onThinking,
            onActivity: hooks.onActivity,
            onTool: hooks.onTool,
            onToolStart: hooks.onToolStart,
            signal: hooks.signal,
            drainSteering: hooks.drainSteering,
          },
        )
        await saveSession(sessionId, messages)
      },
    })
    prompt.close()
    return
  }

  while (true) {
    const label = persona ? `${dim(`[${persona}]`)} ` : mode !== 'dev' ? `${dim(`[${mode}]`)} ` : ''
    const line = await prompt.question(`${label}${gold('❯')} `)
    if (line === null) break // stdin closed (EOF)

    const trimmed = line.trim()
    if (trimmed === 'exit' || trimmed === 'quit') break
    if (trimmed === '') continue

    // !cmd — run a shell command now, print its output, and carry it into the
    // next turn as context. No model round-trip.
    if (trimmed.startsWith('!')) {
      const command = trimmed.slice(1).trim()
      if (!command) continue
      if (replMode === 'manual') {
        const { risky, reason } = await classifyCommandRisk(command)
        if (risky) {
          const decision = await confirmOnce(prompt, `${reason ? `${redactText(reason, 500)}\n` : ''}About to run: "${redactText(command, 500)}" — run it? [y]es / [n]o: `)
          if (decision.action !== 'approve') {
            writeNotice('Skipped.')
            continue
          }
        }
      }
      const { runShell, formatShellResult, clampOutput } = await import('./shell.ts')
      const shellResult = await runShell(command, undefined, process.cwd())
      const rendered = clampOutput(formatShellResult(shellResult), 8_000)
      process.stdout.write(`${dim(`$ ${command}`)}\n${rendered}\n`)
      sessionTranscript.shell(command, rendered)
      carriedShellContext.push(`<local-command>${command}</local-command>\n<output>\n${clampOutput(formatShellResult(shellResult), 4_000)}\n</output>`)
      continue
    }

    // /expand [n] — reprint a tool result that scrollback folded.
    const expandMatch = /^\/expand(?:\s+(\d+))?$/.exec(trimmed)
    if (expandMatch) {
      const toolTotal = sessionTranscript.toolCount()
      if (toolTotal === 0) {
        writeNotice('No tool output has been recorded yet this session.')
        continue
      }
      const item = expandMatch[1]
        ? sessionTranscript.tool(Number.parseInt(expandMatch[1], 10) - 1)
        : sessionTranscript.tool()
      if (!item) {
        writeNotice(`No tool call ${expandMatch[1]}. This session has ${toolTotal}.`)
        continue
      }
      process.stdout.write(`${dim(`⎿ ${item.name} · full output (${item.status})`)}\n${colorizeDiffBlock(item.result)}\n`)
      continue
    }

    // /status — the full workspace panel, on demand.
    if (trimmed === '/status') {
      process.stdout.write(`${renderWorkspacePanel({ sessionId, mode, providerLabel: config.providerLabel, model: config.model })}\n`)
      continue
    }
    if (trimmed === '/team') {
      process.stdout.write(`${renderTeamStatus()}\n`)
      continue
    }

    // /cost — session token and estimated-dollar breakdown.
    if (trimmed === '/cost') {
      const { sessionUsageSnapshot } = await import('./usage.ts')
      const { estimateCostUsd, formatCostUsd, formatTokenCount, formatElapsed } = await import('./usage.ts')
      const snap = sessionUsageSnapshot()
      const rows: string[][] = [
        ['input', formatTokenCount(snap.usage.inputTokens)],
        ['output', formatTokenCount(snap.usage.outputTokens)],
        ['cache read', formatTokenCount(snap.usage.cacheReadTokens)],
        ['cache write', formatTokenCount(snap.usage.cacheWriteTokens)],
        ['turns', String(snap.turns)],
        ['elapsed', formatElapsed(snap.elapsedMs)],
        ['est. cost', `${formatCostUsd(estimateCostUsd(config.model, snap.usage))} (${config.model})`],
      ]
      for (const costLine of table([{ header: 'metric' }, { header: 'value', align: 'right' }], rows)) writeUsageLine(`  ${costLine}`)
      continue
    }

    // /export [path] — write the whole conversation to Markdown.
    const exportMatch = /^\/export(?:\s+(.+))?$/.exec(trimmed)
    if (exportMatch) {
      const target = exportMatch[1]?.trim() || `.elia/exports/${sessionId}-${Date.now()}.md`
      try {
        await Bun.write(target, sessionTranscript.toMarkdown(`elia session ${sessionId}`))
        writeNotice(`Exported ${sessionTranscript.turns()} turn(s) to ${target}`)
      } catch (error) {
        writeError(`Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }

    if (trimmed === '@skills') {
      await handleSkillsPicker()
      continue
    }

    if (trimmed === '/capabilities') {
      for (const capability of CAPABILITIES) {
        writeUsageLine(`${capability.label} [${capability.persona}] · risk: ${capability.risk} · ${capability.summary}`)
        writeUsageLine(`  output: ${capability.outputContract.join('; ')}`)
      }
      continue
    }
    if (trimmed === '/settings') {
      await handleSettingsCommand()
      continue
    }
    const whyClassic = /^\/why(?:\s+(.+))?$/.exec(trimmed)
    if (whyClassic) {
      const { explainRationale } = await import('./autonomy/rationale.ts')
      writeUsageLine(whyClassic[1] ? explainRationale(whyClassic[1].trim()) : 'Usage: /why <path or topic>')
      continue
    }
    if (trimmed === '/lessons') {
      const { renderLessons } = await import('./autonomy/lessons.ts')
      writeUsageLine(renderLessons().trim() || 'No lessons recorded for this project yet.')
      continue
    }
    const brainClassic = /^\/brain(?:\s+(.+))?$/.exec(trimmed)
    if (brainClassic) {
      const { runBrainCommand } = await import('./brain/command.ts')
      writeUsageLine(await runBrainCommand(brainClassic[1] ?? ''))
      continue
    }
    if (trimmed === '/track') {
      const { renderCompetence } = await import('./autonomy/outcomes.ts')
      writeUsageLine(renderCompetence())
      continue
    }
    if (trimmed === '/skills') {
      const { listLoadedSkills } = await import('./skills/loader.ts')
      const skills = listLoadedSkills()
      writeUsageLine(skills.length === 0 ? 'No skills loaded.' : ['Loaded skills:', ...skills.map((s) => `  ${s.name}  (${s.source})`)].join('\n'))
      continue
    }
    const marketClassic = /^\/marketplace(?:\s+(npm|bun|pip)\s+(.+))?$/.exec(trimmed)
    if (marketClassic) {
      if (!marketClassic[1]) {
        writeNotice('Usage: /marketplace <npm|pip> <query> — then run the printed install command. Full browse/install UI is in the interactive terminal.')
        continue
      }
      const { searchMarket, installCommand } = await import('./marketplace/registry.ts')
      try {
        const results = await searchMarket(marketClassic[1] as PackageKind, marketClassic[2]!)
        if (results.length === 0) writeNotice('Nothing found.')
        else {
          for (const r of results.slice(0, 12)) writeUsageLine(`  ${r.name}${r.version ? `@${r.version}` : ''}  ${(r.description ?? '').slice(0, 70)}`)
          writeNotice(`Install with: ${installCommand(marketClassic[1] as PackageKind, results[0]!.name)}`)
        }
      } catch (error) {
        writeError(`Search failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    if (trimmed === '/packages') {
      const { listInstalled } = await import('./marketplace/registry.ts')
      const items = listInstalled(process.cwd())
      writeUsageLine(items.length === 0 ? 'Nothing installed to show.' : items.map((i) => `  ${i.kind.padEnd(6)} ${i.name}  ${i.detail}`).join('\n'))
      writeNotice('Remove packages interactively from the new terminal UI, or with the usual uninstall command.')
      continue
    }
    const mcpClassic = /^\/(mcp|connectors?)(?:\s+(reload))?$/.exec(trimmed)
    if (mcpClassic) {
      const connectorsOnly = mcpClassic[1] !== 'mcp'
      const { mcpStatusReport, reloadMcpTools } = await import('./mcp/registry.ts')
      const report = mcpClassic[2] === 'reload' ? await reloadMcpTools(process.cwd()) : mcpStatusReport()
      const rows = (connectorsOnly ? report.status.filter((s) => s.connector) : report.status)
      if (rows.length === 0) writeNotice(`No ${connectorsOnly ? 'connectors' : 'MCP servers'} configured. Add one from the interactive terminal: /${connectorsOnly ? 'connector' : 'mcp'}.`)
      else writeUsageLine(rows.map((s) => `  ${s.connected ? '●' : '○'} ${s.name}  ${s.transport}${s.connector ? ' connector' : ''}  ${s.disabled ? 'disabled' : s.connected ? `${s.toolCount} tool(s)` : s.error ?? 'offline'}`).join('\n'))
      writeNotice('Add / test / enable / disable / remove interactively in the new terminal UI.')
      continue
    }
    const verifyClassic = /^\/verify(?:\s+(on|off))?$/.exec(trimmed)
    if (verifyClassic) {
      if (verifyClassic[1]) {
        autoVerify = verifyClassic[1] === 'on'
        writeNotice(`Automatic post-turn verification ${autoVerify ? 'on' : 'off'}.`)
        continue
      }
      const { detectChecks } = await import('./autonomy/detectChecks.ts')
      const { runVerification, describeVerification } = await import('./autonomy/verify.ts')
      const checks = detectChecks(process.cwd())
      if (checks.length === 0) writeNotice('No project checks detected.')
      else {
        const outcome = await runVerification(checks, process.cwd())
        writeUsageLine(`${outcome.passed ? '✓ all checks pass' : '✗ checks failing'}\n${describeVerification(outcome)}`)
      }
      continue
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(trimmed)
    if (modelMatch) {
      await handleModelCommand(modelMatch[1]?.trim() ?? '')
      continue
    }

    const thinkingMatch = /^\/thinking(?:\s+(.*))?$/.exec(trimmed)
    if (thinkingMatch) {
      await handleThinkingCommand(thinkingMatch[1]?.trim() ?? '')
      continue
    }

    if (trimmed === '/task' || trimmed.startsWith('/task ')) {
      const taskId = trimmed.slice('/task'.length).trim() || undefined
      await openTaskDashboard(taskSessions, taskId)
      continue
    }

    if (trimmed === '/sessions' || trimmed === '/session') {
      const { openSessionsDashboard } = await import('./ui/sessionsDashboard.ts')
      pushHeartbeat(false, 'Browsing /sessions')
      await openSessionsDashboard(sessionId)
      continue
    }

    const artifactMatch = /^\/artifacts?(?:\s+(.*))?$/.exec(trimmed)
    if (artifactMatch) {
      const { listArtifacts, readArtifact } = await import('./autonomy/artifacts.ts')
      const target = artifactMatch[1]?.trim()

      const viewArtifact = async (name: string): Promise<void> => {
        const artifact = readArtifact(name)
        if (!artifact) {
          writeError(`No artifact matches "${name}". Run /artifact to list them.`)
          return
        }
        const { createMarkdownStream } = await import('./ui/markdown.ts')
        const markdown = createMarkdownStream()
        process.stdout.write(`\n${markdown.push(artifact.content)}${markdown.flush()}\n`)
      }

      if (target) {
        await viewArtifact(target)
        continue
      }

      const artifacts = listArtifacts()
      if (artifacts.length === 0) {
        writeNotice('No artifacts yet — approve a plan in "elia auto" to save one to .elia/artifacts.')
        continue
      }

      const options = artifacts.map((artifact) => ({
        label: artifact.name,
        detail: `${new Date(artifact.updatedAt).toLocaleString()} · ${Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB`,
        value: artifact.name,
      }))
      const result = await pick(`Artifacts (${artifacts.length})`, options, 0, { searchable: true })
      if (result.type === 'select') {
        await viewArtifact(result.value)
      } else if (result.type === 'unavailable') {
        // Not an interactive terminal (piped/scripted) — the picker can't render, so fall back to a plain listing.
        const rows = table(
          [{ header: 'name' }, { header: 'updated' }, { header: 'size', align: 'right' }],
          artifacts.slice(0, 15).map((artifact) => [artifact.name, new Date(artifact.updatedAt).toLocaleString(), `${Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB`]),
        )
        process.stdout.write(`\n${rows.join('\n')}\n`)
        writeUsageLine('/artifact <name> to view one, e.g. /artifact plan')
      }
      continue
    }

    const modeMatch = /^\/mode(?:\s+(.*))?$/.exec(trimmed)
    if (modeMatch) {
      const modeArg = modeMatch[1]?.trim()
      if (!modeArg) await handleModePersonaPicker()
      else applyModePersonaChoice(modeArg)
      continue
    }

    if (trimmed === 'rewind' || trimmed === '/rewind') {
      writeNotice(renderCheckpointList(checkpoints))
      continue
    }

    const rewindMatch = /^\/?rewind\s+(\d+)$/.exec(trimmed)
    if (rewindMatch) {
      const n = Number.parseInt(rewindMatch[1]!, 10)
      const checkpoint = checkpoints[n]
      if (!checkpoint) {
        writeNotice(`No rewind point ${n}. Type "rewind" to list them.`)
        continue
      }
      const result = await restoreCheckpoint(checkpoint)
      messages.length = 0
      messages.push(...checkpoint.messagesBefore)
      checkpoints.length = n // later rewind points described a future that no longer exists
      await saveCheckpoints(sessionId, checkpoints)
      await saveSession(sessionId, messages)
      writeNotice(
        `Rewound to before turn ${n} ("${checkpoint.label}") — restored ${result.restored} file(s), removed ${result.deleted} file(s) created since.`,
      )
      continue
    }

    let commandToRun = trimmed
    if (replMode === 'manual') {
      const { risky, reason } = await classifyCommandRisk(commandToRun)
      if (risky) {
        const label = `${reason ? `${redactText(reason, 500)}\n` : ''}About to: "${redactText(commandToRun, 500)}" — run it? [y]es / [n]o / [e]dit: `
        const result = await confirmOnce(prompt, label)
        if (result.action === 'reject') {
          writeNotice('Skipped.')
          continue
        }
        if (result.action === 'amend') commandToRun = result.feedback
      }
    }

    const turnText = carriedShellContext.length > 0
      ? `${carriedShellContext.splice(0).join('\n\n')}\n\n${commandToRun}`
      : commandToRun
    try {
      await runCheckpointedTurn(turnText, async (assessment, request) => {
        const result = await confirmOnce(prompt, actionApprovalPrompt(assessment, request))
        return result.action === 'approve'
      })
    } catch (err) {
      writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
    await saveSession(sessionId, messages)
    const taskSummary = renderTaskSummary(taskSessions)
    const contextLine = renderContextStatus(messages, await countEpisodes(sessionId))
    const { formatCompactUsage } = await import('./usage.ts')
    writeUsageLine([contextLine, dim(formatCompactUsage(config.model)), taskSummary ? dim(taskSummary) : ''].filter(Boolean).join('  ·  '))
    // The full workspace panel is shown once at startup and on demand via
    // /status — reprinting all 14 lines after every turn buried the conversation.
  }

  prompt.close()
  // The registerShutdownCleanup callback registered above already writes the
  // "ended" heartbeat for this and every other exit path — no separate call
  // needed here.
  if (messages.length > 0 && !machineReadable) process.stdout.write(`${box([getSessionSummaryLine(config.model)])}\n`)
  await printTurnProfileReport()
  if (messages.length > 0 && !machineReadable) writeNotice(`Resume this session later with: elia --resume ${sessionId}`)
  writeNotice('Goodbye!')
}

async function main() {
  installShutdownHandlers()
  emitEvent('cli_started', { version: JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text()).version, uiMode: machineReadable ? 'json' : plainOutput ? 'plain' : 'normal' })
  const { flushUsageStats } = await import('./skills/detector.ts')
  // Process-exit handlers must be synchronous, so the flush is registered here,
  // after the module is already loaded.
  process.on('exit', flushUsageStats)

  await taskSessions.load()
  updateTerminalTaskTitle(taskSessions)
  taskSessions.subscribe(() => updateTerminalTaskTitle(taskSessions))

  switch (subcommand) {
    case 'auto':
      return runAuto()
    case 'agent':
      return runAgentCommand()
    case 'evolve':
      return runEvolve()
    case 'bench':
      return runBench()
    case 'skills':
      return runSkills()
    case 'runs':
      return runRuns()
    case 'fork':
      return runFork()
    case 'resume':
      return runResume()
    case 'schedule':
      return runSchedule()
    case 'daemon':
      return runDaemon()
    case 'config':
      return runConfig()
    case 'codex-login':
      await runCodexLogin()
      return
    case 'control':
      return runControl()
    case 'bridge': {
      if (hasFlag('--http')) {
        const portRaw = flagValue('--port') ?? '4319'
        const port = strictInteger(portRaw)
        if (port === undefined || port < 1 || port > 65535) {
          writeError('--port must be an integer between 1 and 65535')
          process.exitCode = 1
          return
        }
        const hostname = flagValue('--host')
        const { runHttpBridge } = await import('./bridgeHttp.ts')
        return runHttpBridge({ port, hostname })
      }
      const { runVscodeBridge } = await import('./vscodeBridge.ts')
      return runVscodeBridge()
    }
    default:
      return runInteractive()
  }
}

// Load ~/.elia/config.env before any command imports provider configuration. Explicit
// project/process environment values already present in process.env take precedence.
loadUserConfig()

// Signal handlers are installed by installShutdownHandlers() so every terminal
// component follows one cleanup path and returns a conventional interrupt code.

await main().catch((err: unknown) => {
  writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}).finally(async () => {
  const { shutdownMcpTools } = await import('./mcp/registry.ts')
  await shutdownMcpTools()
})
