import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyPromotion, evaluatePromotion, type PromotionDecision } from '../../autonomy/promotionGuard.ts'
import { runLatencyHarness, type LatencyReport, type ScenarioResult } from '../../bench/latency/harness.ts'
import { compareLatency, type LatencyComparison } from '../../bench/latency/report.ts'
import { LATENCY_SCENARIOS } from '../../bench/latency/scenarios.ts'
import { compoundingStatus, recordBenchRun, type StageReport } from '../../compounding/status.ts'
import { config } from '../../config.ts'
import { clusterByDominantRole, collectDistillableTraces, type DistillableTrace } from '../../distill/corpus.ts'
import { fragmentCount } from '../../distill/fragments.ts'
import { evaluateCandidate } from '../../distill/gate.ts'
import { proposeDistillations } from '../../distill/mine.ts'
import { measureLiveTree } from '../../evolve/baselineCache.ts'
import { evolve } from '../../evolve/engine.ts'
import { benchRepeats, measureFitness, type TaskOutcome } from '../../evolve/fitness.ts'
import type { GenerationRecord, Metrics } from '../../evolve/ledger.ts'
import { claimMeasureSlot, describeHolder } from '../../evolve/measureSlot.ts'
import { allBenchTasks, BENCH_TASKS } from '../../evolve/suite.ts'
import type { BenchTask } from '../../evolve/task.ts'
import { ELIA_ROOT } from '../../statePaths.ts'
import { redactRecord, redactText, relativizeProjectPaths } from '../../ui/redact.ts'
import { MCP_FEATURE_BY_NAME } from '../featureInventory.ts'
import { defineMcpTool, type JsonSchema, type McpFeatureMetadata, type McpToolDefinition, type McpToolExecutionContext } from '../serverTypes.ts'

type RecordValue = Record<string, unknown>
type ToolHandler = (input: RecordValue, context: McpToolExecutionContext) => unknown | Promise<unknown>
type ToolMetadata = Omit<McpToolDefinition, 'execute'>
type BenchmarkSet = 'builtin' | 'history' | 'all' | 'selected'

const DEFAULT_TASK_LIMIT = 20
const MAX_TASK_LIMIT = 50
const MAX_GENERATIONS = 3
const MAX_DISTILL_TRACES = 20
const MAX_DISTILL_CANDIDATES = 3
const MAX_RETURNED_PATHS = 100
const MAX_RETURNED_REASONS = 20
const MAX_LATENCY_RUNS = 10
const PROOF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.promotion\.json$/
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

const EMPTY_INPUT: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const TASK_IDS_SCHEMA: JsonSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 160, pattern: TASK_ID_PATTERN.source },
  minItems: 1,
  maxItems: MAX_TASK_LIMIT,
  uniqueItems: true,
}

const METRICS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    passRate: { type: 'number', minimum: 0, maximum: 1 },
    passed: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: MAX_TASK_LIMIT },
    failed: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: MAX_TASK_LIMIT },
    unmeasured: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: MAX_TASK_LIMIT },
    steps: { type: 'object', additionalProperties: { type: 'number', minimum: 0 }, maxProperties: MAX_TASK_LIMIT },
    taskRates: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 }, maxProperties: MAX_TASK_LIMIT },
    totalTokens: { type: 'integer', minimum: 0 },
    totalElapsedMs: { type: 'integer', minimum: 0 },
    wallClockMs: { type: 'integer', minimum: 0 },
    cacheHitRate: { type: 'number', minimum: 0, maximum: 1 },
    cacheHits: { type: 'integer', minimum: 0 },
    cacheMisses: { type: 'integer', minimum: 0 },
    costUsd: { type: 'number', minimum: 0 },
  },
  required: ['passRate', 'passed', 'failed', 'unmeasured', 'totalTokens', 'totalElapsedMs'],
  additionalProperties: false,
}

const EVOLVE_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    dryRun: { type: 'boolean', const: true },
    selection: {
      type: 'object',
      properties: {
        taskIds: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: MAX_TASK_LIMIT },
        count: { type: 'integer', minimum: 1, maximum: MAX_TASK_LIMIT },
        limit: { type: 'integer', minimum: 1, maximum: MAX_TASK_LIMIT },
      },
      required: ['taskIds', 'count', 'limit'],
      additionalProperties: false,
    },
    generations: {
      type: 'array',
      maxItems: MAX_GENERATIONS,
      items: {
        type: 'object',
        properties: {
          generation: { type: 'integer', minimum: 1 },
          at: { type: 'integer', minimum: 0 },
          verdict: { type: 'string', enum: ['promoted', 'rejected', 'error'] },
          hypothesis: { type: 'string', maxLength: 1_000 },
          rationale: { type: 'string', maxLength: 2_000 },
          targetFiles: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: MAX_RETURNED_PATHS },
          changedFiles: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: MAX_RETURNED_PATHS },
          reason: { type: 'string', maxLength: 2_000 },
          model: { type: 'string', maxLength: 200 },
          improverModel: { type: 'string', maxLength: 200 },
          funnel: { type: 'string', maxLength: 200 },
          branch: { type: 'string', maxLength: 500 },
          commit: { type: 'string', maxLength: 100 },
          baseline: METRICS_SCHEMA,
          candidate: METRICS_SCHEMA,
        },
        required: ['generation', 'at', 'verdict', 'hypothesis', 'rationale', 'targetFiles', 'changedFiles', 'reason', 'model', 'baseline'],
        additionalProperties: false,
      },
    },
    baseline: METRICS_SCHEMA,
    final: METRICS_SCHEMA,
    stoppedReason: { type: 'string', maxLength: 2_000 },
  },
  required: ['ok', 'dryRun', 'selection', 'generations', 'baseline', 'final'],
  additionalProperties: false,
}

const BENCH_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    set: { type: 'string', enum: ['builtin', 'history', 'all', 'selected'] },
    taskCount: { type: 'integer', minimum: 1, maximum: MAX_TASK_LIMIT },
    reused: { type: 'integer', minimum: 0, maximum: MAX_TASK_LIMIT },
    complete: { type: 'boolean' },
    model: { type: 'string', maxLength: 200 },
    passRate: { type: 'number', minimum: 0, maximum: 1 },
    unmeasured: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: MAX_TASK_LIMIT },
    totalTokens: { type: 'integer', minimum: 0 },
    totalElapsedMs: { type: 'integer', minimum: 0 },
    wallClockMs: { type: 'integer', minimum: 0 },
    cacheHitRate: { type: 'number', minimum: 0, maximum: 1 },
    outcomes: {
      type: 'array',
      maxItems: MAX_TASK_LIMIT,
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string', maxLength: 160 },
          weight: { type: 'number', minimum: 0 },
          passed: { type: 'boolean' },
          detail: { type: 'string', maxLength: 1_000 },
          error: { type: 'string', maxLength: 1_000 },
          stopReason: { type: 'string', maxLength: 200 },
          steps: { type: 'integer', minimum: 0 },
          elapsedMs: { type: 'integer', minimum: 0 },
          totalTokens: { type: 'integer', minimum: 0 },
          model: { type: 'string', maxLength: 200 },
          unmeasured: { type: 'boolean' },
          attempts: { type: 'integer', minimum: 0 },
          passes: { type: 'integer', minimum: 0 },
        },
        required: ['taskId', 'weight', 'passed', 'detail', 'steps', 'elapsedMs', 'totalTokens'],
        additionalProperties: false,
      },
    },
  },
  required: ['ok', 'set', 'taskCount', 'reused', 'complete', 'model', 'passRate', 'unmeasured', 'totalTokens', 'totalElapsedMs', 'wallClockMs', 'cacheHitRate', 'outcomes'],
  additionalProperties: false,
}

const DISTILL_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    promoted: { type: 'boolean', const: false },
    tracesAvailable: { type: 'integer', minimum: 0 },
    tracesConsidered: { type: 'integer', minimum: 0, maximum: MAX_DISTILL_TRACES },
    minCluster: { type: 'integer', minimum: 3, maximum: 10 },
    activeFragments: { type: 'integer', minimum: 0 },
    candidates: {
      type: 'array',
      maxItems: MAX_DISTILL_CANDIDATES,
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', maxLength: 100 },
          fragment: { type: 'string', maxLength: 400 },
          rationale: { type: 'string', maxLength: 1_000 },
          sourceRunIds: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: MAX_DISTILL_TRACES },
          verdict: { type: 'string', enum: ['promoted', 'rejected', 'dry-run-pass'] },
          reason: { type: 'string', maxLength: 1_500 },
          stages: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 10 },
        },
        required: ['role', 'fragment', 'rationale', 'sourceRunIds', 'verdict', 'reason', 'stages'],
        additionalProperties: false,
      },
    },
  },
  required: ['ok', 'promoted', 'tracesAvailable', 'tracesConsidered', 'minCluster', 'activeFragments', 'candidates'],
  additionalProperties: false,
}

const PROMOTE_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    proofId: { type: 'string', maxLength: 160 },
    attemptId: { type: 'string', maxLength: 200 },
    approved: { type: 'boolean' },
    applied: { type: 'boolean' },
    applyRequested: { type: 'boolean' },
    evaluatedAt: { type: 'integer', minimum: 0 },
    changedFiles: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: MAX_RETURNED_PATHS },
    reasons: { type: 'array', items: { type: 'string', maxLength: 1_500 }, maxItems: MAX_RETURNED_REASONS },
    benchmarkReasons: { type: 'array', items: { type: 'string', maxLength: 1_500 }, maxItems: MAX_RETURNED_REASONS },
    backupCreated: { type: 'boolean' },
  },
  required: ['ok', 'proofId', 'attemptId', 'approved', 'applied', 'applyRequested', 'evaluatedAt', 'changedFiles', 'reasons', 'benchmarkReasons', 'backupCreated'],
  additionalProperties: false,
}

const COMPOUNDING_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    generatedAt: { type: 'integer', minimum: 0 },
    summary: {
      type: 'object',
      properties: {
        total: { type: 'integer', minimum: 0, maximum: 6 },
        working: { type: 'integer', minimum: 0, maximum: 6 },
        partial: { type: 'integer', minimum: 0, maximum: 6 },
        blocked: { type: 'integer', minimum: 0, maximum: 6 },
        noEvidence: { type: 'integer', minimum: 0, maximum: 6 },
      },
      required: ['total', 'working', 'partial', 'blocked', 'noEvidence'],
      additionalProperties: false,
    },
    stages: {
      type: 'array',
      minItems: 6,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          stage: { type: 'integer', minimum: 1, maximum: 6 },
          name: { type: 'string', maxLength: 200 },
          state: { type: 'string', enum: ['working', 'partial', 'blocked', 'no evidence'] },
          evidence: { type: 'string', maxLength: 2_000 },
          next: { type: 'string', maxLength: 1_000 },
        },
        required: ['stage', 'name', 'state', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['ok', 'generatedAt', 'summary', 'stages'],
  additionalProperties: false,
}

const LATENCY_SCENARIO_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    description: { type: 'string', maxLength: 500 },
    runs: { type: 'integer', minimum: 1, maximum: MAX_LATENCY_RUNS },
    wallMsP50: { type: 'number', minimum: 0 },
    wallMsMin: { type: 'number', minimum: 0 },
    firstTokenMsP50: { type: 'number', minimum: 0 },
    roundTrips: { type: 'integer', minimum: 0 },
    toolCalls: { type: 'integer', minimum: 0 },
    cachedToolCalls: { type: 'integer', minimum: 0 },
    speculativeHits: { type: 'integer', minimum: 0 },
    speculativeMisses: { type: 'integer', minimum: 0 },
    structuralOk: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string', maxLength: 1_000 }, maxItems: 20 },
  },
  required: ['id', 'description', 'runs', 'wallMsP50', 'wallMsMin', 'firstTokenMsP50', 'roundTrips', 'toolCalls', 'cachedToolCalls', 'speculativeHits', 'speculativeMisses', 'structuralOk', 'notes'],
  additionalProperties: false,
}

const LATENCY_REPORT_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    generatedAt: { type: 'string', maxLength: 100 },
    live: { type: 'boolean', const: false },
    model: { type: 'string', maxLength: 200 },
    coldStartMsP50: { type: 'number', minimum: 0 },
    modelPacing: {
      type: 'object',
      properties: {
        ttftMs: { type: 'integer', minimum: 0 },
        tokenMs: { type: 'integer', minimum: 0 },
      },
      required: ['ttftMs', 'tokenMs'],
      additionalProperties: false,
    },
    scenarios: { type: 'array', maxItems: LATENCY_SCENARIOS.length, items: LATENCY_SCENARIO_OUTPUT },
  },
  required: ['generatedAt', 'live', 'model', 'coldStartMsP50', 'modelPacing', 'scenarios'],
  additionalProperties: false,
}

const LATENCY_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    live: { type: 'boolean', const: false },
    baselineUpdated: { type: 'boolean', const: false },
    strict: { type: 'boolean' },
    current: LATENCY_REPORT_OUTPUT,
    baseline: LATENCY_REPORT_OUTPUT,
    comparison: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        regressions: { type: 'array', items: { type: 'string', maxLength: 1_500 }, maxItems: 50 },
        warnings: { type: 'array', items: { type: 'string', maxLength: 1_500 }, maxItems: 50 },
        improvements: { type: 'array', items: { type: 'string', maxLength: 1_500 }, maxItems: 50 },
      },
      required: ['ok', 'regressions', 'warnings', 'improvements'],
      additionalProperties: false,
    },
  },
  required: ['ok', 'live', 'baselineUpdated', 'strict', 'current', 'baseline', 'comparison'],
  additionalProperties: false,
}

function assertLive(context: McpToolExecutionContext, tool: string): void {
  if (context.signal?.aborted === true) throw new Error(`${tool}: the request was cancelled before it completed.`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeText(value: string, maxLength: number, cwd: string): string {
  return redactText(relativizeProjectPaths(value, cwd), maxLength)
}

function safeError(error: unknown, cwd: string): string {
  return safeText(errorMessage(error), 1_000, cwd)
}

function safePaths(paths: readonly string[], cwd: string): string[] {
  return paths.slice(0, MAX_RETURNED_PATHS).map((path) => safeText(path, 500, cwd))
}

function safeReasons(reasons: readonly string[], cwd: string): string[] {
  return reasons.slice(0, MAX_RETURNED_REASONS).map((reason) => safeText(reason, 1_500, cwd))
}

function assertOnlyKeys(input: RecordValue, allowed: readonly string[], tool: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${tool}: unsupported input ${unknown.sort()[0] ?? ''}.`)
}

function optionalInteger(input: RecordValue, key: string, fallback: number, minimum: number, maximum: number, tool: string): number {
  const value = input[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${tool}: "${key}" must be an integer from ${minimum} to ${maximum}.`)
  }
  return value
}

function optionalBoolean(input: RecordValue, key: string, fallback: boolean, tool: string): boolean {
  const value = input[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${tool}: "${key}" must be true or false.`)
  return value
}

function optionalStringArray(input: RecordValue, key: string, maximum: number, tool: string): string[] | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${tool}: "${key}" must contain from 1 to ${maximum} task ids.`)
  }
  const values = value.map((item) => {
    if (typeof item !== 'string' || !TASK_ID_PATTERN.test(item)) {
      throw new Error(`${tool}: "${key}" contains an invalid task id.`)
    }
    return item
  })
  if (new Set(values).size !== values.length) throw new Error(`${tool}: "${key}" must not contain duplicate task ids.`)
  return values
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function numericMap(value: Record<string, number> | undefined, limit: number): Record<string, number> {
  return Object.fromEntries(Object.entries(value ?? {}).slice(0, limit).map(([key, entry]) => [safeText(key, 160, ELIA_ROOT), finiteNumber(entry)]))
}

function metricsView(metrics: Metrics, cwd: string): RecordValue {
  const wallClockMs = finiteNumber(metrics.wallClockMs)
  const result: RecordValue = {
    passRate: finiteNumber(metrics.passRate),
    passed: safePaths(metrics.passed, cwd).slice(0, MAX_TASK_LIMIT),
    failed: safePaths(metrics.failed, cwd).slice(0, MAX_TASK_LIMIT),
    unmeasured: safePaths(metrics.unmeasured ?? [], cwd).slice(0, MAX_TASK_LIMIT),
    steps: numericMap(metrics.steps, MAX_TASK_LIMIT),
    taskRates: numericMap(metrics.taskRates, MAX_TASK_LIMIT),
    totalTokens: finiteNumber(metrics.totalTokens),
    totalElapsedMs: finiteNumber(metrics.totalElapsedMs),
    wallClockMs,
  }
  if (metrics.cacheHitRate !== undefined) result.cacheHitRate = finiteNumber(metrics.cacheHitRate)
  if (metrics.cacheHits !== undefined) result.cacheHits = finiteNumber(metrics.cacheHits)
  if (metrics.cacheMisses !== undefined) result.cacheMisses = finiteNumber(metrics.cacheMisses)
  if (metrics.costUsd !== undefined) result.costUsd = finiteNumber(metrics.costUsd)
  return result
}

function generationView(record: GenerationRecord, cwd: string): RecordValue {
  const result: RecordValue = {
    generation: finiteNumber(record.generation),
    at: finiteNumber(record.at),
    verdict: record.verdict,
    hypothesis: safeText(record.hypothesis, 1_000, cwd),
    rationale: safeText(record.rationale, 2_000, cwd),
    targetFiles: safePaths(record.targetFiles, cwd),
    changedFiles: safePaths(record.changedFiles, cwd),
    reason: safeText(record.reason, 2_000, cwd),
    model: safeText(record.model, 200, cwd),
    baseline: metricsView(record.baseline ?? { passRate: 0, passed: [], failed: [], totalTokens: 0, totalElapsedMs: 0 }, cwd),
  }
  if (record.candidate) result.candidate = metricsView(record.candidate, cwd)
  if (record.improverModel) result.improverModel = safeText(record.improverModel, 200, cwd)
  if (record.funnel) result.funnel = safeText(record.funnel, 200, cwd)
  if (record.branch) result.branch = safeText(record.branch, 500, cwd)
  if (record.commit) result.commit = safeText(record.commit, 100, cwd)
  return result
}

function selectTasks(options: {
  tool: string
  taskIds?: string[]
  limit: number
  set?: Exclude<BenchmarkSet, 'selected'>
}): { tasks: BenchTask[]; set: BenchmarkSet } {
  const all = allBenchTasks()
  const builtInIds = new Set(BENCH_TASKS.map((task) => task.id))
  const set: BenchmarkSet = options.taskIds ? 'selected' : options.set ?? 'builtin'
  let pool = all
  if (!options.taskIds && set === 'builtin') pool = BENCH_TASKS
  else if (!options.taskIds && set === 'history') pool = all.filter((task) => !builtInIds.has(task.id))
  if (options.taskIds && options.set === 'builtin') pool = BENCH_TASKS
  if (options.taskIds && options.set === 'history') pool = all.filter((task) => !builtInIds.has(task.id))

  const byId = new Map(all.map((task) => [task.id, task] as const))
  if (options.taskIds) {
    const selected = options.taskIds.map((id) => {
      const task = byId.get(id)
      if (!task) throw new Error(`${options.tool}: unknown benchmark task "${id}".`)
      return task
    })
    if (selected.some((task) => !pool.some((candidate) => candidate.id === task.id))) {
      throw new Error(`${options.tool}: a task id is outside the requested benchmark set.`)
    }
    return { tasks: selected, set }
  }
  if (pool.length === 0) throw new Error(`${options.tool}: the requested benchmark set is empty.`)
  return { tasks: pool.slice(0, options.limit), set }
}

function recordedBenchSet(tasks: readonly BenchTask[], set: BenchmarkSet): string {
  const all = allBenchTasks()
  const builtInIds = new Set(BENCH_TASKS.map((task) => task.id))
  const pools: readonly [string, BenchTask[]][] = [
    ['all', all],
    ['synthetic', BENCH_TASKS],
    ['history', all.filter((task) => !builtInIds.has(task.id))],
  ]
  const selected = new Set(tasks.map((task) => task.id))
  const expected = set === 'selected' ? pools : pools.filter(([name]) => name === (set === 'builtin' ? 'synthetic' : set))
  const complete = expected.find(([, pool]) => pool.length === selected.size && pool.every((task) => selected.has(task.id)))
  return complete?.[0] ?? `mcp/${set}:${tasks.length}`
}

function claimSlot(command: string, context: McpToolExecutionContext, tool: string): { release: () => void } {
  assertLive(context, tool)
  const claim = claimMeasureSlot(command)
  if (!claim.ok) throw new Error(`${tool}: ${safeText(describeHolder(claim.holder), 1_000, context.cwd)}`)
  return claim
}

function taskOutcomeView(outcome: TaskOutcome, cwd: string): RecordValue {
  const result: RecordValue = {
    taskId: safeText(outcome.taskId, 160, cwd),
    weight: finiteNumber(outcome.weight),
    passed: outcome.passed,
    detail: safeText(outcome.detail, 1_000, cwd),
    steps: finiteNumber(outcome.steps),
    elapsedMs: finiteNumber(outcome.elapsedMs),
    totalTokens: finiteNumber(outcome.totalTokens),
  }
  if (outcome.error) result.error = safeText(outcome.error, 1_000, cwd)
  if (outcome.stopReason) result.stopReason = safeText(outcome.stopReason, 200, cwd)
  if (outcome.model) result.model = safeText(outcome.model, 200, cwd)
  if (outcome.unmeasured !== undefined) result.unmeasured = outcome.unmeasured
  if (outcome.attempts !== undefined) result.attempts = finiteNumber(outcome.attempts)
  if (outcome.passes !== undefined) result.passes = finiteNumber(outcome.passes)
  return result
}

function boundedDistillationTraces(traces: readonly DistillableTrace[], minCluster: number): DistillableTrace[] {
  const eligible = [...clusterByDominantRole(traces.slice(0, MAX_DISTILL_TRACES))]
    .filter(([, cluster]) => cluster.length >= minCluster)
    .slice(0, MAX_DISTILL_CANDIDATES)
  return eligible.flatMap(([, cluster]) => cluster).slice(0, MAX_DISTILL_TRACES)
}

function stageView(stage: StageReport, cwd: string): RecordValue {
  const result: RecordValue = {
    stage: stage.stage,
    name: safeText(stage.name, 200, cwd),
    state: stage.state,
    evidence: safeText(stage.evidence, 2_000, cwd),
  }
  if (stage.next) result.next = safeText(stage.next, 1_000, cwd)
  return result
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function baselineScenario(value: unknown, index: number): ScenarioResult {
  if (!isRecord(value)) throw new Error(`elia_bench_latency: baseline scenario ${index} is invalid.`)
  const id = value.id
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) throw new Error(`elia_bench_latency: baseline scenario ${index} has an invalid id.`)
  const number = (key: string): number => nonnegativeNumber(value[key]) ? value[key] : 0
  const integer = (key: string): number => Math.round(number(key))
  return {
    id,
    description: typeof value.description === 'string' ? value.description.slice(0, 500) : '',
    runs: Math.min(MAX_LATENCY_RUNS, Math.max(1, integer('runs'))),
    wallMsMedian: number('wallMsMedian'),
    wallMsMin: number('wallMsMin'),
    firstTokenMsMedian: number('firstTokenMsMedian'),
    roundTrips: integer('roundTrips'),
    toolCalls: integer('toolCalls'),
    cachedToolCalls: integer('cachedToolCalls'),
    speculativeHits: integer('speculativeHits'),
    speculativeMisses: integer('speculativeMisses'),
    outputTokensMedian: number('outputTokensMedian'),
    tokensPerSecMedian: number('tokensPerSecMedian'),
    structuralOk: value.structuralOk !== false,
    notes: Array.isArray(value.notes) ? value.notes.filter((note): note is string => typeof note === 'string').slice(0, 20).map((note) => note.slice(0, 1_000)) : [],
  }
}

function readLatencyBaseline(): LatencyReport {
  const path = join(ELIA_ROOT, 'src', 'bench', 'latency', 'baseline.json')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error('elia_bench_latency: the trusted latency baseline is unavailable.')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed) || !Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0 || parsed.scenarios.length > LATENCY_SCENARIOS.length) {
    throw new Error('elia_bench_latency: the trusted latency baseline is invalid.')
  }
  const pacing = isRecord(parsed.modelPacing) ? parsed.modelPacing : {}
  return {
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt.slice(0, 100) : 'unknown',
    live: false,
    model: 'scripted',
    coldStartMsMedian: nonnegativeNumber(parsed.coldStartMsMedian) ? parsed.coldStartMsMedian : 0,
    modelPacing: {
      ttftMs: nonnegativeNumber(pacing.ttftMs) ? Math.round(pacing.ttftMs) : 0,
      tokenMs: nonnegativeNumber(pacing.tokenMs) ? Math.round(pacing.tokenMs) : 0,
    },
    scenarios: parsed.scenarios.map(baselineScenario),
  }
}

function scenarioView(scenario: ScenarioResult, cwd: string): RecordValue {
  return {
    id: safeText(scenario.id, 100, cwd),
    description: safeText(scenario.description, 500, cwd),
    runs: finiteNumber(scenario.runs),
    wallMsP50: finiteNumber(scenario.wallMsMedian),
    wallMsMin: finiteNumber(scenario.wallMsMin),
    firstTokenMsP50: finiteNumber(scenario.firstTokenMsMedian),
    roundTrips: finiteNumber(scenario.roundTrips),
    toolCalls: finiteNumber(scenario.toolCalls),
    cachedToolCalls: finiteNumber(scenario.cachedToolCalls),
    speculativeHits: finiteNumber(scenario.speculativeHits),
    speculativeMisses: finiteNumber(scenario.speculativeMisses),
    structuralOk: scenario.structuralOk,
    notes: scenario.notes.slice(0, 20).map((note) => safeText(note, 1_000, cwd)),
  }
}

function latencyReportView(report: LatencyReport, cwd: string): RecordValue {
  return {
    generatedAt: safeText(report.generatedAt, 100, cwd),
    live: report.live,
    model: safeText(report.model, 200, cwd),
    coldStartMsP50: finiteNumber(report.coldStartMsMedian),
    modelPacing: {
      ttftMs: finiteNumber(report.modelPacing.ttftMs),
      tokenMs: finiteNumber(report.modelPacing.tokenMs),
    },
    scenarios: report.scenarios.slice(0, LATENCY_SCENARIOS.length).map((scenario) => scenarioView(scenario, cwd)),
  }
}

function comparisonView(comparison: LatencyComparison, cwd: string): RecordValue {
  return {
    ok: comparison.ok,
    regressions: comparison.regressions.slice(0, 50).map((reason) => safeText(reason, 1_500, cwd)),
    warnings: comparison.warnings.slice(0, 50).map((reason) => safeText(reason, 1_500, cwd)),
    improvements: comparison.improvements.slice(0, 50).map((reason) => safeText(reason, 1_500, cwd)),
  }
}

function promotionView(decision: PromotionDecision, applyRequested: boolean, cwd: string): RecordValue {
  return {
    ok: applyRequested ? decision.approved && decision.applied : decision.approved,
    proofId: safeText(decision.proofId, 160, cwd),
    attemptId: safeText(decision.attemptId, 200, cwd),
    approved: decision.approved,
    applied: decision.applied,
    applyRequested,
    evaluatedAt: finiteNumber(decision.evaluatedAt),
    changedFiles: safePaths(decision.changedFiles, cwd),
    reasons: safeReasons(decision.reasons, cwd),
    benchmarkReasons: safeReasons(decision.benchmarkReasons, cwd),
    backupCreated: decision.backupDir !== undefined,
  }
}

function metadata(name: string, inputSchema: JsonSchema, outputSchema: JsonSchema): ToolMetadata {
  const feature: McpFeatureMetadata | undefined = MCP_FEATURE_BY_NAME.get(name)
  if (feature === undefined) throw new Error(`Missing MCP feature metadata for ${name}.`)
  return { ...feature, inputSchema, outputSchema }
}

function defineTool(base: McpToolExecutionContext, toolMetadata: ToolMetadata, handler: ToolHandler): McpToolDefinition {
  return defineMcpTool({
    ...toolMetadata,
    execute: async (input, call) => {
      const context = { ...base, ...call }
      const tool = toolMetadata.name
      context.emit({ type: 'self_improvement', tool, status: 'starting', data: redactRecord(input) })
      try {
        const result = await handler(input, context)
        context.emit({ type: 'self_improvement', tool, status: 'completed' })
        return result
      } catch (error) {
        context.emit({ type: 'self_improvement', tool, status: context.signal?.aborted ? 'cancelled' : 'failed', message: safeError(error, context.cwd) })
        throw error
      }
    },
  })
}

async function evolveTool(input: RecordValue, context: McpToolExecutionContext): Promise<RecordValue> {
  const tool = 'elia_evolve'
  assertOnlyKeys(input, ['generations', 'taskIds', 'limit'], tool)
  const generations = optionalInteger(input, 'generations', 1, 1, MAX_GENERATIONS, tool)
  const taskIds = optionalStringArray(input, 'taskIds', MAX_TASK_LIMIT, tool)
  const limit = optionalInteger(input, 'limit', DEFAULT_TASK_LIMIT, 1, MAX_TASK_LIMIT, tool)
  if (taskIds && input.limit !== undefined) throw new Error(`${tool}: use either "taskIds" or "limit", not both.`)
  const selection = selectTasks({ tool, taskIds, limit, set: 'all' })
  assertLive(context, tool)
  const request = redactRecord({ generations, limit, taskIds: selection.tasks.map((task) => task.id) })
  return context.governedMutation('evolve', request, async () => {
    const slot = claimSlot('elia evolve --dry-run', context, tool)
    try {
      assertLive(context, tool)
      const result = await evolve({
        generations,
        taskIds: selection.tasks.map((task) => task.id),
        dryRun: true,
        promoteTo: 'branch',
        signal: context.signal,
      })
      assertLive(context, tool)
      const output: RecordValue = {
        ok: true,
        dryRun: true,
        selection: {
          taskIds: selection.tasks.map((task) => task.id),
          count: selection.tasks.length,
          limit,
        },
        generations: result.generations.slice(0, MAX_GENERATIONS).map((record) => generationView(record, context.cwd)),
        baseline: metricsView(result.baseline, context.cwd),
        final: metricsView(result.final, context.cwd),
      }
      if (result.stoppedReason) output.stoppedReason = safeText(result.stoppedReason, 2_000, context.cwd)
      return output
    } finally {
      slot.release()
    }
  })
}

async function benchTool(input: RecordValue, context: McpToolExecutionContext): Promise<RecordValue> {
  const tool = 'elia_bench'
  assertOnlyKeys(input, ['set', 'taskIds', 'limit', 'repeats', 'fresh'], tool)
  const taskIds = optionalStringArray(input, 'taskIds', MAX_TASK_LIMIT, tool)
  const limit = optionalInteger(input, 'limit', DEFAULT_TASK_LIMIT, 1, MAX_TASK_LIMIT, tool)
  const repeats = optionalInteger(input, 'repeats', benchRepeats(), 1, 10, tool)
  const fresh = optionalBoolean(input, 'fresh', false, tool)
  if (taskIds && input.limit !== undefined) throw new Error(`${tool}: use either "taskIds" or "limit", not both.`)
  const setValue = input.set
  if (setValue !== undefined && setValue !== 'builtin' && setValue !== 'history' && setValue !== 'all') {
    throw new Error(`${tool}: "set" must be builtin, history, or all.`)
  }
  const requestedSet = setValue as Exclude<BenchmarkSet, 'selected'> | undefined
  const selection = selectTasks({ tool, taskIds, limit, set: requestedSet ?? 'builtin' })
  assertLive(context, tool)
  const request = redactRecord({ set: selection.set, limit, taskIds: selection.tasks.map((task) => task.id), repeats, fresh })
  return context.governedMutation('bench', request, async () => {
    const slot = claimSlot(`elia bench --${selection.set}`, context, tool)
    try {
      assertLive(context, tool)
      let completed = 0
      const measured = await measureLiveTree({
        tasks: selection.tasks,
        sourceRoot: ELIA_ROOT,
        model: config.model,
        reuse: !fresh,
        measure: (options) => measureFitness({ ...options, repeats }),
        onTaskDone: (outcome) => {
          completed += 1
          context.emit({
            type: 'self_improvement',
            tool,
            status: 'progress',
            progress: completed,
            total: selection.tasks.length,
            message: safeText(outcome.taskId, 160, context.cwd),
          })
        },
      })
      assertLive(context, tool)
      recordBenchRun(measured.card, recordedBenchSet(selection.tasks, selection.set))
      return {
        ok: true,
        set: selection.set,
        taskCount: selection.tasks.length,
        reused: measured.reused,
        complete: measured.card.unmeasured.length === 0,
        model: safeText(measured.card.model || config.model, 200, context.cwd),
        passRate: finiteNumber(measured.card.passRate),
        unmeasured: safePaths(measured.card.unmeasured, context.cwd),
        totalTokens: finiteNumber(measured.card.totalTokens),
        totalElapsedMs: finiteNumber(measured.card.totalElapsedMs),
        wallClockMs: finiteNumber(measured.card.wallClockMs),
        cacheHitRate: finiteNumber(measured.card.cacheHitRate),
        outcomes: measured.card.outcomes.slice(0, MAX_TASK_LIMIT).map((outcome) => taskOutcomeView(outcome, context.cwd)),
      }
    } finally {
      slot.release()
    }
  })
}

async function distillTool(input: RecordValue, context: McpToolExecutionContext): Promise<RecordValue> {
  const tool = 'elia_distill'
  assertOnlyKeys(input, ['minCluster'], tool)
  const minCluster = optionalInteger(input, 'minCluster', 3, 3, 10, tool)
  assertLive(context, tool)
  const request = redactRecord({ minCluster, traceLimit: MAX_DISTILL_TRACES, candidateLimit: MAX_DISTILL_CANDIDATES })
  return context.governedMutation('distill', request, async () => {
    assertLive(context, tool)
    const available = collectDistillableTraces(context.cwd)
    const traces = boundedDistillationTraces(available, minCluster)
    if (traces.length < minCluster) {
      return {
        ok: true,
        promoted: false,
        tracesAvailable: available.length,
        tracesConsidered: traces.length,
        minCluster,
        activeFragments: fragmentCount(),
        candidates: [],
      }
    }
    const mined = (await proposeDistillations(traces, { minCluster, signal: context.signal })).slice(0, MAX_DISTILL_CANDIDATES)
    assertLive(context, tool)
    const candidates: RecordValue[] = []
    if (mined.length > 0) {
      const slot = claimSlot('elia distill --dry-run', context, tool)
      try {
        for (const [index, candidate] of mined.entries()) {
          assertLive(context, tool)
          const stages: string[] = []
          const result = await evaluateCandidate(candidate, {
            dryRun: true,
            signal: context.signal,
            onStage: (stage) => {
              stages.push(safeText(stage, 200, context.cwd))
              context.emit({
                type: 'self_improvement',
                tool,
                status: 'progress',
                progress: index + 1,
                total: mined.length,
                message: safeText(stage, 200, context.cwd),
              })
            },
          })
          candidates.push({
            role: safeText(result.candidate.role, 100, context.cwd),
            fragment: safeText(result.candidate.fragment, 400, context.cwd),
            rationale: safeText(result.candidate.rationale, 1_000, context.cwd),
            sourceRunIds: result.candidate.sourceRunIds.slice(0, MAX_DISTILL_TRACES).map((id) => safeText(id, 160, context.cwd)),
            verdict: result.verdict,
            reason: safeText(result.reason, 1_500, context.cwd),
            stages,
          })
        }
      } finally {
        slot.release()
      }
    }
    assertLive(context, tool)
    return {
      ok: true,
      promoted: false,
      tracesAvailable: available.length,
      tracesConsidered: traces.length,
      minCluster,
      activeFragments: fragmentCount(),
      candidates,
    }
  })
}

async function promoteTool(input: RecordValue, context: McpToolExecutionContext): Promise<RecordValue> {
  const tool = 'elia_promote'
  assertOnlyKeys(input, ['proofId', 'apply'], tool)
  const proofIdValue = input.proofId
  if (typeof proofIdValue !== 'string' || !PROOF_ID_PATTERN.test(proofIdValue)) {
    throw new Error(`${tool}: "proofId" must be a canonical promotion proof filename.`)
  }
  const apply = optionalBoolean(input, 'apply', false, tool)
  const proofId = proofIdValue
  assertLive(context, tool)
  return context.governedMutation('promote', { proofId, apply }, async () => {
    assertLive(context, tool)
    const decision = apply
      ? applyPromotion(proofId, { apply: true, request: { proofId, apply: true, source: tool } })
      : evaluatePromotion(proofId)
    assertLive(context, tool)
    return promotionView(decision, apply, context.cwd)
  })
}

async function compoundingStatusTool(input: RecordValue, context: McpToolExecutionContext): Promise<RecordValue> {
  assertOnlyKeys(input, [], 'elia_compounding_status')
  assertLive(context, 'elia_compounding_status')
  const stages = compoundingStatus().slice(0, 6)
  const counts = {
    working: stages.filter((stage) => stage.state === 'working').length,
    partial: stages.filter((stage) => stage.state === 'partial').length,
    blocked: stages.filter((stage) => stage.state === 'blocked').length,
    noEvidence: stages.filter((stage) => stage.state === 'no evidence').length,
  }
  return {
    ok: true,
    generatedAt: Date.now(),
    summary: { total: stages.length, ...counts },
    stages: stages.map((stage) => stageView(stage, context.cwd)),
  }
}

async function benchLatencyTool(input: RecordValue, context: McpToolExecutionContext): Promise<RecordValue> {
  const tool = 'elia_bench_latency'
  assertOnlyKeys(input, ['scenarioIds', 'runs', 'realistic', 'skipColdStart', 'strict'], tool)
  const scenarioIds = optionalStringArray(input, 'scenarioIds', LATENCY_SCENARIOS.length, tool)
  if (scenarioIds) {
    const known = new Set(LATENCY_SCENARIOS.map((scenario) => scenario.id))
    const unknown = scenarioIds.find((id) => !known.has(id))
    if (unknown) throw new Error(`${tool}: unknown latency scenario "${unknown}".`)
  }
  const runs = optionalInteger(input, 'runs', 3, 1, MAX_LATENCY_RUNS, tool)
  const realistic = optionalBoolean(input, 'realistic', false, tool)
  const skipColdStart = optionalBoolean(input, 'skipColdStart', false, tool)
  const strict = optionalBoolean(input, 'strict', false, tool)
  const baseline = readLatencyBaseline()
  assertLive(context, tool)
  const expectedScenarios = scenarioIds?.length ?? LATENCY_SCENARIOS.length
  let completed = 0
  const current = await runLatencyHarness({
    live: false,
    runsPerScenario: runs,
    only: scenarioIds,
    skipColdStart,
    pacing: realistic ? { ttftMs: 150, tokenMs: 25 } : { ttftMs: 0, tokenMs: 0 },
    onScenarioDone: (scenario) => {
      completed += 1
      context.emit({
        type: 'self_improvement',
        tool,
        status: 'progress',
        progress: completed,
        total: expectedScenarios,
        message: safeText(scenario.id, 100, context.cwd),
      })
    },
  })
  assertLive(context, tool)
  const comparison = compareLatency(baseline, current, { strict })
  return {
    ok: comparison.ok,
    live: false,
    baselineUpdated: false,
    strict,
    current: latencyReportView(current, context.cwd),
    baseline: latencyReportView(baseline, context.cwd),
    comparison: comparisonView(comparison, context.cwd),
  }
}

export function createSelfImprovementTools(context: McpToolExecutionContext): McpToolDefinition[] {
  return [
    defineTool(
      context,
      metadata(
        'elia_evolve',
        {
          type: 'object',
          properties: {
            generations: { type: 'integer', minimum: 1, maximum: MAX_GENERATIONS, default: 1 },
            taskIds: TASK_IDS_SCHEMA,
            limit: { type: 'integer', minimum: 1, maximum: MAX_TASK_LIMIT, default: DEFAULT_TASK_LIMIT },
          },
          additionalProperties: false,
        },
        EVOLVE_OUTPUT,
      ),
      evolveTool,
    ),
    defineTool(
      context,
      metadata(
        'elia_bench',
        {
          type: 'object',
          properties: {
            set: { type: 'string', enum: ['builtin', 'history', 'all'] },
            taskIds: TASK_IDS_SCHEMA,
            limit: { type: 'integer', minimum: 1, maximum: MAX_TASK_LIMIT, default: DEFAULT_TASK_LIMIT },
            repeats: { type: 'integer', minimum: 1, maximum: 10, default: benchRepeats() },
            fresh: { type: 'boolean', default: false },
          },
          additionalProperties: false,
        },
        BENCH_OUTPUT,
      ),
      benchTool,
    ),
    defineTool(
      context,
      metadata(
        'elia_distill',
        {
          type: 'object',
          properties: { minCluster: { type: 'integer', minimum: 3, maximum: 10, default: 3 } },
          additionalProperties: false,
        },
        DISTILL_OUTPUT,
      ),
      distillTool,
    ),
    defineTool(
      context,
      metadata(
        'elia_promote',
        {
          type: 'object',
          properties: {
            proofId: { type: 'string', minLength: 15, maxLength: 110, pattern: PROOF_ID_PATTERN.source },
            apply: { type: 'boolean', default: false },
          },
          required: ['proofId'],
          additionalProperties: false,
        },
        PROMOTE_OUTPUT,
      ),
      promoteTool,
    ),
    defineTool(context, metadata('elia_compounding_status', EMPTY_INPUT, COMPOUNDING_OUTPUT), compoundingStatusTool),
    defineTool(
      context,
      metadata(
        'elia_bench_latency',
        {
          type: 'object',
          properties: {
            scenarioIds: { type: 'array', items: { type: 'string', enum: LATENCY_SCENARIOS.map((scenario) => scenario.id) }, minItems: 1, maxItems: LATENCY_SCENARIOS.length, uniqueItems: true },
            runs: { type: 'integer', minimum: 1, maximum: MAX_LATENCY_RUNS, default: 3 },
            realistic: { type: 'boolean', default: false },
            skipColdStart: { type: 'boolean', default: false },
            strict: { type: 'boolean', default: false },
          },
          additionalProperties: false,
        },
        LATENCY_OUTPUT,
      ),
      benchLatencyTool,
    ),
  ]
}
