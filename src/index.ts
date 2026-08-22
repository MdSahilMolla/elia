import * as readline from 'node:readline/promises'
import type { ConversationMessage, AgentMode } from './agent.ts'
import { writeNotice, writeError, writeUsageLine } from './ui/stream.ts'
import { playIntro } from './ui/character.ts'
import { getSessionSummaryLine, recordTopLevelTurn, formatUsageLine } from './usage.ts'
import { createSlashPrompt, type SlashCommand } from './ui/slashPrompt.ts'
import { confirmOnce } from './ui/confirm.ts'
import { classifyRisk } from './autonomy/risk.ts'
import { gold, dim } from './ui/theme.ts'
import { box, table } from './ui/layout.ts'
import { pick } from './ui/picker.ts'
import { createLiveActionWindow, openTaskDashboard } from './ui/taskDashboard.ts'
import { inferTaskKind, taskSessions } from './taskSessions.ts'
import { isAgentPersona, type AgentPersona } from './agents/types.ts'
import { CAPABILITIES } from './capabilities.ts'
import type { ActionApproval, ActionAssessment, ActionRequest } from './autonomy/governor.ts'
import { emitEvent, machineReadable, plainOutput, quietOutput } from './ui/runtime.ts'
import { installShutdownHandlers, registerShutdownCleanup } from './ui/shutdown.ts'
import { redactText } from './ui/redact.ts'

const REPL_COMMANDS: SlashCommand[] = [
  { name: '/capabilities', description: 'list specialist capabilities, risk classes, and output contracts' },
  { name: '/cyber', description: 'switch to cyber mode — authorized security testing, vuln research, CTFs' },
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
  { name: '@skills', description: 'browse loaded skills and choose which skill tools are active for the next turn' },
]

const rawArgs = process.argv.slice(2)

const SUBCOMMANDS = ['auto', 'agent', 'evolve', 'bench', 'skills', 'runs', 'fork', 'resume'] as const
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
  elia auto "<goal>" --no-polish     Skip the bounded final quality pass
  elia auto "<goal>" --fast          Bounded fast path: no polish, one reviewer, one repair, no lesson pass
  elia auto "<goal>" --thorough      Extra bounded review and repair depth for high-risk changes
  elia auto "<goal>" --max-run-ms N  Abort the run after N milliseconds (also ELIA_MAX_RUN_MS)
  elia auto "<goal>" --variants N   Run N independent implementation attempts in parallel,
                                     each in its own isolated git worktree, and keep only
                                     the one that verification — not an LLM's opinion — likes
                                     best. Costs roughly Nx the execute phase; default is 1
                                     (today's single-attempt behavior, unchanged)

Multi-agent:
  elia agent "<request>"      Route the request to one or more specialist personas — Business,
                              Data, Research, Cybersecurity, Automation, Communications, AI/ML,
                              Marketing, Finance, or Tech — and answer in their voice. Multi-domain
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

Inside an interactive session:
  /                            Type "/" to see available commands — up/down to highlight,
                              tab to accept, enter to run, left/right to edit as usual
  rewind                      List rewind points for this session
  rewind <n>                  Restore conversation + files to just before turn <n>
  /capabilities               List specialist capabilities, risk classes, and output contracts
  /cyber                      Switch to cyber mode: authorized security testing, vuln
                              research, CTFs, and defensive work — same tools, a
                              security-focused system prompt with authorization guardrails
  /marketing /finance /business /data /research /cybersecurity
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
  elia --cyber                Start (or run a one-shot prompt) in cyber mode
  elia --json                 Emit stable JSONL lifecycle events for automation
  elia --plain                Disable color, animation, and in-place terminal redraws
  elia --quiet                Print the final answer and essential failures only
  elia --verbose              Include detailed progress output
  ELIA_MAX_RUN_MS             Default wall-clock budget for autonomous runs; --max-run-ms overrides it
  ELIA_TOOL_CONCURRENCY       Read-only tool batches can use up to 8; mutating batches stay capped at 4
  elia --help                 Show this help
  elia --version              Print the version

  UI output: --json/--jsonl emits machine-readable JSONL events; --plain disables color and redraws;
  --quiet minimizes progress; --verbose includes additional progress detail. Errors go to stderr
  in human modes. Sessions auto-save to .elia/sessions/. Configure a provider via .env — see .env.example.

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
  return names.some((name) => args.includes(name))
}

function flagValue(...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name)
    if (index !== -1) return args[index + 1]
  }
  return undefined
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
    if (arg.startsWith('-')) continue
    result.push(arg)
  }
  return result
}

function userMessage(text: string): ConversationMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
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

async function runAgentCommand(): Promise<void> {
  const { runAgentRequest } = await import('./agents/orchestrator.ts')
  const { config } = await import('./config.ts')
  const request = positionals().join(' ').trim()
  if (!request) {
    writeError('Give elia a request: elia agent "write 3 instagram captions for our new product"')
    process.exitCode = 1
    return
  }

  const startedAt = Date.now()
  const dryRun = hasFlag('--dry-run')
  const result = await runAgentRequest(request, { dryRun })
  const elapsedMs = Date.now() - startedAt
  recordTopLevelTurn(elapsedMs)

  writeUsageLine(`${dryRun ? 'routing plan' : 'agent(s)'}: ${result.personas.join(' -> ')}${result.rationale ? ` — ${result.rationale}` : ''}`)
  if (dryRun) writeNotice('Dry run complete: no specialist tools or side effects were executed.')
  writeUsageLine(formatUsageLine(result.usage, elapsedMs, config.model))
}

async function runAuto(): Promise<void> {
  const { runAutonomousTask, autoApprove } = await import('./autonomy/loop.ts')
  const goal = positionals(['--variants', '--run-id']).join(' ').trim()
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
  const maxRunMsRaw = flagValue('--max-run-ms')
  const maxRunMs = maxRunMsRaw === undefined ? undefined : Number.parseInt(maxRunMsRaw, 10)
  if (maxRunMsRaw !== undefined && (!Number.isInteger(maxRunMs) || maxRunMs! < 1)) {
    writeError(`--max-run-ms must be a positive integer in milliseconds, got "${maxRunMsRaw}"`)
    process.exitCode = 1
    return
  }
  if (maxRunMs !== undefined) writeNotice(`wall-clock budget: ${(maxRunMs / 1000).toFixed(1)}s`)
  if (profile !== 'balanced') writeNotice(`autonomy profile: ${profile}`)

  const variantsRaw = flagValue('--variants')
  const variants = variantsRaw ? Number.parseInt(variantsRaw, 10) : undefined
  if (variantsRaw && (!Number.isInteger(variants) || variants! < 1)) {
    writeError(`--variants must be a positive integer, got "${variantsRaw}"`)
    process.exitCode = 1
    return
  }
  if (variants && variants > 1) {
    writeNotice(
      `--variants ${variants}: running ${variants} independent implementation attempts in isolated git worktrees, keeping the one that verifies best.`,
    )
  }

  const yolo = hasFlag('--yolo', '-y', '--autonomous', '--self-supervise') || process.env.ELIA_AUTO_APPROVE === '1'
  let approveAction: ActionApproval | undefined
  if (!yolo && !process.stdin.isTTY) {
    writeError('elia auto needs a terminal to approve the plan. Re-run with --yolo to skip approval.')
    process.exitCode = 1
    return
  }

  const controller = new AbortController()
  const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
  let rl: readline.Interface | undefined
  try {
    if (yolo) {
      const result = await runAutonomousTask({ goal, approve: autoApprove, variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'unattended', signal: controller.signal, maxWallClockMs: maxRunMs })
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
    const result = await runAutonomousTask({ goal, approve: createInteractiveApprover(interactiveRl), variants, profile, resumeGraph, runId: resumeRunId, polish: !hasFlag('--no-polish'), governanceMode: 'supervised', approveAction, signal: controller.signal, maxWallClockMs: maxRunMs })
    if (result.outcome !== 'completed' && result.outcome !== 'rejected') process.exitCode = 1
  } finally {
    rl?.close()
    unregisterShutdown()
  }
}

async function runBench(): Promise<void> {
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
  const { evolve } = await import('./evolve/engine.ts')
  const generations = Number.parseInt(flagValue('--generations', '-n') ?? '1', 10)
  if (!Number.isFinite(generations) || generations < 1) {
    writeError('--generations must be a positive integer.')
    process.exitCode = 1
    return
  }

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

async function runRuns(): Promise<void> {
  const { listRuns } = await import('./autonomy/journal.ts')
  const { renderRunTimeline } = await import('./autonomy/rewind.ts')
  const runId = positionals()[0]

  if (runId) {
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
    [{ header: 'id' }, { header: 'outcome' }, { header: 'checkpoints', align: 'right' }, { header: 'recovered', align: 'right' }, { header: 'goal' }],
    runs.map((run) => [run.runId, run.outcome, String(run.checkpoints), String(run.recoveredNodes ?? 0), run.goal.slice(0, 60)]),
  )) {
    writeUsageLine(`  ${line}`)
  }
  writeNotice('Inspect one with: elia runs <id>')
}

async function runResume(): Promise<void> {
  const { runAutonomousTask, autoApprove } = await import('./autonomy/loop.ts')
  const { GoalGraphStore } = await import('./autonomy/goalGraph.ts')
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
  const { forkRun } = await import('./autonomy/rewind.ts')
  const { autoApprove } = await import('./autonomy/loop.ts')

  const runId = positionals(['--at', '--with']).at(0)
  const at = Number.parseInt(flagValue('--at') ?? '', 10)
  const instruction = flagValue('--with')

  if (!runId || !Number.isFinite(at) || !instruction) {
    writeError('Usage: elia fork <runId> --at <checkpoint> --with "<what to do differently>"')
    process.exitCode = 1
    return
  }

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
  const { runTurn } = await import('./agent.ts')
  const { config, describeThinking, getThinking, switchModel, switchThinking, THINKING_EFFORT_BUDGETS, DEFAULT_THINKING_BUDGET } =
    await import('./config.ts')
  const { PROVIDER_PRESET_NAMES, isProviderPresetConfigured, providerPresetDefaultModel, listProviderModels } = await import('./providers/registry.ts')
  const { newSessionId, loadSession, loadLatestSession, saveSession } = await import('./session.ts')
  const { createFileTracker, setActiveTracker, loadCheckpoints, saveCheckpoints, restoreCheckpoint, renderCheckpointList } =
    await import('./checkpoint.ts')
  const { setActiveLedgerSession, countEpisodes } = await import('./ledger.ts')
  const { renderContextStatus } = await import('./compaction.ts')
  await taskSessions.load()

  const continueFlag = hasFlag('--continue', '-c')
  const resumeId = flagValue('--resume')
  const oneShotPrompt = positionals(['--resume']).join(' ').trim()

  let mode: AgentMode = hasFlag('--cyber') ? 'cyber' : 'dev'
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
    const actionWindow = createLiveActionWindow()
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
      actionWindow.stop()
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
      const { risky, reason } = await classifyRisk(commandToRun)
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
    writeUsageLine(renderContextStatus(messages, await countEpisodes(sessionId)))
    return
  }

  if (process.stdout.isTTY && !plainOutput && !machineReadable) await playIntro()
  if (!machineReadable && !quietOutput) {
    process.stdout.write(
      `${box(
        [
          `${dim('provider')}  ${config.providerLabel}${config.routingMode === 'auto' ? dim(' · auto fallback on') : ''}${config.cascadeEnabled ? dim(` · fast tier ${config.tiers.fast.label}`) : ''}`,
          dim(describeThinking()),
        ],
        { title: mode === 'cyber' ? 'elia — cyber mode' : 'elia — dev mode', borderColor: gold },
      )}\n`,
    )
  }
  writeNotice(
    mode === 'cyber'
      ? 'cyber mode on — authorized security testing, vuln research, and CTFs only. type a prompt, "/" to see commands, or "exit" to quit'
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
      const parsed = Number.parseInt(arg, 10)
      if (!Number.isFinite(parsed) || parsed < 1024) {
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

  while (true) {
    const label = persona ? `${dim(`[${persona}]`)} ` : mode === 'cyber' ? `${dim('[cyber]')} ` : ''
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
      mode = 'cyber'
      writeNotice(
        'cyber mode on — elia will help with authorized security testing, vuln research, and CTFs. Only point it at systems you own or are explicitly authorized to test.',
      )
      continue
    }
    const personaMatch = /^\/(marketing|finance|business|data|research|cybersecurity|automation|communications|ai|production|tech)$/.exec(trimmed)
    const requestedPersona = personaMatch?.[1] === 'cybersecurity' ? 'cyber' : personaMatch?.[1]
    if (requestedPersona && isAgentPersona(requestedPersona)) {
      persona = requestedPersona
      writeNotice(
        `${persona.charAt(0).toUpperCase()}${persona.slice(1)} agent on — elia will answer in this persona until /dev.`,
      )
      continue
    }

    if (trimmed === '/dev' || trimmed === '/normal' || trimmed === '/cyber off') {
      mode = 'dev'
      const hadPersona = persona !== undefined
      persona = undefined
      writeNotice(hadPersona ? 'Agent persona off — back to dev mode.' : 'cyber mode off — back to dev mode.')
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

    if (trimmed === '/mode auto') {
      replMode = 'auto'
      writeNotice('Auto mode — preliminary risk checks are skipped. Safe work runs immediately; governed irreversible actions still require explicit approval. "/mode manual" to re-enable checks.')
      continue
    }
    if (trimmed === '/mode manual') {
      replMode = 'manual'
      writeNotice('Manual mode — elia flags risky commands and asks first; safe commands just run.')
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
      const { risky, reason } = await classifyRisk(commandToRun)
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
    writeUsageLine(renderContextStatus(messages, await countEpisodes(sessionId)))
  }

  prompt.close()
  if (messages.length > 0 && !machineReadable) process.stdout.write(`${box([getSessionSummaryLine(config.model)])}\n`)
  writeNotice('Goodbye!')
}

async function main() {
  installShutdownHandlers()
  emitEvent('cli_started', { version: JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text()).version, uiMode: machineReadable ? 'json' : plainOutput ? 'plain' : 'normal' })
  // Skills elia wrote for itself are loaded before anything can call a tool, and a
  // broken one is quarantined rather than allowed to stop startup.
  const { loadSkills } = await import('./skills/loader.ts')
  const { flushUsageStats } = await import('./skills/detector.ts')
  // Process-exit handlers must be synchronous, so the flush is registered here,
  // after the module is already loaded.
  process.on('exit', flushUsageStats)

  const skills = await loadSkills()
  if (skills.loaded.length > 0 && subcommand !== 'skills') {
    writeUsageLine(`${skills.loaded.length} learned tool(s): ${skills.loaded.map((skill) => skill.name).join(', ')}`)
  }

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
    default:
      return runInteractive()
  }
}

// Signal handlers are installed by installShutdownHandlers() so every terminal
// component follows one cleanup path and returns a conventional interrupt code.

main().catch((err: unknown) => {
  writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
