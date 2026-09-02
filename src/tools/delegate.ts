import type { Tool, } from './types.ts'
import { isRoleName, type RoleName } from '../autonomy/types.ts'
import { role as roleDefinition } from '../autonomy/roles.ts'
import type { FleetAssignment } from '../autonomy/fleet.ts'
import type { ActionGovernor } from '../autonomy/governor.ts'
import type { GoalGraphStore } from '../autonomy/goalGraph.ts'
import type { Journal } from '../autonomy/journal.ts'
import { currentAgent } from '../autonomy/context.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { redactText } from '../ui/redact.ts'

const MAX_DELEGATION_DEPTH = 1
const MAX_DELEGATION_CONTEXT = 12_000
const MAX_CHILD_PROMPT_LENGTH = 20_000
const MAX_CHILD_STRING_LENGTH = 4_000

export interface DelegationToolOptions {
  parentRole: RoleName
  parentName: string
  depth: number
  runId?: string
  governor?: ActionGovernor
  graph?: GoalGraphStore
  parentNodeId?: string
  journal?: Journal
  briefing?: string
  cwd?: string
  signal?: AbortSignal
  onTool?: (event: Parameters<NonNullable<import('../agentLoop.ts').RunAgentLoopOptions['onTool']>>[0]) => void
}

interface ChildAssignmentInput {
  id: string
  title: string
  role: RoleName
  prompt: string
  files: string[]
  dependsOn: string[]
  acceptanceCriteria: string[]
  verificationCommands: string[]
  sideEffects: string[]
}

/**
 * Creates the only recursive delegation surface in Elia.
 *
 * A coding lead can fan out one bounded child fleet. Children inherit the lead's
 * governance, graph, working directory, cancellation signal, and blackboard, but
 * depth is incremented so a child cannot create another fleet. This gives Elia
 * useful hierarchy without unbounded recursive agent spawning.
 */
export function createDelegationTool(options: DelegationToolOptions): Tool {
  const definition = roleDefinition(options.parentRole)
  const allowedRoles = definition.delegateRoles ?? []
  const maxChildren = definition.maxChildren ?? 0
  let delegationUsed = false

  return {
    name: 'delegate_tasks',
    description: `Delegate a bounded set of independent child tasks to specialist sub-agents. You are the ${options.parentRole} lead. Use this when a request contains separable design, implementation, accessibility, testing, documentation, or investigation work. Child tasks run in dependency-safe waves: independent tasks run in parallel, tasks that share files are serialized, and later waves receive earlier reports. You may delegate at most ${maxChildren} children in this call, only to these roles: ${allowedRoles.join(', ') || '(none)'}. Delegation depth is capped at one child level; your children cannot delegate again. Do not delegate one large vague task — give each child a concrete outcome, exact files or areas, and verification expectations.`,
    input_schema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          minItems: 1,
          maxItems: maxChildren,
          description: 'Independent or dependency-linked child assignments. Keep each prompt complete and focused.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short unique id, such as design, ui, a11y, or tests' },
              title: { type: 'string', description: 'Short human-readable task title' },
              role: { type: 'string', enum: allowedRoles, description: 'Allowed specialist child role' },
              prompt: { type: 'string', description: 'Complete instructions for this child task' },
              files: { type: 'array', items: { type: 'string' }, description: 'Files or directories this child may touch or inspect' },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Child ids that must finish first' },
              acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Observable conditions that define success' },
              verificationCommands: { type: 'array', items: { type: 'string' }, description: 'Commands or checks the child must run and report' },
              sideEffects: { type: 'array', items: { type: 'string' }, description: 'External or irreversible effects that require approval or must not occur' },
            },
            required: ['id', 'title', 'role', 'prompt'],
          },
        },
      },
      required: ['assignments'],
    },
    async execute(input) {
      if (options.depth >= MAX_DELEGATION_DEPTH) {
        throw new Error('delegation depth limit reached: child agents cannot delegate further')
      }
      if (!definition.canDelegate || allowedRoles.length === 0) {
        throw new Error(`role ${options.parentRole} is not authorized to delegate child tasks`)
      }
      if (delegationUsed) throw new Error('this lead may delegate only one child fleet per run')

      const raw = input.assignments
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('assignments must be a non-empty array')
      if (raw.length > maxChildren) throw new Error(`too many child assignments: ${raw.length}; maximum is ${maxChildren}`)

      const assignments: FleetAssignment[] = raw.map((value, index) => {
        if (!value || typeof value !== 'object') throw new Error(`assignments[${index}] must be an object`)
        const item = value as Record<string, unknown>
        const id = (stringValue(item.id) ?? `child-${index + 1}`).slice(0, 120)
        const title = (stringValue(item.title) ?? id).slice(0, 240)
        const prompt = stringValue(item.prompt)
        if (!prompt) throw new Error(`assignments[${index}].prompt is required`)
        if (prompt.length > MAX_CHILD_PROMPT_LENGTH) throw new Error(`assignments[${index}].prompt exceeds ${MAX_CHILD_PROMPT_LENGTH} characters`)
        if (!isRoleName(item.role) || !allowedRoles.includes(item.role)) {
          throw new Error(`assignments[${index}].role must be one of: ${allowedRoles.join(', ')}`)
        }
        return {
          id,
          title,
          role: item.role,
          instructions: prompt,
                        files: stringArray(item.files),
              dependsOn: stringArray(item.dependsOn),
              acceptanceCriteria: stringArray(item.acceptanceCriteria),
              verificationCommands: stringArray(item.verificationCommands),
              sideEffects: stringArray(item.sideEffects),

        }
      })

      const ids = new Set<string>()
      for (const assignment of assignments) {
        if (ids.has(assignment.id)) throw new Error(`duplicate child assignment id: ${assignment.id}`)
        ids.add(assignment.id)
      }
      const { planWaves, runFleet } = await import('../autonomy/fleet.ts')
      const planned = planWaves(assignments.map((assignment) => ({
        id: assignment.id,
        title: assignment.title,
        role: assignment.role,
        instructions: assignment.instructions,
        files: assignment.files ?? [],
        dependsOn: assignment.dependsOn ?? [],
        acceptanceCriteria: assignment.acceptanceCriteria ?? [],
        verificationCommands: assignment.verificationCommands ?? [],
        sideEffects: assignment.sideEffects ?? [],
      })))
      if (planned.unreachable.length > 0) {
        throw new Error(`child delegation contains a dependency cycle or unreachable task: ${planned.unreachable.map((item) => item.id).join(', ')}`)
      }
      delegationUsed = true

      const parent = currentAgent()
      const sharedBriefing = [
        options.briefing,
        `## Parent lead\n${options.parentName} (${options.parentRole}) delegated this child fleet. Work only inside your assignment and report concrete findings or changes.`,
      ].filter(Boolean).join('\n\n')

      options.journal?.append('delegation-start', {
        parent: options.parentName,
        parentRole: options.parentRole,
        depth: options.depth,
        assignments: assignments.map((assignment) => ({ id: assignment.id, title: assignment.title, role: assignment.role, files: assignment.files ?? [], acceptanceCriteria: assignment.acceptanceCriteria ?? [], verificationCommands: assignment.verificationCommands ?? [], sideEffects: assignment.sideEffects ?? [] })),
      })
      if (machineReadable) {
        emitEvent('delegation_started', {
          parent: options.parentName,
          parentRole: options.parentRole,
          depth: options.depth,
          assignments: assignments.map((assignment) => ({ id: assignment.id, title: assignment.title, role: assignment.role, files: assignment.files ?? [], acceptanceCriteria: assignment.acceptanceCriteria ?? [], verificationCommands: assignment.verificationCommands ?? [], sideEffects: assignment.sideEffects ?? [] })),
        })
      }

      const allResults: Array<{ id: string; title: string; role: RoleName; ok: boolean; report: string; steps: number; elapsedMs: number }> = []
      let priorReports = ''
      for (const [waveIndex, wave] of planned.waves.entries()) {
        if (options.signal?.aborted) break
        const waveBriefing = [
          sharedBriefing,
          priorReports ? `## Reports from completed child wave(s)\n${priorReports}` : undefined,
          `## Delegation wave\nThis is wave ${waveIndex + 1} of ${planned.waves.length}. Independent assignments in this wave are running in parallel.`,
        ].filter(Boolean).join('\n\n')
        const result = await runFleet({
          assignments: wave,
          briefing: redactText(waveBriefing, MAX_DELEGATION_CONTEXT),
          concurrency: Math.min(4, wave.length),
          showBoard: false,
          cwd: options.cwd ?? parent.cwd,
          runId: options.runId,
          governor: options.governor,
          graph: options.graph,
          parentNodeId: options.parentNodeId,
          delegationDepth: options.depth + 1,
          journal: options.journal,
          signal: options.signal,
          onTool: options.onTool,
          wave: waveIndex + 1,
        })
        for (const child of result.results) {
          const report = redactText(child.report, 3_000)
          allResults.push({ id: child.id, title: child.title, role: child.role, ok: child.ok, report, steps: child.steps, elapsedMs: child.elapsedMs })
        }
        priorReports = redactText(allResults.map((child) => `### ${child.title} (${child.role})\n${child.report}`).join('\n\n'), MAX_DELEGATION_CONTEXT)
      }

      options.journal?.append('delegation-end', {
        parent: options.parentName,
        children: allResults.map((child) => ({ id: child.id, role: child.role, ok: child.ok, steps: child.steps, elapsedMs: child.elapsedMs })),
      })
      if (machineReadable) {
        emitEvent('delegation_finished', {
          parent: options.parentName,
          children: allResults.map((child) => ({ id: child.id, role: child.role, ok: child.ok, steps: child.steps, elapsedMs: child.elapsedMs })),
        })
      }

      const status = options.signal?.aborted ? 'aborted' : allResults.every((child) => child.ok) ? 'completed' : 'completed with child failures'
      return `Delegation ${status}. ${allResults.length}/${assignments.length} child tasks returned.\n\n${allResults.map((child) => `[${child.ok ? 'ok' : 'failed'}] ${child.id} — ${child.title} (${child.role}, ${child.steps} steps, ${(child.elapsedMs / 1000).toFixed(1)}s)\n${child.report}`).join('\n\n')}`
    },
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim().slice(0, MAX_CHILD_STRING_LENGTH))
        .slice(0, 50)
    : []
}
