/**
 * Turning a high-level objective into a coordinated task graph.
 *
 * `decomposeObjective` runs the existing autonomous planner to produce a
 * validated {@link Proposal}, seeds a per-objective durable {@link GoalGraphStore}
 * from it (so the workspace inherits evidence, leases, and resumption for free),
 * and projects every proposal step into a workspace `Task` — role, owned files,
 * and dependencies intact. The objective then sits at `awaiting-approval` with a
 * pending plan approval until a maintainer or owner approves it.
 *
 * The planner is injectable so tests (and non-LLM callers) can supply a fixed
 * proposal instead of a model round-trip.
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { runAgentLoop } from '../agentLoop.ts'
import { allWorkerTools } from '../tools/registry.ts'
import { systemPromptForMode, tierConfig, autoFallbacksFor } from '../config.ts'
import { createProposalTool } from '../autonomy/proposal.ts'
import { planWaves } from '../autonomy/fleet.ts'
import { GoalGraphStore } from '../autonomy/goalGraph.ts'
import { ensureSecureDirectory } from '../securePersistence.ts'
import type { Proposal } from '../autonomy/types.ts'
import type { WorkspaceStore } from './store.ts'
import { MAX_GOAL_LENGTH } from './types.ts'

/** Per-objective durable goal graphs live beside the workspace database. */
export function objectiveGraphDir(store: WorkspaceStore, objectiveId: string): string {
  return join(dirname(store.path), 'workspace-graphs', objectiveId)
}

/** Produce a plan for a goal. The default calls the model; tests pass a stub. */
export type ObjectivePlanner = (goal: string, cwd: string, signal?: AbortSignal) => Promise<Proposal>

const PLANNER_PROMPT = `${systemPromptForMode('dev')}

## Right now you are planning a shared team objective, not building

Several autonomous agents and human teammates will pick up the steps you produce and
run them in parallel inside one shared project. Investigate with your read-only tools,
then call submit_proposal exactly once and stop.

What makes a good decomposition here:
- Each step is a self-contained unit one worker can execute alone — it sees only its
  own instructions, never this conversation or the other steps.
- Pick the specific role: frontend for UI/client work, backend for API/data/logic,
  tester for tests, scout for investigation, critic/security for review, scribe for docs.
- A change that touches both UI and API is two independent steps (one per role) so
  they run at the same time.
- Use dependsOn only for a real ordering requirement. Steps with disjoint files and no
  dependency run concurrently — every needless dependency costs the team wall-clock time.
- List the files each step will own so two parallel steps never collide on one file.
- verification is real commands from this project that fail if the work is wrong.`

export async function planObjective(goal: string, cwd: string, signal?: AbortSignal): Promise<Proposal> {
  const capture = createProposalTool()
  const tools = [
    ...allWorkerTools().filter((tool) => ['read_file', 'list_files', 'grep', 'web_search', 'web_fetch', 'environment'].includes(tool.name)),
    capture.tool,
  ]
  const route = tierConfig('deep')
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: `## Objective\n${goal}\n\nOrient yourself in ${cwd}, then submit a proposal.` }] }]
  await runAgentLoop({
    messages,
    systemPrompt: PLANNER_PROMPT,
    tools,
    provider: route.provider,
    providerName: route.providerName,
    model: route.model,
    fallbacks: autoFallbacksFor(route.providerName),
    useAnimation: false,
    verbose: false,
    maxSteps: 28,
    signal,
  })
  const proposal = capture.taken()
  if (!proposal) throw new Error('the planner finished without submitting a proposal; try rephrasing the objective')
  return proposal
}

export interface DecomposeInput {
  goal: string
  projectId?: string
  actorId: string
  signal?: AbortSignal
}

export interface DecomposeResult {
  objectiveId: string
  runId: string
  taskIds: string[]
  waves: string[][]
  proposal: Proposal
}

export async function decomposeObjective(
  store: WorkspaceStore,
  input: DecomposeInput,
  planner: ObjectivePlanner = planObjective,
): Promise<DecomposeResult> {
  const workspace = store.workspace()
  if (!workspace) throw new Error('no workspace has been created yet')
  const goal = input.goal.trim()
  if (!goal || goal.length > MAX_GOAL_LENGTH) throw new Error(`goal must be a non-empty string of at most ${MAX_GOAL_LENGTH} characters`)
  const projectId = input.projectId ?? workspace.defaultProjectId
  const project = store.project(projectId)
  if (!project) throw new Error(`unknown project ${projectId}`)

  const proposal = await planner(goal, project.repoRoot, input.signal)
  if (!proposal.steps.length) throw new Error('the planner produced no steps')

  const objectiveId = `obj_${randomUUID().replaceAll('-', '')}`
  const runId = `wsrun-${objectiveId.slice(4, 16)}`

  // Seed a durable goal graph for this objective — its leases, evidence, and
  // resumption logic back the workspace task graph.
  const graphDir = objectiveGraphDir(store, objectiveId)
  ensureSecureDirectory(graphDir)
  const graph = GoalGraphStore.open({ runId, goal: proposal.goal, dir: graphDir })
  graph.seedProposal(proposal)

  store.append({
    type: 'ObjectiveCreated',
    actorKind: 'member',
    actorId: input.actorId,
    objectiveId,
    payload: { id: objectiveId, workspaceId: workspace.id, projectId, goal: proposal.goal, runId },
  })

  const { waves } = planWaves(proposal.steps)
  const waveOf = new Map<string, number>()
  waves.forEach((wave, index) => wave.forEach((step) => waveOf.set(step.id, index + 1)))

  const taskId = (stepId: string): string => `tsk_${objectiveId.slice(4, 14)}_${stepId}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 100)
  const taskIds: string[] = []
  for (const step of proposal.steps) {
    const id = taskId(step.id)
    taskIds.push(id)
    store.append({
      type: 'TaskCreated',
      actorKind: 'member',
      actorId: input.actorId,
      objectiveId,
      payload: {
        id,
        objectiveId,
        projectId,
        title: step.title,
        instructions: step.instructions,
        role: step.role,
        dependsOn: step.dependsOn.map(taskId),
        files: step.files,
        wave: waveOf.get(step.id) ?? null,
        acceptanceCriteria: [],
        verificationCommands: proposal.verification,
        goalNodeId: `step:${step.id}`,
        maxAttempts: 2,
      },
    })
  }

  store.append({ type: 'ObjectivePlanned', actorKind: 'member', actorId: input.actorId, objectiveId, payload: {} })
  store.append({
    type: 'ApprovalRequired',
    actorKind: 'member',
    actorId: input.actorId,
    objectiveId,
    payload: { id: `apr_${randomUUID().replaceAll('-', '')}`, kind: 'plan', subject: objectiveId, reason: 'objective plan needs approval before agents start' },
  })

  return {
    objectiveId,
    runId,
    taskIds,
    waves: waves.map((wave) => wave.map((step) => taskId(step.id))),
    proposal,
  }
}
