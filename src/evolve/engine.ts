import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT, config } from '../config.ts'
import { runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { runSubAgent } from '../subagent.ts'
import { allWorkerTools } from '../tools/registry.ts'
import type { Tool } from '../tools/types.ts'
import { clampOutput, runShell } from '../shell.ts'
import { writeText } from '../ui/stream.ts'
import { writeBlock, writeFail, writePass, writePhase, writeSubStep, writeSummary } from '../ui/report.ts'
import { formatElapsed } from '../usage.ts'
import {
  appendGeneration,
  nextGenerationNumber,
  renderLedgerForPrompt,
  type GenerationRecord,
  type Metrics,
} from './ledger.ts'
import { compareScorecards, measureFitness, renderScorecard, toMetrics, type Scorecard } from './fitness.ts'
import {
  IMMUTABLE_FILES,
  changedFiles,
  createSandbox,
  describeChanges,
  promote,
  violatedImmutables,
  type Sandbox,
} from './sandbox.ts'

/**
 * Elia improving elia.
 *
 * The loop is: measure yourself, read everything you have already tried, form one
 * hypothesis about your weakest link, implement it in a copy of yourself, and let
 * the benchmark decide whether that copy replaces you. Then do it again, now
 * standing on the version that won.
 *
 * Two design choices are what make this self-improvement rather than self-editing.
 *
 * The candidate is evaluated *by running the candidate* — the benchmark child
 * processes are launched from the sandbox's own source, so a mutation to the agent
 * loop, the system prompt, or the tool set is measured through its own effects.
 * And the mutation is allowed to target the parts of elia that do the improving:
 * the planner prompt, the role definitions, the loop policy. A generation that
 * makes elia a better engineer makes the next generation's attempt better too,
 * which is the recursion.
 *
 * What keeps it honest is that nothing is promoted on a model's opinion. The
 * benchmark is code, its files cannot be edited by the candidate, and a tie is a
 * rejection.
 */

const HYPOTHESIS_MAX_STEPS = 30
const GATE_TIMEOUT_MS = 300_000

export interface Hypothesis {
  title: string
  rationale: string
  targetFiles: string[]
  plan: string
}

export interface EvolveOptions {
  generations?: number
  /** Evaluate and report, but never write to the live source. */
  dryRun?: boolean
  signal?: AbortSignal
}

export interface EvolveResult {
  generations: GenerationRecord[]
  baseline: Metrics
  final: Metrics
}

export async function evolve(options: EvolveOptions = {}): Promise<EvolveResult> {
  const generations = options.generations ?? 1
  const records: GenerationRecord[] = []

  writePhase('orient', `measuring the current elia against ${ELIA_ROOT}`)
  const baselineCard = await measureFitness({
    sourceRoot: ELIA_ROOT,
    onTaskDone: (outcome) =>
      outcome.passed ? writePass(`${outcome.taskId} — ${outcome.detail}`) : writeFail(`${outcome.taskId} — ${outcome.error ?? outcome.detail}`),
  })
  process.stdout.write(renderScorecard(baselineCard, 'Baseline'))

  const firstBaseline = toMetrics(baselineCard)
  let baseline = firstBaseline

  for (let index = 0; index < generations; index++) {
    if (options.signal?.aborted) break

    const generation = nextGenerationNumber()
    const record = await runGeneration(generation, baseline, options)
    records.push(record)
    appendGeneration(record)

    if (record.verdict === 'promoted' && record.candidate) {
      // Stand on the winner: the next generation is measured against, and builds
      // on, the version that just won.
      baseline = record.candidate
    }
  }

  return { generations: records, baseline: firstBaseline, final: baseline }
}

async function runGeneration(
  generation: number,
  baseline: Metrics,
  options: EvolveOptions,
): Promise<GenerationRecord> {
  const startedAt = Date.now()
  const base: GenerationRecord = {
    generation,
    at: Date.now(),
    hypothesis: '',
    rationale: '',
    targetFiles: [],
    changedFiles: [],
    baseline,
    verdict: 'error',
    reason: '',
    model: config.model,
  }

  writePhase('propose', `generation ${generation}`)
  const sandbox = createSandbox(generation)

  // --- Hypothesise ----------------------------------------------------------

  const capture = createHypothesisTool()
  const readOnly = allWorkerTools().filter((tool) => ['read_file', 'list_files', 'grep'].includes(tool.name))

  const messages: ConversationMessage[] = [
    { role: 'user', content: [{ type: 'text', text: hypothesisBrief(sandbox, baseline) }] },
  ]

  await runAgentLoop({
    messages,
    systemPrompt: HYPOTHESIS_PROMPT,
    tools: [...readOnly, capture.tool],
    onText: writeText,
    useAnimation: true,
    verbose: true,
    maxSteps: HYPOTHESIS_MAX_STEPS,
    signal: options.signal,
  })

  const hypothesis = capture.taken()
  if (!hypothesis) {
    return { ...base, reason: 'the model never submitted a hypothesis' }
  }

  Object.assign(base, {
    hypothesis: hypothesis.title,
    rationale: hypothesis.rationale,
    targetFiles: hypothesis.targetFiles,
  })

  writeBlock(
    `Generation ${generation} hypothesis`,
    `  ${hypothesis.title}\n\n  Why: ${hypothesis.rationale}\n  Files: ${hypothesis.targetFiles.join(', ') || '(unspecified)'}\n\n  Plan: ${hypothesis.plan}`,
  )

  // --- Implement it inside the sandbox --------------------------------------

  writePhase('execute', `applying it in ${sandbox.root}`)
  const previousCwd = process.cwd()
  try {
    // The builder works on the copy. chdir so its relative paths land in the
    // sandbox even if it ignores the absolute paths it was given.
    process.chdir(sandbox.root)
    await runSubAgent({
      role: 'builder',
      name: `builder#gen${generation}`,
      prompt: implementationBrief(sandbox, hypothesis),
      signal: options.signal,
    })
  } finally {
    process.chdir(previousCwd)
  }

  // --- Gate -----------------------------------------------------------------

  writePhase('verify', `generation ${generation}`)

  const changed = changedFiles(sandbox)
  base.changedFiles = changed

  if (changed.length === 0) {
    return { ...base, reason: 'the builder changed nothing' }
  }
  writeSubStep(`changed ${changed.length} file${changed.length === 1 ? '' : 's'}`)
  process.stdout.write(`${describeChanges(sandbox, changed)}\n`)

  const violations = violatedImmutables(changed)
  if (violations.length > 0) {
    // Not treated as a bug to fix — the attempt is void, because a candidate that
    // edits the benchmark cannot be meaningfully scored by it.
    writeFail(`touched the fitness gate itself: ${violations.join(', ')}`)
    return {
      ...base,
      verdict: 'rejected',
      reason: `modified files it is not allowed to change (${violations.join(', ')}) — the benchmark cannot score a candidate that edits the benchmark`,
    }
  }

  const typecheck = await runShell('bun run typecheck', GATE_TIMEOUT_MS, sandbox.root)
  if (typecheck.exitCode !== 0) {
    if (looksUnavailable(typecheck.stderr)) {
      writeSubStep('typecheck unavailable in the sandbox — skipping that gate')
    } else {
      writeFail('typecheck failed')
      return {
        ...base,
        verdict: 'rejected',
        reason: `does not typecheck:\n${clampOutput(typecheck.stdout || typecheck.stderr, 800)}`,
      }
    }
  } else {
    writePass('typecheck')
  }

  const unitTests = await runShell('bun test', GATE_TIMEOUT_MS, sandbox.root)
  if (unitTests.exitCode !== 0) {
    writeFail('unit tests failed')
    return {
      ...base,
      verdict: 'rejected',
      reason: `unit tests fail:\n${clampOutput(unitTests.stderr || unitTests.stdout, 800)}`,
    }
  }
  writePass('unit tests')

  // --- Measure the candidate, using the candidate ---------------------------

  writeSubStep('running the benchmark against the candidate')
  let candidateCard: Scorecard
  try {
    candidateCard = await measureFitness({
      sourceRoot: sandbox.root,
      onTaskDone: (outcome) =>
        outcome.passed ? writePass(`${outcome.taskId} — ${outcome.detail}`) : writeFail(`${outcome.taskId} — ${outcome.error ?? outcome.detail}`),
    })
  } catch (err) {
    return { ...base, reason: `benchmark could not run: ${err instanceof Error ? err.message : String(err)}` }
  }
  process.stdout.write(renderScorecard(candidateCard, `Generation ${generation}`))

  const candidate = toMetrics(candidateCard)
  base.candidate = candidate

  const comparison = compareScorecards(baseline, candidate)
  if (!comparison.better) {
    writeFail(`rejected: ${comparison.reason}`)
    writeSubStep(`sandbox kept at ${sandbox.root} if you want to look`)
    return { ...base, verdict: 'rejected', reason: comparison.reason }
  }

  if (options.dryRun) {
    writePass(`would promote: ${comparison.reason}`)
    writeSubStep('dry run — the live source was not modified')
    return { ...base, verdict: 'rejected', reason: `dry run; would have been promoted (${comparison.reason})` }
  }

  const backupDir = promote(sandbox, changed)
  writePass(`promoted: ${comparison.reason}`)
  writeSummary(`Generation ${generation} promoted`, [
    ['change', hypothesis.title],
    ['files', changed.join(', ')],
    ['pass rate', `${Math.round(baseline.passRate * 100)}% → ${Math.round(candidate.passRate * 100)}%`],
    ['tokens', `${baseline.totalTokens} → ${candidate.totalTokens}`],
    ['took', formatElapsed(Date.now() - startedAt)],
    ['rollback', `copy ${backupDir} back over ${ELIA_ROOT}`],
  ])

  return { ...base, verdict: 'promoted', reason: comparison.reason }
}

const HYPOTHESIS_PROMPT = `You are elia, examining your own source code in order to improve yourself.

You have read-only tools. This phase produces exactly one thing: a single, specific, testable hypothesis about what change to your own implementation would make you measurably better at the benchmark, submitted with \`submit_hypothesis\`.

How to choose well:
- Start from the evidence. A task that FAILED tells you far more than any amount of reading — go and understand why it failed before proposing anything.
- Change one thing. A hypothesis touching four files cannot be attributed when the score moves, and it will not be promoted if any part of it regresses.
- Prefer changes to how you *decide* over changes to how you *execute*: the system prompt, the role prompts, the planner's guidance, the tool descriptions the model reads, the loop's policy on when to batch or delegate. These compound, because they also improve the next attempt at improving yourself.
- Tool descriptions are prompt, not documentation. A tool the model misuses is usually a tool whose description does not say when to reach for it.
- Do not propose speculative rewrites, new abstractions for their own sake, or "clean up X". If you cannot name the benchmark task that gets better and say how, it is not a hypothesis.

Be honest about mechanism. "Improve the prompt to be clearer" is not a hypothesis; "the precise-edit task fails because the system prompt never tells the model to re-read a file after editing it, so it cannot notice it matched the wrong occurrence" is.`

function hypothesisBrief(sandbox: Sandbox, baseline: Metrics): string {
  const failing = baseline.failed.length > 0 ? baseline.failed.join(', ') : '(none — everything currently passes)'

  return `## Your own source
It is copied at: ${sandbox.root}
Read it there (that copy is what will be modified). The structure mirrors the real installation at ${ELIA_ROOT}.

## How you are scored
The benchmark is in src/evolve/suite.ts — read it, it defines exactly what "better" means. Each task runs a real agent loop in a temporary repository and is checked by code, not by a model.

Current weighted pass rate: ${Math.round(baseline.passRate * 100)}%
Passing: ${baseline.passed.join(', ') || '(none)'}
FAILING: ${failing}
Cost of one full run: ${baseline.totalTokens} tokens, ${Math.round(baseline.totalElapsedMs / 1000)}s of agent time.

## What you may not change
These files define how you are judged, and editing them is an automatic rejection:
${IMMUTABLE_FILES.map((file) => `- ${file}`).join('\n')}

Improving your score by changing the benchmark is not improvement. Do not attempt it.

## What has already been tried
${renderLedgerForPrompt()}

Investigate, then submit exactly one hypothesis.`
}

function implementationBrief(sandbox: Sandbox, hypothesis: Hypothesis): string {
  return `Implement this one change to elia's own source, in the copy at ${sandbox.root}.

## The change
${hypothesis.title}

## Why
${hypothesis.rationale}

## The plan
${hypothesis.plan}

## Expected files
${hypothesis.targetFiles.map((file) => `- ${file}`).join('\n') || '(the plan does not name specific files)'}

## Rules
- Work ONLY inside ${sandbox.root}. Never touch ${ELIA_ROOT} — that is the live installation.
- Implement exactly this change. Nothing else. Unrelated edits will cause the whole generation to be rejected even if your change was good.
- Do NOT modify any of these, at all: ${IMMUTABLE_FILES.join(', ')}. They define how the change is judged.
- Do not run git commands.
- The change must typecheck (\`bun run typecheck\`) and keep the existing tests passing (\`bun test\`). Run both yourself before you finish, from inside ${sandbox.root}.

Report what you changed and why it should move the benchmark.`
}

interface HypothesisCapture {
  tool: Tool
  taken(): Hypothesis | undefined
}

function createHypothesisTool(): HypothesisCapture {
  let captured: Hypothesis | undefined

  const tool: Tool = {
    name: 'submit_hypothesis',
    description:
      'Submit the single change you want to make to elia\'s own source, then stop. Call this exactly once. It must name the benchmark task it is expected to improve and explain the mechanism by which it does so.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The change itself, in one line' },
        rationale: {
          type: 'string',
          description:
            'The mechanism: what currently goes wrong, in which task, and why this change fixes that specifically',
        },
        targetFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repo-relative files you intend to modify, e.g. "src/config.ts"',
        },
        plan: { type: 'string', description: 'Concretely what to change in those files' },
      },
      required: ['title', 'rationale', 'plan'],
    },
    async execute(input) {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : ''
      const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
      if (!title || !rationale || !plan) throw new Error('title, rationale, and plan are all required')

      const targetFiles = Array.isArray(input.targetFiles)
        ? input.targetFiles.filter((file): file is string => typeof file === 'string')
        : []

      const forbidden = targetFiles.filter((file) => IMMUTABLE_FILES.includes(file.replace(/\\/g, '/')))
      if (forbidden.length > 0) {
        throw new Error(
          `${forbidden.join(', ')} define how you are judged and cannot be changed. Propose a different hypothesis that improves the agent instead of the benchmark.`,
        )
      }

      captured = { title, rationale, targetFiles, plan }
      return 'Hypothesis recorded. Stop now — implementation happens in a separate step.'
    },
  }

  return {
    tool,
    taken() {
      const hypothesis = captured
      captured = undefined
      return hypothesis
    },
  }
}

/** Distinguishes "the gate found a real problem" from "the gate could not run at all". */
function looksUnavailable(stderr: string): boolean {
  return /not found|command not found|ENOENT|Cannot find module/i.test(stderr)
}

/** Reads elia's own package version, for reporting. */
export function eliaVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(ELIA_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
