import * as readline from 'node:readline/promises'
import type { ConversationMessage } from './agent.ts'
import { writeNotice, writeUsageLine } from './ui/stream.ts'
import { printBanner } from './ui/character.ts'
import { getSessionSummaryLine } from './usage.ts'

const rawArgs = process.argv.slice(2)

const SUBCOMMANDS = ['auto', 'evolve', 'bench', 'skills', 'runs', 'fork'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

function printHelp(): void {
  console.log(`elia — an autonomous coding agent for your terminal

Usage:
  elia                        Start an interactive session
  elia "<prompt>"             Run a single prompt and exit
  elia --continue, -c         Resume the most recent session in this directory
  elia --resume <id>          Resume a specific session by id

Autonomous work:
  elia auto "<goal>"          Plan the work, show you the plan, then execute it with a
                              fleet of sub-agents, verify it, repair what failed, and
                              record what it learned
  elia auto "<goal>" --yolo   Same, without waiting for you to approve the plan

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

Other:
  elia --help                 Show this help
  elia --version              Print the version

Sessions auto-save to .elia/sessions/. Configure a provider via .env — see .env.example.
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

/**
 * The approval gate. A plan the user cannot change is not a proposal, so the
 * prompt accepts an amendment as well as yes or no — `e <feedback>` sends the plan
 * back to be reworked rather than forcing a reject-and-retype.
 */
function createInteractiveApprover(rl: readline.Interface) {
  return async () => {
    while (true) {
      const answer = (await rl.question('Approve this plan? [y]es / [n]o / [e]dit <what to change>: ')).trim()
      const lower = answer.toLowerCase()

      if (lower === 'y' || lower === 'yes') return { action: 'approve' as const }
      if (lower === 'n' || lower === 'no') return { action: 'reject' as const }

      if (lower === 'e' || lower === 'edit') {
        const feedback = (await rl.question('What should change? ')).trim()
        if (feedback) return { action: 'amend' as const, feedback }
        continue
      }
      if (lower.startsWith('e ')) return { action: 'amend' as const, feedback: answer.slice(2).trim() }

      // Anything else is treated as feedback rather than an error — typing a
      // sentence at this prompt obviously means "change this".
      if (answer.length > 3) return { action: 'amend' as const, feedback: answer }
    }
  }
}

async function runAuto(): Promise<void> {
  const { runAutonomousTask, autoApprove } = await import('./autonomy/loop.ts')
  const goal = positionals().join(' ').trim()
  if (!goal) {
    writeNotice('Give elia a goal: elia auto "add rate limiting to the API client"')
    process.exitCode = 1
    return
  }

  const yolo = hasFlag('--yolo', '-y')
  if (!yolo && !process.stdin.isTTY) {
    writeNotice('elia auto needs a terminal to approve the plan. Re-run with --yolo to skip approval.')
    process.exitCode = 1
    return
  }

  if (yolo) {
    const result = await runAutonomousTask({ goal, approve: autoApprove })
    if (result.outcome !== 'completed') process.exitCode = 1
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const result = await runAutonomousTask({ goal, approve: createInteractiveApprover(rl) })
    if (result.outcome !== 'completed' && result.outcome !== 'rejected') process.exitCode = 1
  } finally {
    rl.close()
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
  process.stdout.write(renderScorecard(card, 'elia'))
  if (card.passRate < 1) process.exitCode = 1
}

async function runEvolve(): Promise<void> {
  const { evolve } = await import('./evolve/engine.ts')
  const generations = Number.parseInt(flagValue('--generations', '-n') ?? '1', 10)
  if (!Number.isFinite(generations) || generations < 1) {
    writeNotice('--generations must be a positive integer.')
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
  const action = positionals()[0] ?? 'list'

  if (action === 'list') {
    const files = listSkillFiles()
    if (files.length === 0) {
      writeNotice('No synthesized skills yet. Run "elia skills candidates" to see what elia keeps doing by hand.')
      return
    }
    for (const { file, source } of files) writeUsageLine(`  [${source}] ${file}`)
    return
  }

  if (action === 'candidates') {
    const candidates = skillCandidates()
    if (candidates.length === 0) {
      writeNotice('Nothing has repeated often enough yet. Keep using elia — it is counting.')
      return
    }
    for (const candidate of candidates) {
      writeUsageLine(`  ${String(candidate.count).padStart(4)}×  [${candidate.kind}] ${candidate.pattern}`)
      for (const example of candidate.examples) writeUsageLine(`         e.g. ${example}`)
    }
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
      writeNotice(`✗ ${result.detail}`)
      process.exitCode = 1
    }
    return
  }

  writeNotice(`Unknown skills action "${action}". Use: list, candidates, or synth.`)
  process.exitCode = 1
}

async function runRuns(): Promise<void> {
  const { listRuns } = await import('./autonomy/journal.ts')
  const { renderRunTimeline } = await import('./autonomy/rewind.ts')
  const runId = positionals()[0]

  if (runId) {
    process.stdout.write(`${renderRunTimeline(runId)}\n`)
    return
  }

  const runs = listRuns()
  if (runs.length === 0) {
    writeNotice('No autonomous runs in this directory yet. Start one with: elia auto "<goal>"')
    return
  }
  for (const run of runs) {
    writeUsageLine(
      `  ${run.runId}  ${run.outcome.padEnd(16)} ${run.checkpoints} checkpoints  ${run.goal.slice(0, 60)}`,
    )
  }
  writeNotice('Inspect one with: elia runs <id>')
}

async function runFork(): Promise<void> {
  const { forkRun } = await import('./autonomy/rewind.ts')
  const { autoApprove } = await import('./autonomy/loop.ts')

  const runId = positionals(['--at', '--with']).at(0)
  const at = Number.parseInt(flagValue('--at') ?? '', 10)
  const instruction = flagValue('--with')

  if (!runId || !Number.isFinite(at) || !instruction) {
    writeNotice('Usage: elia fork <runId> --at <checkpoint> --with "<what to do differently>"')
    process.exitCode = 1
    return
  }

  const rl = process.stdin.isTTY && !hasFlag('--yolo', '-y')
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : undefined

  try {
    const result = await forkRun({
      runId,
      checkpointId: at,
      instruction,
      approve: rl ? createInteractiveApprover(rl) : autoApprove,
    })
    if (!result.ok) {
      writeNotice(result.error)
      process.exitCode = 1
    }
  } finally {
    rl?.close()
  }
}

async function runInteractive(): Promise<void> {
  const { runTurn } = await import('./agent.ts')
  const { config } = await import('./config.ts')
  const { newSessionId, loadSession, loadLatestSession, saveSession } = await import('./session.ts')

  const continueFlag = hasFlag('--continue', '-c')
  const resumeId = flagValue('--resume')
  const oneShotPrompt = positionals(['--resume']).join(' ').trim()

  let messages: ConversationMessage[] = []
  let sessionId = newSessionId()

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

  if (oneShotPrompt) {
    messages.push(userMessage(oneShotPrompt))
    try {
      await runTurn(messages)
    } catch (err) {
      writeNotice(`Error: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
    await saveSession(sessionId, messages)
    return
  }

  if (process.stdout.isTTY) printBanner()
  writeNotice(`elia — using ${config.providerLabel}${config.cascadeEnabled ? ` · fast tier ${config.tiers.fast.label}` : ''}`)
  writeNotice('type a prompt, or "exit" to quit (Ctrl+C also works)')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  while (true) {
    let line: string
    try {
      line = await rl.question('> ')
    } catch {
      break // stdin closed (EOF)
    }

    const trimmed = line.trim()
    if (trimmed === 'exit' || trimmed === 'quit') break
    if (trimmed === '') continue

    messages.push(userMessage(trimmed))
    try {
      await runTurn(messages)
    } catch (err) {
      writeNotice(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
    await saveSession(sessionId, messages)
  }

  rl.close()
  if (messages.length > 0) writeUsageLine(getSessionSummaryLine(config.model))
  writeNotice('Goodbye!')
}

async function main() {
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
    default:
      return runInteractive()
  }
}

process.on('SIGINT', () => {
  process.stdout.write('\n')
  process.exit(0)
})

main().catch((err: unknown) => {
  writeNotice(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
