import { runSubAgent, type SubAgentResult } from '../subagent.ts'
import { runWithConcurrencyLimit } from '../agentLoop.ts'
import { createFleetBoard } from '../ui/fleetBoard.ts'
import { ZERO_USAGE, addUsage } from '../usage.ts'
import { roleConfig } from '../config.ts'
import { role as roleDefinition, toolsForRole } from './roles.ts'
import type { Usage } from '../providers/types.ts'
import type { Journal } from './journal.ts'
import type { ActionGovernor } from './governor.ts'
import type { GoalGraphStore } from './goalGraph.ts'
import type { ProposalStep, RoleName } from './types.ts'
import { inferTaskKind, taskSessions } from '../taskSessions.ts'

/** board_post/board_read are stripped for a variant's workers — see FleetRunOptions.stripBoardTools. */
const BOARD_TOOL_NAMES = ['board_post', 'board_read']

/** How many sub-agents run at once against a single provider. Beyond this, that provider's rate limits dominate and add latency instead of removing it. */
const DEFAULT_FLEET_CONCURRENCY = 4
/** Hard ceiling regardless of how many distinct providers are in play — past this, local resources (not any one provider) become the bottleneck. */
const MAX_FLEET_CONCURRENCY = 16

export interface FleetAssignment {
  id: string
  title: string
  role: RoleName
  instructions: string
  /** Expected file ownership used by dependency and collision planning. */
  files?: string[]
  /** Assignment ids that must complete before this assignment runs. */
  dependsOn?: string[]
}

export interface FleetRunOptions {
  assignments: FleetAssignment[]
  /** Shared context every worker is given — the goal, and what has happened so far. */
  briefing?: string
  concurrency?: number
  journal?: Journal
  runId?: string
  governor?: ActionGovernor
  graph?: GoalGraphStore
  /** Show the live status board. Off when a fleet runs inside another progress display. */
  showBoard?: boolean
  /**
   * Working-directory root every worker in this fleet writes into — set when
   * this fleet is one of several isolated variants (see variants.ts) so its
   * workers touch that variant's own git worktree instead of the real cwd.
   */
  cwd?: string
  /**
   * Drop board_post/board_read from every worker's tools. The blackboard is a
   * single process-wide resource; when several fleets for isolated variants
   * run concurrently, letting them post to and read from the same board would
   * leak one variant's (possibly divergent) findings into another's. Set
   * whenever more than one fleet may be running at once.
   */
  stripBoardTools?: boolean
  signal?: AbortSignal
  /** Parent durable node for nested child action attribution. */
  parentNodeId?: string
  /** Delegation depth passed to child workers; depth one cannot recurse. */
  delegationDepth?: number
  /** Shared tool-event observer for nested task dashboards and telemetry. */
  onTool?: (event: import('../agentLoop.ts').ToolEvent) => void
}

export interface FleetResult {
  results: (SubAgentResult & { id: string; title: string })[]
  usage: Usage
  elapsedMs: number
  /** Wall-clock saved versus running the same workers one after another. */
  savedMs: number
}

/**
 * Dispatches a set of assignments to sub-agents in parallel and waits for all of them.
 *
 * The interesting number this returns is `savedMs`: the sum of the workers' own
 * elapsed times minus the wall clock the fleet actually took. That is the whole
 * point of a fleet, and reporting it keeps the parallelism honest — if a
 * "parallel" run saved nothing, the decomposition was wrong.
 */
export async function runFleet(options: FleetRunOptions): Promise<FleetResult> {
  const { assignments, briefing, journal, signal, cwd, stripBoardTools } = options
  const showBoard = options.showBoard ?? true
  const startedAt = Date.now()

  const named = assignments.map((assignment, index) => ({
    ...assignment,
    // Worker names are what show up in blackboard attribution, so they need to be
    // distinct and readable: "scout#1", "builder#2".
    workerName: `${assignment.role}#${index + 1}`,
    providerLabel: roleConfig(assignment.role, roleDefinition(assignment.role).tier).label,
  }))

  const concurrency = options.concurrency ?? fleetConcurrency(named.map((item) => item.providerLabel))

  const board = showBoard
    ? createFleetBoard(named.map((item) => ({ name: item.workerName, role: item.role, title: item.title })))
    : undefined

  const results = await runWithConcurrencyLimit(named, concurrency, async (item) => {
    board?.update(item.workerName, 'running')
    journal?.append('step-start', { id: item.id, title: item.title, role: item.role, worker: item.workerName })
    const task = taskSessions.create(inferTaskKind(item.title, item.instructions), item.title, `Worker ${item.workerName} starting`, {
      parentId: options.parentNodeId,
      depth: options.delegationDepth ?? 0,
      role: item.role,
    })
    taskSessions.update(task.id, { status: 'running', action: 'Starting worker', detail: `Role: ${item.role}` })

    let toolCount = 0
    const childNodeId = options.parentNodeId ? `${options.parentNodeId}/child:${item.id}` : `step:${item.id}`
    if (options.graph && options.parentNodeId) {
      options.graph.registerDelegationNode({
        parentId: options.parentNodeId,
        id: item.id,
        title: item.title,
        role: item.role,
        instructions: item.instructions,
        files: item.files,
        dependsOn: item.dependsOn,
        depth: options.delegationDepth ?? 0,
      })
      options.graph.startNode(childNodeId)
    }
    const result = await runSubAgent({
      prompt: item.instructions,
      role: item.role,
      name: item.workerName,
      briefing,
      cwd,
      runId: options.runId,
      governor: options.governor,
      graph: options.graph,
      nodeId: childNodeId,
      parentNodeId: options.parentNodeId,
      delegationDepth: options.delegationDepth,
      journal: options.journal,
      tools: stripBoardTools ? toolsForRole(item.role).filter((tool) => !BOARD_TOOL_NAMES.includes(tool.name)) : undefined,
      signal,
      onTool: (event) => {
        toolCount += 1
        board?.update(item.workerName, 'running', `${event.name} (${toolCount})`)
        taskSessions.update(task.id, {
          status: 'running',
          action: event.isError ? `Retrying after ${event.name}` : event.name,
          detail: event.isError ? event.result : `step ${event.name} completed`,
          stepsCompleted: (taskSessions.get(task.id)?.stepsCompleted ?? 0) + 1,
        })
        options.onTool?.(event)
      },
    }).catch(
      (err: unknown): SubAgentResult => ({
        name: item.workerName,
        role: item.role,
        report: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        usage: ZERO_USAGE,
        steps: 0,
        elapsedMs: 0,
        ok: false,
      }),
    )

    board?.update(item.workerName, result.ok ? 'done' : 'failed', `${result.steps} steps`)
    taskSessions.update(task.id, {
      status: result.ok ? 'done' : 'failed',
      action: result.ok ? 'Finished' : 'Stopped early',
      detail: result.report.slice(0, 1000),
      error: result.ok ? undefined : 'Worker stopped before completing its assignment',
    })
    if (options.graph && options.parentNodeId) {
      options.graph.finishNode(childNodeId, { ok: result.ok, report: result.report, error: result.ok ? undefined : result.report })
    }
    journal?.append('step-end', {
      id: item.id,
      worker: item.workerName,
      ok: result.ok,
      steps: result.steps,
      elapsedMs: result.elapsedMs,
      report: result.report,
    })

    return { ...result, id: item.id, title: item.title }
  })

  board?.stop()

  const elapsedMs = Date.now() - startedAt
  const serialMs = results.reduce((total, result) => total + result.elapsedMs, 0)

  return {
    results,
    usage: results.reduce((total, result) => addUsage(total, result.usage), ZERO_USAGE),
    elapsedMs,
    savedMs: Math.max(0, serialMs - elapsedMs),
  }
}

/**
 * How many workers to run at once, given the providers this batch actually uses.
 *
 * `DEFAULT_FLEET_CONCURRENCY` exists because piling every worker onto one
 * provider trades rate-limit throttling for the parallelism it was supposed to
 * buy. That reasoning is per-provider, not global: a wave split across N
 * genuinely distinct providers (a scout on Groq, a critic on Claude, ...) has N
 * separate rate-limit budgets, so it can safely run wider without any one of
 * them being hammered harder than a single-provider fleet already is.
 */
export function fleetConcurrency(providerLabels: string[]): number {
  const distinctProviders = new Set(providerLabels).size || 1
  return Math.min(MAX_FLEET_CONCURRENCY, DEFAULT_FLEET_CONCURRENCY * distinctProviders)
}

/**
 * Splits steps into dependency waves: every step in a wave can run at the same
 * time, and each wave waits for the one before it.
 *
 * This is how a tech lead actually parallelises work — not "run everything at
 * once" (which corrupts files two workers both edit) and not "run everything in
 * order" (which wastes the fleet), but the widest safe wave at each point.
 * Steps whose dependencies can never be satisfied — a typo'd id, or a cycle —
 * are returned separately rather than silently dropped or deadlocked on.
 */
export function planWaves(steps: ProposalStep[]): { waves: ProposalStep[][]; unreachable: ProposalStep[] } {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const done = new Set<string>()
  const waves: ProposalStep[][] = []
  let remaining = [...steps]

  while (remaining.length > 0) {
    const ready = remaining.filter((step) =>
      step.dependsOn.every((id) => done.has(id) || !byId.has(id)),
    )
    // Nothing became ready, so what is left is a cycle or depends on a step that
    // is itself stuck. Stop rather than spin.
    if (ready.length === 0) return { waves, unreachable: remaining }

    // Dependency-ready does not necessarily mean safe to run together. Split
    // steps that claim the same file into later sub-waves so two builders can
    // never clobber one another merely because the planner omitted dependsOn.
    for (const safeWave of collisionFreeWaves(ready)) waves.push(safeWave)
    for (const step of ready) done.add(step.id)
    remaining = remaining.filter((step) => !done.has(step.id))
  }

  return { waves, unreachable: [] }
}

/** Greedily packs steps into the fewest deterministic waves with no shared files. */
function collisionFreeWaves(steps: ProposalStep[]): ProposalStep[][] {
  const waves: ProposalStep[][] = []

  for (const step of steps) {
    const target = waves.find((wave) => fileCollisions([...wave, step]).length === 0)
    if (target) target.push(step)
    else waves.push([step])
  }

  return waves
}

/** Files two steps in the same wave both intend to touch — a real risk of clobbering each other. */
export function fileCollisions(wave: ProposalStep[]): { file: string; steps: string[] }[] {
  const owners = new Map<string, string[]>()
  for (const step of wave) {
    for (const file of step.files) {
      const normalized = file.replace(/\\/g, '/')
      owners.set(normalized, [...(owners.get(normalized) ?? []), step.id])
    }
  }
  return [...owners.entries()]
    .filter(([, steps]) => steps.length > 1)
    .map(([file, steps]) => ({ file, steps }))
}
