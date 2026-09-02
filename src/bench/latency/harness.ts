import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELIA_ROOT } from '../../statePaths.ts'
import { runAgentLoop } from '../../agentLoop.ts'
import { createToolResultCache } from '../../speculation/cache.ts'
import { createPrefetcher } from '../../speculation/prefetch.ts'
import { readFileTool } from '../../tools/readFile.ts'
import { editFileTool } from '../../tools/editFile.ts'
import { listFilesTool } from '../../tools/listFiles.ts'
import { grepTool } from '../../tools/grep.ts'
import { writeFileTool } from '../../tools/writeFile.ts'
import type { Tool } from '../../tools/types.ts'
import { totalTokens } from '../../usage.ts'
import { LATENCY_SCENARIOS, type LatencyScenario } from './scenarios.ts'
import { createScriptedProvider, type ScriptedProviderOptions } from './scriptedProvider.ts'

/** The minimal toolset the scenarios use — kept small so tool-registry size isn't a variable. */
const SCENARIO_TOOLS: Tool[] = [readFileTool, editFileTool, listFilesTool, grepTool, writeFileTool]

const SYSTEM_PROMPT =
  'You are elia, a fast autonomous coding agent in a terminal. Work directly and concisely. ' +
  'Batch independent reads and searches into ONE turn — issue every read_file / grep / list_files call you can in a ' +
  'single response so they run in parallel; each extra turn is a full model round-trip. Read a file before editing it.'

export interface ScenarioResult {
  id: string
  description: string
  runs: number
  wallMsMedian: number
  wallMsMin: number
  firstTokenMsMedian: number
  /** Structural — deterministic under the scripted provider; advisory under a live model. */
  roundTrips: number
  toolCalls: number
  cachedToolCalls: number
  speculativeHits: number
  speculativeMisses: number
  /** Output tokens the model generated (live mode only; 0 under the scripted provider). */
  outputTokensMedian: number
  /** Generated tokens per wall-clock second (live mode only). */
  tokensPerSecMedian: number
  /** True when roundTrips / toolCalls / cachedToolCalls match the scenario's declared expectations. Advisory in live mode. */
  structuralOk: boolean
  notes: string[]
}

export interface LatencyReport {
  generatedAt: string
  /** True when a real configured provider drove the scenarios instead of the scripted one. */
  live: boolean
  /** The model that ran (live mode), or "scripted". */
  model: string
  /** Median wall time of a bare `elia` process that loads its module graph and exits. */
  coldStartMsMedian: number
  /** Simulated model pacing (scripted mode; 0/0 = pure elia overhead). */
  modelPacing: { ttftMs: number; tokenMs: number }
  scenarios: ScenarioResult[]
}

export interface RunHarnessOptions {
  /** Runs per scenario; the median is reported. Default 3 (scripted) / 1 (live). */
  runsPerScenario?: number
  /** Simulate a real model's pacing. Ignored in live mode. Default { ttftMs: 0, tokenMs: 0 }. */
  pacing?: ScriptedProviderOptions
  /**
   * Drive the scenarios with the real configured provider (`config.provider`)
   * instead of the scripted one. Real end-to-end wall-clock and round-trip
   * counts, at the cost of real API calls and non-determinism.
   */
  live?: boolean
  /** Subset of scenario ids to run. Default: all. */
  only?: string[]
  /** Skip the (process-spawning) cold-start measurement. */
  skipColdStart?: boolean
  onScenarioDone?: (result: ScenarioResult) => void
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

interface SingleRun {
  wallMs: number
  firstTokenMs: number
  roundTrips: number
  toolCalls: number
  cachedToolCalls: number
  speculativeHits: number
  speculativeMisses: number
  outputTokens: number
}

interface ScenarioRunOptions {
  pacing: ScriptedProviderOptions
  live: boolean
}

async function runScenarioOnce(scenario: LatencyScenario, options: ScenarioRunOptions): Promise<SingleRun> {
  const dir = mkdtempSync(join(tmpdir(), `elia-lat-${scenario.id}-`))
  const originalCwd = process.cwd()
  try {
    scenario.setup(dir)
    process.chdir(dir)

    const cache = createToolResultCache()
    const prefetcher = createPrefetcher({ tools: SCENARIO_TOOLS, cache, cwd: dir })

    let providerOpts: { provider: import('../../providers/types.ts').Provider; providerName: string; model: string }
    if (options.live) {
      const { config } = await import('../../config.ts')
      providerOpts = { provider: config.provider, providerName: config.providerName, model: config.model }
    } else {
      providerOpts = { provider: createScriptedProvider(scenario.turns, options.pacing), providerName: 'scripted', model: 'scripted-latency' }
    }

    let firstTokenMs = 0
    let toolCalls = 0
    let cachedToolCalls = 0
    const startedAt = performance.now()

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: scenario.prompt }] }],
      systemPrompt: SYSTEM_PROMPT,
      tools: SCENARIO_TOOLS,
      ...providerOpts,
      useAnimation: false,
      verbose: false,
      cache,
      prefetcher,
      maxSteps: 20,
      onText: () => {
        if (firstTokenMs === 0) firstTokenMs = performance.now() - startedAt
      },
      onTool: (event) => {
        toolCalls += 1
        if (event.cached) cachedToolCalls += 1
      },
    })

    const wallMs = performance.now() - startedAt
    const stats = result.cacheStats ?? { speculated: 0, hits: 0, misses: 0 }
    return {
      wallMs,
      firstTokenMs,
      roundTrips: result.steps,
      toolCalls,
      cachedToolCalls,
      speculativeHits: stats.hits,
      speculativeMisses: stats.misses,
      outputTokens: result.usage.outputTokens,
    }
  } finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function measureColdStart(samples = 5): Promise<number> {
  const entry = join(ELIA_ROOT, 'bin', 'elia.ts')
  const timings: number[] = []
  for (let i = 0; i < samples; i++) {
    const startedAt = performance.now()
    const proc = Bun.spawn(['bun', 'run', entry, 'bench-latency', '--startup-probe'], {
      cwd: ELIA_ROOT,
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, ELIA_STARTUP_PROBE: '1' },
    })
    await proc.exited
    timings.push(performance.now() - startedAt)
  }
  return median(timings)
}

export async function runLatencyHarness(options: RunHarnessOptions = {}): Promise<LatencyReport> {
  const live = options.live ?? false
  const runsPerScenario = options.runsPerScenario ?? (live ? 1 : 3)
  const pacing = options.pacing ?? { ttftMs: 0, tokenMs: 0 }
  const scenarios = options.only
    ? LATENCY_SCENARIOS.filter((scenario) => options.only!.includes(scenario.id))
    : LATENCY_SCENARIOS

  let model = 'scripted'
  if (live) {
    const { config } = await import('../../config.ts')
    model = `${config.providerName}/${config.model}`
  }

  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    const runs: SingleRun[] = []
    for (let i = 0; i < runsPerScenario; i++) runs.push(await runScenarioOnce(scenario, { pacing, live }))

    const notes: string[] = []
    const structural = (key: keyof SingleRun): number => {
      const values = new Set(runs.map((run) => run[key]))
      if (!live && values.size > 1) notes.push(`${key} was not deterministic across runs: ${[...values].join(', ')}`)
      return runs[0]![key]
    }

    const roundTrips = structural('roundTrips')
    const toolCalls = structural('toolCalls')
    const cachedToolCalls = structural('cachedToolCalls')

    const matchesExpectations =
      roundTrips === scenario.expect.roundTrips &&
      toolCalls === scenario.expect.toolCalls &&
      cachedToolCalls === scenario.expect.cachedToolCalls
    if (!matchesExpectations) {
      const line = `expected roundTrips=${scenario.expect.roundTrips} toolCalls=${scenario.expect.toolCalls} cachedToolCalls=${scenario.expect.cachedToolCalls}, got ${roundTrips}/${toolCalls}/${cachedToolCalls}`
      notes.push(live ? `model chose a different shape — ${line}` : `structural mismatch — ${line}`)
    }

    const wallMedian = round(median(runs.map((run) => run.wallMs)))
    const outputTokensMedian = round(median(runs.map((run) => run.outputTokens)))
    const result: ScenarioResult = {
      id: scenario.id,
      description: scenario.description,
      runs: runsPerScenario,
      wallMsMedian: wallMedian,
      wallMsMin: round(Math.min(...runs.map((run) => run.wallMs))),
      firstTokenMsMedian: round(median(runs.map((run) => run.firstTokenMs))),
      roundTrips,
      toolCalls,
      cachedToolCalls,
      speculativeHits: structural('speculativeHits'),
      speculativeMisses: structural('speculativeMisses'),
      outputTokensMedian,
      tokensPerSecMedian: wallMedian > 0 ? round((outputTokensMedian / wallMedian) * 1000) : 0,
      // In live mode a different shape is information, not a failure.
      structuralOk: live ? true : matchesExpectations,
      notes,
    }
    results.push(result)
    options.onScenarioDone?.(result)
  }

  return {
    generatedAt: new Date().toISOString(),
    live,
    model,
    coldStartMsMedian: options.skipColdStart ? 0 : round(await measureColdStart()),
    modelPacing: { ttftMs: pacing.ttftMs ?? 0, tokenMs: pacing.tokenMs ?? 0 },
    scenarios: results,
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
