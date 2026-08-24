#!/usr/bin/env bun
import * as readline from 'node:readline/promises'
import type { ConversationMessage, AgentMode } from './agent.ts'
import { writeNotice, writeError, writeUsageLine } from './ui/stream.ts'
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
import { emitEvent, machineReadable, plainOutput, quietOutput } from './ui/runtime.ts'
import { installShutdownHandlers, registerShutdownCleanup } from './ui/shutdown.ts'
import { redactText } from './ui/redact.ts'
import { loadUserConfig, userConfigPath, writeUserConfig } from './userConfig.ts'

const REPL_COMMANDS: SlashCommand[] = [
  { name: '/capabilities', description: 'list specialist capabilities, risk classes, and output contracts' },
  { name: '/cyber', description: 'switch to cyber mode — authorized security testing, vuln research, CTFs' },
  { name: '/sports', description: 'switch to Sports mode — evidence-aware sports intelligence and operations' },
  { name: '/fitness', description: 'switch to Fitness mode — conservative fitness planning and wellbeing support' },
  { name: '/marketing', description: 'switch to the Marketing agent persona for this session' },
  { name: '/finance', description: 'switch to the Finance agent persona for this session' },
  { name: '/business', description: 'switch to the Business Analyst persona for this session' },
  { name: '/data', description: 'switch to the Data Analyst persona for this session' },
  { name: '/research', description: 'switch to the Research persona for this session' },
  { name: '/cybersecurity', description: 'switch to the Cybersecurity persona for this session' },
  { name: '/automation', description: 'switch to the Automation persona for this session' },
  { name: '/communications', description: 'switch to the Communications persona for this session' },
  { name: '/ai', description: 'switch to the AI/ML persona for this session' },
  { name: '/production', description: 'switch to the Production Engineering persona for this session' },
  { name: '/tech', description: 'switch to the Tech agent persona for this session' },
  { name: '/dev', description: "switch back to elia's development mode" },
  { name: '/mode', description: '/mode manual (default) asks only for risky commands, /mode auto never asks' },
  { name: '/rewind', description: 'list rewind points (add a number to restore one, e.g. /rewind 2)' },
  { name: '/model', description: 'pick a model with arrow keys, or /model groq, /model claude-opus-5' },
  { name: '/thinking', description: 'pick reasoning effort with arrow keys, or /thinking off/low/medium/high/<n>' },
  { name: '/task', description: 'browse browser, coding, and pending tasks with arrow keys' },
  { name: '/settings', description: 'browse every setting — mode, model, reasoning effort, risk checks, skills — and switch with arrow keys' },
  { name: '@skills', description: 'browse loaded skills and choose which skill tools are active for the next turn' },
]

const rawArgs = process.argv.slice(2)

const SUBCOMMANDS = ['auto', 'agent', 'evolve', 'bench', 'skills', 'runs', 'fork', 'resume', 'schedule', 'daemon', 'config', 'control'] as const
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
(or "/mode auto" in a session) to skip the pre-flight risk prompt while keeping
that action governor active.

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
  elia skills candidates      Show repeated work that could become a new tool
  elia skills synth           Write a tool for the strongest candidate

Time travel:
  elia runs                   List autonomous runs
  elia runs <id>              Show one run's timeline and its forkable decision points
  elia fork <id> --at <n> --with "<change>"
                              Replay that run up to checkpoint <n> and re-plan from there
  elia resume <id>            Continue a durable goal from its persisted graph and approvals

Background autonomy:
  elia schedule add --every 1h [--max-actions N] "<goal>"  Persist a recurring goal for the local daemon
  elia schedule list                       Show scheduled goals and last outcomes
  elia schedule pause|resume|remove <id>  Control a scheduled goal
  elia schedule run <id>                   Run one scheduled goal immediately
  elia daemon --once                       Run due schedules once and exit
  elia daemon --poll-ms 30000             Keep checking due schedules in the foreground

Provider setup:
  elia config                               Show provider readiness without printing keys
  elia config set --provider nvidia        Store a provider API key in ~/.elia/config.env
  elia config set --provider custom --base-url <url>
                                           Configure any OpenAI-compatible endpoint
  Use --api-key-env <NAME> or pipe a key with --api-key-stdin; never pass keys as arguments.

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
  /cyber                      Switch to cyber mode: authorized security testing, vuln
                              research, CTFs, and defensive work — same tools, a
                              security-focused system prompt with authorization guardrails
  /sports /fitness /marketing /finance /business /data /research /cybersecurity
  /automation /communications /ai /production /tech
                              Switch to that specialist persona for the rest of the session
  /dev                        Switch back to elia's development mode (legacy /normal also accepted)
  /mode auto                  Skip the pre-flight risk prompt; critical actions remain governed
  /mode manual                Go back to risk-checking and asking only when it matters (default)
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

  await loadRuntimeSkills()
  const { runAutonomousTask, autoApprove } = await import('./autonomy/loop.ts')
  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  let rl: readline.Interface | undefined
  try {
    if (yolo) {
      const result = await runAutonomousTask({ goal, approve: autoApprove, variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'unattended', signal: controller.signal, maxWallClockMs: maxRunMs, maxActions })
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
    const result = await runAutonomousTask({ goal, approve: createInteractiveApprover(interactiveRl), variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'supervised', approveAction, signal: controller.signal, maxWallClockMs: maxRunMs, maxActions })
    if (result.outcome !== 'completed' && result.outcome !== 'rejected') process.exitCode = 1
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}

async function runBench(): Promise<void> {
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
  const { skillCandidates } = await import('./skills/detector.ts')
  const { PROJECT_SKILLS_DIR, USER_SKILLS_DIR, SKILL_SUFFIX } = await import('./skills/paths.ts')
  const action = positionals()[0] ?? 'list'

  if (action === 'path' || action === 'folder' || action === 'folders') {
    writeNotice(`Project skills: ${PROJECT_SKILLS_DIR}`)
    writeNotice(`User skills:    ${USER_SKILLS_DIR}`)
    writeNotice(`File contract:  create a self-contained ${SKILL_SUFFIX} module exporting a default Tool with name, description, input_schema, and execute(input).`)
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

  writeError(`Unknown skills action "${action}". Use: list, path, candidates, or synth.`)
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

  if (action !== 'set') {
    writeError('Usage: elia config [status|set] [--provider <name>] [--model <id>] [--base-url <url>] [--api-key-env <NAME>|--api-key-stdin]')
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

async function readStdinText(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += Buffer.from(chunk as Uint8Array).toString('utf8')
  return text
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

async function runSchedule(): Promise<void> {
  const { MAX_SCHEDULE_ACTIONS, ScheduleStore, formatScheduleInterval, parseScheduleInterval } = await import('./autonomy/scheduler.ts')
  const action = positionals(['--every', '--title', '--profile', '--max-run-ms', '--max-actions'])[0] ?? 'list'
  const store = ScheduleStore.open()

  if (action === 'list') {
    const records = store.list()
    if (records.length === 0) {
      writeNotice('No scheduled goals. Add one with: elia schedule add --every 1h "<goal>"')
      return
    }
    for (const line of table(
      [{ header: 'id' }, { header: 'title' }, { header: 'status' }, { header: 'every' }, { header: 'actions' }, { header: 'next run' }, { header: 'runs', align: 'right' }, { header: 'last outcome' }, { header: 'goal' }],
      records.map((record) => [record.id, record.title, record.status, formatScheduleInterval(record.intervalMs), record.maxActions ? String(record.maxActions) : 'profile default', new Date(record.nextRunAt).toISOString(), String(record.runCount), record.lastOutcome ?? '—', record.goal.slice(0, 60)]),
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

  const goal = positionals(['--every', '--title', '--profile', '--max-run-ms', '--max-actions']).slice(1).join(' ').trim()
  const every = flagValue('--every')
  if (!goal || !every) {
    writeError('Usage: elia schedule add --every 1h [--title "Short title"] [--max-actions N] "<goal>"')
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
  const record = store.create({ title, goal, intervalMs, profile, maxRunMs, maxActions })
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

  const oneShotPrompt = positionals(['--resume']).join(' ').trim()

  let mode: AgentMode = hasFlag('--cyber') ? 'cyber' : hasFlag('--sports') ? 'sports' : hasFlag('--fitness') ? 'fitness' : 'dev'
  let persona: AgentPersona | undefined
  let selectedSkillNames: string[] | undefined
  let messages: ConversationMessage[] = []
  let sessionId = newSessionId()
  // manual (default): a cheap risk check runs before each command — only
  // commands flagged risky (deletes, sends, spend, publishing, system
  // changes, ...) get an "About to: ... run it?" prompt; everything else just
  // runs. auto (--yolo or "/mode auto"): skips the pre-flight prompt while the
  // shared governor still blocks or requests approval for critical actions.
  // Safe and reversible work runs end to end without interruption.
  let replMode: 'manual' | 'auto' = hasFlag('--yolo', '-y') ? 'auto' : 'manual'

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

  /** Snapshots messages + touched files around one turn, then records a rewind point. */
  async function runCheckpointedTurn(userText: string, approveAction?: ActionApproval, skillNames = selectedSkillNames): Promise<void> {
    const tracker = createFileTracker()
    const task = taskSessions.create(inferTaskKind(userText, userText), redactText(userText, 160), 'Starting request')
    taskSessions.update(task.id, { status: 'running', action: 'Thinking', detail: 'Planning the next action' })
    const controller = new AbortController()
    let stopRequested = false
    const unregisterControls = taskSessions.registerControls(task.id, {
      cancel: () => {
        stopRequested = true
        controller.abort()
        taskSessions.update(task.id, { status: 'paused', action: 'Stopping', detail: 'Cancellation requested by operator' })
      },
    })
    const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
    emitEvent('turn_started', { taskId: task.id, sessionId, prompt: redactText(userText, 2000) })
    setActiveTracker(tracker)
    // Lets compaction (mid-loop, several call frames down) and the recall tool
    // find this session's ledger — see ledger.ts's setActiveLedgerSession doc.
    setActiveLedgerSession({ id: sessionId, turn: checkpoints.length })
    const messagesBefore = structuredClone(messages)
    messages.push(userMessage(userText))
    try {
      if (persona) {
        const { runPersonaTurn } = await import('./agents/orchestrator.ts')
        await runPersonaTurn(messages, persona, skillNames, controller.signal)
      } else {
        const turnResult = await runTurn(messages, {
          mode,
          approveAction,
          skillNames,
          signal: controller.signal,
          onTool: (event) => {
            taskSessions.update(task.id, {
              status: 'running',
              action: event.isError ? `Retrying after ${event.name}` : event.name,
              detail: event.isError ? redactText(event.result, 500) : 'Action completed successfully',
              stepsCompleted: (taskSessions.get(task.id)?.stepsCompleted ?? 0) + 1,
            })
          },
        })
        if (turnResult.stopReason === 'aborted') stopRequested = true
      }
      if (stopRequested || controller.signal.aborted) {
        taskSessions.update(task.id, { status: 'paused', action: 'Stopped', detail: 'Stopped by operator; no further tool calls will run' })
        emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'aborted' })
        return
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
    return
  }

  if (process.stdout.isTTY && !plainOutput && !machineReadable) await playIntro()
  if (!machineReadable && !quietOutput) {
    const taskSummary = renderTaskSummary(taskSessions)
    process.stdout.write(
      `${box(
        [
          `${dim('provider')}  ${config.providerLabel}${config.routingMode === 'auto' ? dim(' · auto fallback on') : ''}${config.cascadeEnabled ? dim(` · fast tier ${config.tiers.fast.label}`) : ''}`,
          dim(describeThinking()),
          ...(taskSummary ? [dim(taskSummary)] : []),
        ],
        { title: mode === 'cyber' ? 'elia — cyber mode' : mode === 'sports' ? 'elia — sports mode' : mode === 'fitness' ? 'elia — fitness mode' : 'elia — dev mode', borderColor: gold },
      )}\n`,
    )
  }
  writeNotice(
    mode === 'cyber'
      ? 'cyber mode on — authorized security testing, vuln research, and CTFs only. type a prompt, "/" to see commands, or "exit" to quit'
      : mode === 'sports'
        ? 'sports mode on — evidence-aware match, scouting, performance, league, event, and sports-business analysis. type a prompt, "/" to see commands, or "exit" to quit'
        : mode === 'fitness'
          ? 'fitness mode on — conservative training, habit, recovery, and wellbeing support; not medical advice. type a prompt, "/" to see commands, or "exit" to quit'
          : 'dev mode on — building, debugging, testing, browser, and task workflows available. type a prompt, "/" to see commands, or "exit" to quit (Ctrl+C also works)',
  )
  writeNotice(
    replMode === 'auto'
      ? 'auto mode (--yolo) — preliminary risk checks are skipped; safe work runs immediately, while governed irreversible actions still require explicit approval. "/mode manual" to turn checks back on.'
      : 'manual mode — elia flags risky commands and asks before running them; safe commands just run. "/mode auto" for zero prompts.',
  )

  function applyModelChoice(providerName: string, model?: string): void {
    const result = switchModel({ providerName, model })
    if (!result.ok) writeError(result.error)
    else writeNotice(`Model switched: ${result.label}`)
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
      const currentModel = providerName === config.providerName ? config.model : fallbackModel
      const modelOptions = discovery.models.map((model) => ({
        label: model.id === currentModel ? `${model.id} (current)` : model.id,
        detail: model.name ?? model.ownedBy ?? 'available model',
        value: model.id,
      }))
      const result = await pick(`Models for ${providerName} (${modelOptions.length})`, modelOptions, Math.max(0, modelOptions.findIndex((option) => option.value === currentModel)))
      if (result.type === 'select') applyModelChoice(providerName, result.value)
      else if (result.type === 'unavailable') writeNotice(`${providerName} exposes ${discovery.models.length} selectable model(s).`)
    }

    if (args.length === 0) {
      const currentIndex = config.routingMode === 'auto' ? 0 : PROVIDER_PRESET_NAMES.indexOf(config.providerName) + 1
      const options = [
        {
          label: config.routingMode === 'auto' ? 'auto (current)' : 'auto',
          detail: 'transparent fallback across every ready provider',
          value: 'auto',
        },
        ...PROVIDER_PRESET_NAMES.map((name) => ({
        label: name === config.providerName ? `${name} (current)` : name,
        detail: `${isProviderPresetConfigured(name) ? 'ready' : 'no key set'} · ${providerPresetDefaultModel(name) ?? 'custom'}`,
          value: name,
        })),
      ]
      const result = await pick('Switch model', options, Math.max(0, currentIndex))
      if (result.type === 'select') {
        if (result.value === 'auto') applyModelChoice('auto')
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
    const { USER_SKILLS_DIR, PROJECT_SKILLS_DIR } = await import('./skills/paths.ts')
    const skills = listLoadedSkills()
    if (skills.length === 0) {
      writeNotice(`No loaded skills. Add a validated *.skill.ts file to ${PROJECT_SKILLS_DIR} for this project or ${USER_SKILLS_DIR} for all projects, then restart Elia.`)
      return
    }

    const active = new Set(selectedSkillNames ?? skills.map((skill) => skill.name))
    const options = [
      { label: active.size === skills.length ? 'all loaded skills (current)' : 'all loaded skills', detail: 'make every loaded skill available', value: '__all__' },
      ...skills.map((skill) => ({
        label: active.has(skill.name) && active.size === 1 ? `${skill.name} (current)` : skill.name,
        detail: `${skill.source} · ${skill.file}`,
        value: skill.name,
      })),
    ]
    const result = await pick('Skills for subsequent turns', options)
    if (result.type !== 'select') return
    selectedSkillNames = result.value === '__all__' ? undefined : [result.value]
    writeNotice(selectedSkillNames ? `Skill selected for subsequent turns: ${selectedSkillNames[0]}` : 'All loaded skills are available for subsequent turns.')
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
    const requestedPersona = choice === 'cybersecurity' ? 'cyber' : choice
    if (isAgentPersona(requestedPersona)) {
      persona = requestedPersona
      writeNotice(`${persona.charAt(0).toUpperCase()}${persona.slice(1)} agent on — elia will answer in this persona until /dev.`)
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
    { label: 'Tech', detail: 'Tech agent persona', value: 'tech' },
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

  /** Shared by "/mode auto"|"/mode manual" and the /settings risk-checks picker. */
  function applyReplModeChoice(value: 'auto' | 'manual'): void {
    replMode = value
    writeNotice(
      value === 'auto'
        ? 'Auto mode — preliminary risk checks are skipped. Safe work runs immediately; governed irreversible actions still require explicit approval. "/mode manual" to re-enable checks.'
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

  /** Top-level settings screen: every switchable setting in one arrow-key menu, looping until esc/cancel. */
  async function handleSettingsCommand(): Promise<void> {
    while (true) {
      const modeSummary = persona ? `persona: ${persona === 'cyber' ? 'cybersecurity' : persona}` : `mode: ${mode}`
      const options = [
        { label: 'Mode / persona', detail: modeSummary, value: 'mode' },
        { label: 'Risk checks', detail: replMode, value: 'replMode' },
        { label: 'Model & provider', detail: `${config.providerLabel} · ${config.model}`, value: 'model' },
        { label: 'Reasoning effort', detail: describeThinking(), value: 'thinking' },
        { label: 'Skills', detail: selectedSkillNames ? selectedSkillNames.join(', ') : 'all loaded', value: 'skills' },
      ]
      const result = await pick('Settings', options)
      if (result.type === 'unavailable') {
        for (const option of options) writeUsageLine(`  ${option.label}: ${option.detail}`)
        return
      }
      if (result.type !== 'select') return
      if (result.value === 'mode') await handleModePersonaPicker()
      else if (result.value === 'replMode') await handleReplModePicker()
      else if (result.value === 'model') await handleModelCommand('')
      else if (result.value === 'thinking') await handleThinkingCommand('')
      else if (result.value === 'skills') await handleSkillsPicker()
    }
  }

  while (true) {
    const label = persona ? `${dim(`[${persona}]`)} ` : mode !== 'dev' ? `${dim(`[${mode}]`)} ` : ''
    const line = await prompt.question(`${label}${gold('❯')} `)
    if (line === null) break // stdin closed (EOF)

    const trimmed = line.trim()
    if (trimmed === 'exit' || trimmed === 'quit') break
    if (trimmed === '') continue

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
    if (trimmed === '/cyber' || trimmed === '/cyber on') {
      applyModePersonaChoice('cyber')
      continue
    }
    if (trimmed === '/sports') {
      applyModePersonaChoice('sports')
      continue
    }
    if (trimmed === '/fitness') {
      applyModePersonaChoice('fitness')
      continue
    }
    const personaMatch = /^\/(marketing|finance|business|data|research|cybersecurity|automation|communications|ai|production|tech)$/.exec(trimmed)
    if (personaMatch) {
      applyModePersonaChoice(personaMatch[1]!)
      continue
    }

    if (trimmed === '/dev' || trimmed === '/normal' || trimmed === '/cyber off') {
      applyModePersonaChoice('dev')
      continue
    }

    if (trimmed === '/settings') {
      await handleSettingsCommand()
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

    const modeMatch = /^\/mode(?:\s+(.*))?$/.exec(trimmed)
    if (modeMatch) {
      const modeArg = modeMatch[1]?.trim()
      if (!modeArg) {
        await handleModePersonaPicker()
      } else if (modeArg === 'auto') {
        applyReplModeChoice('auto')
      } else if (modeArg === 'manual') {
        applyReplModeChoice('manual')
      } else {
        applyModePersonaChoice(modeArg)
      }
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

    try {
      await runCheckpointedTurn(commandToRun, async (assessment, request) => {
        const result = await confirmOnce(prompt, actionApprovalPrompt(assessment, request))
        return result.action === 'approve'
      })
    } catch (err) {
      writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
    await saveSession(sessionId, messages)
    const taskSummary = renderTaskSummary(taskSessions)
    const contextLine = renderContextStatus(messages, await countEpisodes(sessionId))
    writeUsageLine(taskSummary ? `${contextLine}  ·  ${dim(taskSummary)}` : contextLine)
  }

  prompt.close()
  if (messages.length > 0 && !machineReadable) process.stdout.write(`${box([getSessionSummaryLine(config.model)])}\n`)
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
    case 'control':
      return runControl()
    default:
      return runInteractive()
  }
}

// Load ~/.elia/config.env before any command imports provider configuration. Explicit
// project/process environment values already present in process.env take precedence.
loadUserConfig()

// Signal handlers are installed by installShutdownHandlers() so every terminal
// component follows one cleanup path and returns a conventional interrupt code.

main().catch((err: unknown) => {
  writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
