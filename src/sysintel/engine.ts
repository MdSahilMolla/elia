import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { detectChecks } from '../autonomy/detectChecks.ts'
import { isNoTestsResult, runVerification } from '../autonomy/verify.ts'
import { redactSecrets } from '../ui/redact.ts'
import { ARTIFACT_KINDS, artifactTemplate, markdownSections, renderTemplate, validateArtifact } from './artifacts.ts'
import { EFFECTS, type SiTool } from './effects.ts'
import { currentStage, evaluateStage, gateContext, latestArtifact, type GateContext } from './gates.ts'
import { FLAGS, instantiate, isLifecycleId, LIFECYCLE_IDS, lifecycle, SCALES, scaleAtLeast, type Flag, type Requirement, type Scale } from './lifecycles.ts'
import { CADENCE, FLYWHEEL, FORUMS, isOrigin, isOrgRoleId, isReviewKind, isSignoffGate, isTeamId, LADDERS, ORG_ROLE_IDS, ORG_ROLES, ORIGIN_IDS, ORIGINS, REVIEW_KIND_IDS, REVIEW_KINDS, SIGNOFF_GATE_IDS, SIGNOFF_GATES, TEAM_IDS, TEAMS, type OrgFunction, type OrgRoleId, type ReviewKind } from './org.ts'
import { renderGate, renderInitiative, renderLifecycle, renderLifecycleIndex, renderPlanned, renderReviewKinds } from './render.ts'
import { report, REPORT_VIEWS, type ReportView } from './reports.ts'
import { actor, assertInitiativeId, newId, OPERATOR, sha256, SysintelStore, type Actor, type Evidence, type Initiative, type Level, type StageState, type WorkItem } from './store.ts'
import { headState, isAncestor, treeFingerprint, verifyBranch, verifyCommit } from './tree.ts'
import { triage, type TriageSignals } from './triage.ts'

/**
 * System Intelligence mode's engine: every si_* action, with strict parameters, run
 * against the org model and the workspace record. The model decides what the
 * organization should do next; the engine decides what is true — which stage an
 * initiative is in, whether its gates are met, and whether a review still speaks for the
 * code. A wrong call returns the action's exact usage.
 */

type ParamType = 'string' | 'number' | 'boolean' | 'string[]' | 'object[]'

export interface ParamSpec {
  type: ParamType
  description: string
  required?: boolean
  enum?: readonly string[]
}

export interface EngineContext {
  store: SysintelStore
  by: Actor
  gate: GateContext
}

export interface ActionSpec {
  tool: SiTool
  action: string
  summary: string
  params: Record<string, ParamSpec>
  run: (input: Record<string, unknown>, context: EngineContext) => string | Promise<string>
}

/** Parameters the governor reads; never coerced, so what was assessed is what runs. */
export const GOVERNED_PARAMS: ReadonlySet<string> = new Set(['action', 'command', 'path', 'gate'])

const ACTIONS: ActionSpec[] = []
function define(spec: ActionSpec): void {
  const key = `${spec.tool}.${spec.action}`
  if (!EFFECTS[key]) throw new Error(`sysintel action ${key} has no declared effect in sysintel/effects.ts`)
  ACTIONS.push(spec)
}

export function actionsFor(tool: SiTool): ActionSpec[] {
  return ACTIONS.filter((spec) => spec.tool === tool)
}

export function allActions(): ActionSpec[] {
  return [...ACTIONS]
}

function usage(spec: ActionSpec): string {
  const params = Object.entries(spec.params).map(([name, param]) => `${name}${param.required ? '' : '?'}: ${param.type}${param.enum ? ` (${param.enum.join('|')})` : ''} — ${param.description}`)
  return `${spec.tool} action "${spec.action}": ${spec.summary}${params.length ? `\n  ${params.join('\n  ')}` : ''}`
}

function coerce(name: string, param: ParamSpec, value: unknown): unknown {
  if (GOVERNED_PARAMS.has(name)) return value
  if (param.type === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (param.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true'
  if ((param.type === 'string[]' || param.type === 'object[]') && typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed)
      } catch {
        return value
      }
    }
    if (param.type === 'string[]') return trimmed ? [trimmed] : []
  }
  if (param.type === 'string[]' && Array.isArray(value)) return value.map((item) => (typeof item === 'number' ? String(item) : item))
  return value
}

function typeOk(param: ParamSpec, value: unknown): boolean {
  switch (param.type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'string[]': return Array.isArray(value) && value.every((item) => typeof item === 'string')
    case 'object[]': return Array.isArray(value) && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
  }
}

export function validateInput(spec: ActionSpec, input: Record<string, unknown>): Record<string, unknown> {
  const unknown = Object.keys(input).filter((key) => key !== 'action' && !(key in spec.params) && input[key] !== undefined && input[key] !== null)
  if (unknown.length) throw new Error(`unknown parameter(s) ${unknown.map((key) => `"${key}"`).join(', ')}\n${usage(spec)}`)
  const out: Record<string, unknown> = {}
  for (const [name, param] of Object.entries(spec.params)) {
    const raw = input[name]
    if (raw === undefined || raw === null || raw === '') {
      if (param.required) throw new Error(`"${name}" is required\n${usage(spec)}`)
      continue
    }
    const value = coerce(name, param, raw)
    if (!typeOk(param, value)) throw new Error(`"${name}" must be ${param.type}\n${usage(spec)}`)
    if (param.enum && typeof value === 'string' && !param.enum.includes(value)) throw new Error(`"${name}" must be one of ${param.enum.join(', ')}\n${usage(spec)}`)
    if (param.enum && Array.isArray(value)) {
      const bad = value.filter((item) => typeof item === 'string' && !param.enum!.includes(item))
      if (bad.length) throw new Error(`"${name}" has unknown value(s) ${bad.join(', ')} — use ${param.enum.join(', ')}\n${usage(spec)}`)
    }
    out[name] = value
  }
  return out
}

export async function runAction(tool: SiTool, input: Record<string, unknown>, options: { by?: Actor; cwd?: string } = {}): Promise<string> {
  const action = typeof input.action === 'string' ? input.action : ''
  const specs = actionsFor(tool)
  const spec = specs.find((candidate) => candidate.action === action)
  if (!spec) throw new Error(`${tool} has no action "${action}". Actions: ${specs.map((candidate) => candidate.action).join(', ')}`)
  const params = validateInput(spec, input)
  const store = new SysintelStore(options.cwd)
  return spec.run(params, { store, by: options.by ?? actor(), gate: gateContext(store) })
}

export function usageFor(tool: SiTool, action: string): string {
  const spec = actionsFor(tool).find((candidate) => candidate.action === action)
  return spec ? usage(spec) : ''
}

// ---------------------------------------------------------------- shared params

const ID = { type: 'string', description: 'initiative id, e.g. "SI-3"', required: true } as const satisfies ParamSpec
const SIGNAL_PARAMS: Record<string, ParamSpec> = {
  files: { type: 'number', description: 'rough number of files the change touches' },
  systems: { type: 'number', description: 'services, components, or teams it touches' },
  severity: { type: 'number', description: 'incident / vulnerability severity, 1 (worst) to 4' },
  strategic: { type: 'boolean', description: 'an organization-level, multi-quarter bet' },
  flags: { type: 'string[]', description: `facts about the work: ${FLAGS.join(', ')}`, enum: FLAGS },
  scale: { type: 'string', description: 'explicit scale — only honoured when it raises rigor', enum: SCALES },
}

function signalsFrom(input: Record<string, unknown>): TriageSignals {
  return {
    files: input.files as number | undefined,
    systems: input.systems as number | undefined,
    severity: input.severity as number | undefined,
    strategic: input.strategic as boolean | undefined,
    flags: input.flags as Flag[] | undefined,
    scale: input.scale as Scale | undefined,
  }
}

function text(value: unknown, field: string, max = 4000): string {
  const result = String(value ?? '').trim()
  if (!result) throw new Error(`"${field}" must not be empty`)
  return result.length > max ? `${result.slice(0, max)}…` : result
}

function mutable(initiative: Initiative): StageState {
  if (initiative.status === 'done') throw new Error(`${initiative.id} is done — open a follow-up with si_work intake parent:"${initiative.id}"`)
  if (initiative.status === 'abandoned') throw new Error(`${initiative.id} was abandoned: ${initiative.outcome ?? ''}`)
  const stage = currentStage(initiative)
  if (!stage) throw new Error(`${initiative.id} has no active stage`)
  return stage
}

function nextStep(initiative: Initiative, context: GateContext): string {
  if (initiative.status === 'done') return `${initiative.id} is done.`
  if (initiative.status === 'abandoned') return `${initiative.id} was abandoned.`
  if (initiative.status === 'blocked') return `${initiative.id} is blocked: ${initiative.blockedReason}. si_work unblock when it clears.`
  const stage = currentStage(initiative)
  if (!stage) return ''
  const open = evaluateStage(initiative, stage, context).filter((status) => !status.met)
  const owner = ORG_ROLES[stage.owner]
  if (!open.length) return `Next: every gate for "${stage.id}" is met — si_work advance id:"${initiative.id}".`
  return `Next: "${stage.id}" is owned by the ${owner.title} (${owner.owns}). ${owner.worker === 'lead' ? 'That hat is yours.' : `Delegate with si_work brief id:"${initiative.id}" → task role:"${owner.worker}".`} Open gates: ${open.map((status) => status.hint ?? status.detail).join(' · ')}`
}

function enter(stage: StageState, now: string): void {
  stage.status = 'active'
  stage.enteredAt = now
  stage.completedAt = undefined
  stage.visits += 1
}

// ---------------------------------------------------------------- si_org

define({
  tool: 'si_org', action: 'roles', summary: 'every hat in the organization and the question it owns',
  params: { function: { type: 'string', description: 'filter by function', enum: ['leadership', 'research', 'product', 'engineering', 'data-ml', 'reliability-security', 'program', 'knowledge'] } },
  run(input) {
    const roles = Object.values(ORG_ROLES).filter((role) => !input.function || role.function === (input.function as OrgFunction))
    return roles.map((role) => `${role.id.padEnd(24)} ${role.title} [${role.function}] — owns "${role.owns}" — worn by ${role.worker === 'lead' ? 'the lead' : `task role:${role.worker}`}`).join('\n')
  },
})

define({
  tool: 'si_org', action: 'role', summary: "one hat in full: its question, responsibilities, workflow, artifacts, reviews, and worker",
  params: { role: { type: 'string', description: 'hat id', required: true, enum: ORG_ROLE_IDS } },
  run(input) {
    const role = ORG_ROLES[input.role as keyof typeof ORG_ROLES]
    return [
      `${role.title} (${role.id}) — ${role.function}`,
      `owns: ${role.owns}`,
      `responsibilities: ${role.responsibilities.join('; ')}`,
      role.workflow ? `workflow: ${role.workflow.join(' → ')}` : '',
      `writes: ${role.produces.join(', ') || '—'}`,
      `reviews: ${role.reviews.join(', ') || '—'}`,
      `worn by: ${role.worker === 'lead' ? 'the lead agent itself (decisions and coordination)' : `task role:"${role.worker}"`}`,
    ].filter(Boolean).join('\n')
  },
})

define({
  tool: 'si_org', action: 'lifecycles', summary: 'every lifecycle work can move through',
  params: {},
  run: () => renderLifecycleIndex(),
})

define({
  tool: 'si_org', action: 'lifecycle', summary: 'one lifecycle: stages, owners, and exit gates (with scale/flags: exactly what would apply)',
  params: { lifecycle: { type: 'string', description: 'lifecycle id', required: true, enum: LIFECYCLE_IDS }, scale: SIGNAL_PARAMS.scale!, flags: SIGNAL_PARAMS.flags! },
  run(input) {
    const spec = lifecycle(input.lifecycle as string)
    if (!input.scale) return renderLifecycle(spec)
    return `${spec.title} at ${input.scale}${(input.flags as string[] | undefined)?.length ? ` with ${(input.flags as string[]).join(', ')}` : ''}:\n${renderPlanned(instantiate(spec.id, input.scale as Scale, (input.flags as Flag[] | undefined) ?? []))}`
  },
})

define({
  tool: 'si_org', action: 'ownership', summary: 'who owns which question — the organization is built around ownership, not titles',
  params: {},
  run: () => Object.values(ORG_ROLES).map((role) => `${role.title.padEnd(36)} owns: ${role.owns}`).join('\n'),
})

define({
  tool: 'si_org', action: 'reviews', summary: 'review kinds, who counts as independent for each, sign-off gates, and triage flags',
  params: {},
  run: () => renderReviewKinds(),
})

define({
  tool: 'si_org', action: 'ladder', summary: 'engineering and management levels, and what widens at each',
  params: {},
  run: () => [`Individual contributor:`, ...LADDERS.engineering.map(([level, scope]) => `  ${level.padEnd(24)} ${scope}`), 'Management:', ...LADDERS.management.map(([level, scope]) => `  ${level.padEnd(24)} ${scope}`)].join('\n'),
})

define({
  tool: 'si_org', action: 'cadence', summary: 'daily, weekly, and quarterly rhythms, the forums that move information, and the flywheel',
  params: {},
  run: () => [
    `Daily (engineering): ${CADENCE.daily.join(' → ')}`,
    `Daily (research): ${CADENCE.research.join(' → ')} — reading → thinking → experimenting → failing → learning → repeating`,
    `Weekly: ${CADENCE.weekly.join(' | ')}`,
    `Quarterly: ${CADENCE.quarterly.join(' → ')}`,
    `Forums: ${CADENCE.forums.join(', ')}`,
    'Where each forum lives in the record:',
    ...Object.entries(FORUMS).map(([forum, where]) => `  ${forum.padEnd(34)} ${where}`),
    `Origins of work: ${ORIGIN_IDS.map((origin) => `${origin} ("${ORIGINS[origin].example}")`).join('; ')}`,
    `Flywheel: ${FLYWHEEL}`,
  ].join('\n'),
})

define({
  tool: 'si_org', action: 'structure', summary: 'the org chart: teams, who leads them, the roles in each, and the specialised teams an autonomous-AI organization adds',
  params: {},
  run() {
    const lines: string[] = []
    const walk = (parent: string | undefined, depth: number): void => {
      for (const team of TEAMS.filter((candidate) => candidate.parent === parent)) {
        lines.push(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${team.name} [${team.id}]${team.specialised ? ' (specialised)' : ''} — led by the ${ORG_ROLES[team.lead].title}; ${team.mission}`)
        lines.push(`${'  '.repeat(depth + 1)}  roles: ${team.roles.map((role) => ORG_ROLES[role].title).join(', ')}`)
        walk(team.id, depth + 1)
      }
    }
    walk(undefined, 0)
    return [...lines, '', 'Work flows: Research ⇄ Engineering → Data / ML / AI → Software system → Security · QA · Reliability → Deployment → Production → Observability → Feedback → Research.', 'Initiatives are owned by a team (si_work intake team:… or si_work assign); stages are owned by a hat.'].join('\n')
  },
})

const INTAKE_PARAMS: Record<string, ParamSpec> = {
  title: { type: 'string', description: 'short title', required: true },
  problem: { type: 'string', description: 'the problem in a few sentences — who has it and why it matters', required: true },
  origin: { type: 'string', description: 'where the work came from', required: true, enum: ORIGIN_IDS },
  lifecycle: { type: 'string', description: `defaults from origin (${ORIGIN_IDS.map((origin) => `${origin}→${ORIGINS[origin].lifecycle}`).join(', ')})`, enum: LIFECYCLE_IDS },
  ...SIGNAL_PARAMS,
}

define({
  tool: 'si_org', action: 'triage', summary: 'preview the scale, flags, stages, and gates an intake would get — records nothing',
  params: INTAKE_PARAMS,
  run(input) {
    const result = triage({ origin: input.origin as never, lifecycle: input.lifecycle as string | undefined, title: input.title as string, problem: input.problem as string, signals: signalsFrom(input) })
    return [`${result.lifecycle} · scale ${result.scale}${result.flags.length ? ` · flags ${result.flags.join(', ')}` : ''}`, `why: ${result.reasons.join('; ')}`, 'stages:', renderPlanned(result.stages)].join('\n')
  },
})

// ---------------------------------------------------------------- si_work

function linkChild(store: SysintelStore, parent: string, child: string, by: Actor): void {
  store.update(parent, (initiative, journal) => {
    if (!initiative.children.includes(child)) initiative.children.push(child)
    journal('follow-up', child)
  }, by)
}

function createInitiative(store: SysintelStore, by: Actor, input: { title: string; problem: string; origin: string; lifecycle?: string; signals: TriageSignals; parent?: string; relation?: 'followup' | 'handoff'; dependsOn?: string[]; team?: string }): Initiative {
  if (!isOrigin(input.origin)) throw new Error(`origin must be one of ${ORIGIN_IDS.join(', ')}`)
  if (input.lifecycle !== undefined && !isLifecycleId(input.lifecycle)) throw new Error(`lifecycle must be one of ${LIFECYCLE_IDS.join(', ')}`)
  if (input.team !== undefined && !isTeamId(input.team)) throw new Error(`team must be one of ${TEAM_IDS.join(', ')}`)
  if (input.parent !== undefined && !store.exists(input.parent)) throw new Error(`no initiative ${input.parent}`)
  for (const dependency of input.dependsOn ?? []) if (!store.exists(dependency)) throw new Error(`no initiative ${dependency} to depend on`)
  const result = triage({ origin: input.origin, lifecycle: input.lifecycle, title: input.title, problem: input.problem, signals: input.signals })
  const now = new Date().toISOString()
  const base = headState(store.cwd)
  const created = store.create((id) => {
    const stages: StageState[] = result.stages.map((stage) => ({ ...stage, status: 'pending', visits: 0 }))
    if (stages[0]) enter(stages[0], now)
    return {
      version: 1, id, title: input.title, problem: input.problem, origin: input.origin as never, lifecycle: result.lifecycle, team: input.team, scale: result.scale, flags: result.flags, triage: result.reasons,
      status: 'active', stages, current: stages[0]?.id, baseTree: base.tree, baseHead: base.head, artifacts: [], evidence: [], reviews: [], decisions: [], risks: [], items: [],
      dependsOn: input.dependsOn ?? [], parent: input.parent, relation: input.parent ? input.relation ?? 'followup' : undefined, children: [], iterations: 0, by, createdAt: now, updatedAt: now,
    }
  })
  if (input.parent) linkChild(store, input.parent, created.id, by)
  return created
}

define({
  tool: 'si_work', action: 'intake', summary: 'open an initiative: triage it, fix its lifecycle stages and gates, and enter the first stage',
  params: {
    ...INTAKE_PARAMS,
    parent: { type: 'string', description: 'the initiative this follows from (a production problem, a postmortem action item, an RFC, a quarterly objective)' },
    dependsOn: { type: 'string[]', description: 'initiatives that must finish before this one can release' },
    team: { type: 'string', description: 'the team that owns it (si_org structure)', enum: TEAM_IDS },
  },
  run(input, context) {
    const created = createInitiative(context.store, context.by, {
      title: text(input.title, 'title', 200), problem: text(input.problem, 'problem'), origin: input.origin as string, lifecycle: input.lifecycle as string | undefined,
      signals: signalsFrom(input), parent: input.parent ? assertInitiativeId(input.parent, 'parent') : undefined, dependsOn: (input.dependsOn as string[] | undefined)?.map((id) => assertInitiativeId(id, 'dependsOn')), team: input.team as string | undefined,
    })
    const dirty = created.baseTree !== undefined && context.gate.tree() !== undefined && context.gate.tree() !== created.baseTree
    return [`Opened ${created.id}.${dirty ? ' Uncommitted changes already in the working tree count as part of this initiative\'s change.' : ''}`, renderInitiative(created, context.gate), '', nextStep(created, context.gate)].join('\n')
  },
})

define({
  tool: 'si_work', action: 'show', summary: 'one initiative in full, with the current stage\'s gates evaluated now',
  params: { id: ID },
  run(input, context) {
    const initiative = context.store.read(input.id as string)
    return [renderInitiative(initiative, context.gate), '', nextStep(initiative, context.gate)].join('\n')
  },
})

define({
  tool: 'si_work', action: 'list', summary: 'the board: every initiative, its stage, owner, and open gates',
  params: {},
  run: (_input, context) => report('board', context.store, context.gate),
})

define({
  tool: 'si_work', action: 'gate', summary: 'evaluate the current stage\'s exit gates without advancing',
  params: { id: ID },
  run(input, context) {
    const initiative = context.store.read(input.id as string)
    const stage = currentStage(initiative)
    if (!stage) return nextStep(initiative, context.gate)
    return [`${initiative.id} · ${stage.id} (${ORG_ROLES[stage.owner].title}) — ${stage.does}`, renderGate(evaluateStage(initiative, stage, context.gate)), '', nextStep(initiative, context.gate)].join('\n')
  },
})

define({
  tool: 'si_work', action: 'advance', summary: 'pass the current stage\'s gates and enter the next stage — or loop back to an earlier stage with to + reason (iteration: a refuted hypothesis, a failed review, a regression)',
  params: { id: ID, to: { type: 'string', description: 'an EARLIER stage to loop back to' }, reason: { type: 'string', description: 'why the loop back (required with to)' } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const outcome = context.store.update(id, (initiative, journal) => {
      if (initiative.status === 'blocked') throw new Error(`${id} is blocked: ${initiative.blockedReason}. si_work unblock first.`)
      const stage = mutable(initiative)
      const index = initiative.stages.indexOf(stage)
      const now = new Date().toISOString()
      if (input.to) {
        const target = initiative.stages.findIndex((candidate) => candidate.id === input.to)
        if (target === -1) throw new Error(`${id} has no stage "${String(input.to)}" — stages: ${initiative.stages.map((candidate) => candidate.id).join(', ')}`)
        if (target >= index) throw new Error(`stages are passed in order — "${String(input.to)}" is not before "${stage.id}". To move forward, meet the gates and si_work advance without "to".`)
        const reason = text(input.reason, 'reason', 1000)
        for (const later of initiative.stages.slice(target)) {
          later.status = 'pending'
          later.completedAt = undefined
        }
        enter(initiative.stages[target]!, now)
        initiative.current = initiative.stages[target]!.id
        initiative.iterations += 1
        journal('loop-back', `${stage.id} → ${initiative.current}: ${reason}`)
        return { moved: true, message: `Looped ${id} back from "${stage.id}" to "${initiative.current}" (iteration ${initiative.iterations}): ${reason}` }
      }
      const statuses = evaluateStage(initiative, stage, context.gate)
      const open = statuses.filter((status) => !status.met)
      if (open.length) return { moved: false, message: `Not advanced: "${stage.id}" still has ${open.length} open gate(s).\n${renderGate(statuses)}` }
      stage.status = 'done'
      stage.completedAt = now
      journal('stage-done', stage.id)
      const next = initiative.stages[index + 1]
      if (next) {
        enter(next, now)
        initiative.current = next.id
        return { moved: true, message: `${id}: "${stage.id}" done → now in "${next.id}" (${ORG_ROLES[next.owner].title}).` }
      }
      initiative.current = undefined
      initiative.status = 'done'
      initiative.completedAt = now
      journal('done', initiative.title)
      return { moved: true, message: `${id}: "${stage.id}" done — every stage is complete. ${initiative.title} is done.` }
    }, context.by)
    const initiative = context.store.read(id)
    return [outcome.message, '', nextStep(initiative, context.gate)].join('\n')
  },
})

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const

define({
  tool: 'si_work', action: 'plan', summary: 'the work breakdown (epic → tasks): each item has an owner hat, priority, estimate, dependencies, and acceptance criteria. Items with an existing id are updated.',
  params: { id: ID, items: { type: 'object[]', description: `[{ id?, title, owner (${ORG_ROLE_IDS.slice(0, 4).join('|')}|…), priority? (P0–P3), estimate?, dependsOn? [item ids], acceptance [criteria] }]`, required: true } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const summary = context.store.update(id, (initiative, journal) => {
      mutable(initiative)
      const incoming = input.items as Record<string, unknown>[]
      if (!incoming.length) throw new Error('items must list at least one work item')
      const now = new Date().toISOString()
      const next = [...initiative.items]
      let counter = next.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0)
      for (const raw of incoming) {
        const owner = String(raw.owner ?? '')
        if (!isOrgRoleId(owner)) throw new Error(`item "${String(raw.title ?? raw.id)}": owner must be a hat id (${ORG_ROLE_IDS.join(', ')})`)
        const priority = String(raw.priority ?? 'P2').toUpperCase()
        if (!(PRIORITIES as readonly string[]).includes(priority)) throw new Error(`item "${String(raw.title)}": priority must be P0–P3`)
        const acceptance = (Array.isArray(raw.acceptance) ? raw.acceptance : typeof raw.acceptance === 'string' ? [raw.acceptance] : []).map((value) => String(value).trim()).filter(Boolean)
        const dependsOn = (Array.isArray(raw.dependsOn) ? raw.dependsOn : typeof raw.dependsOn === 'string' ? [raw.dependsOn] : []).map((value) => String(value).trim().toUpperCase())
        const rawId = typeof raw.id === 'string' ? raw.id.toUpperCase() : undefined
        const existing = rawId ? next.find((item) => item.id === rawId) : undefined
        if (existing) {
          existing.title = raw.title ? text(raw.title, 'title', 200) : existing.title
          existing.owner = owner
          existing.priority = priority as WorkItem['priority']
          existing.estimate = raw.estimate === undefined ? existing.estimate : String(raw.estimate)
          existing.dependsOn = dependsOn
          existing.acceptance = acceptance.length ? acceptance : existing.acceptance
          existing.updatedAt = now
        } else {
          counter += 1
          next.push({ id: `T${counter}`, title: text(raw.title, 'title', 200), owner, priority: priority as WorkItem['priority'], estimate: raw.estimate === undefined ? undefined : String(raw.estimate), dependsOn, acceptance, status: 'todo', updatedAt: now })
        }
      }
      const ids = new Set(next.map((item) => item.id))
      for (const item of next) for (const dependency of item.dependsOn) if (!ids.has(dependency)) throw new Error(`${item.id} depends on unknown item ${dependency}`)
      const visiting = new Set<string>()
      const done = new Set<string>()
      const byId = new Map(next.map((item) => [item.id, item]))
      const visit = (itemId: string, path: string[]): void => {
        if (done.has(itemId)) return
        if (visiting.has(itemId)) throw new Error(`work items form a cycle: ${[...path, itemId].join(' → ')}`)
        visiting.add(itemId)
        for (const dependency of byId.get(itemId)!.dependsOn) visit(dependency, [...path, itemId])
        visiting.delete(itemId)
        done.add(itemId)
      }
      for (const item of next) visit(item.id, [])
      initiative.items = next
      journal('plan', `${next.length} item(s)`)
      return next.map((item) => `${item.id} [${item.status}] ${item.priority} ${item.title} — ${ORG_ROLES[item.owner].title}${item.dependsOn.length ? ` · after ${item.dependsOn.join(', ')}` : ''}${item.acceptance.length ? '' : ' · NO ACCEPTANCE CRITERIA'}`).join('\n')
    }, context.by)
    return `${id} work breakdown:\n${summary}`
  },
})

define({
  tool: 'si_work', action: 'item', summary: 'update one work item\'s status',
  params: { id: ID, item: { type: 'string', description: 'item id, e.g. "T2"', required: true }, status: { type: 'string', description: 'new status', required: true, enum: ['todo', 'in-progress', 'done', 'dropped'] }, note: { type: 'string', description: 'what happened (required to drop an item)' } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    return context.store.update(id, (initiative, journal) => {
      mutable(initiative)
      const item = initiative.items.find((candidate) => candidate.id === String(input.item).toUpperCase())
      if (!item) throw new Error(`${id} has no item ${String(input.item)} — items: ${initiative.items.map((candidate) => candidate.id).join(', ') || 'none (si_work plan)'}`)
      const status = input.status as WorkItem['status']
      if (status === 'dropped' && !input.note) throw new Error('say why the item is dropped (note)')
      if (status === 'done') {
        const open = item.dependsOn.filter((dependency) => !['done', 'dropped'].includes(initiative.items.find((candidate) => candidate.id === dependency)?.status ?? ''))
        if (open.length) throw new Error(`${item.id} cannot be done before ${open.join(', ')}`)
      }
      item.status = status
      if (input.note) item.note = String(input.note)
      item.updatedAt = new Date().toISOString()
      journal('item', `${item.id} → ${status}`)
      const remaining = initiative.items.filter((candidate) => candidate.status !== 'done' && candidate.status !== 'dropped').length
      return `${id} ${item.id} is ${status}. ${remaining} item(s) still open.`
    }, context.by)
  },
})

function requirementKey(requirement: Requirement): string {
  return `${requirement.type}:${requirement.artifact ?? requirement.review ?? requirement.gate ?? ''}:${requirement.fresh ? 'fresh' : ''}:${requirement.hat ?? ''}:${requirement.subject ?? ''}`
}

define({
  tool: 'si_work', action: 'retriage', summary: 'new facts about the work — raises scale or adds flags (never lowers rigor). Gates added to stages already passed move into the current stage.',
  params: { id: ID, ...SIGNAL_PARAMS, reason: { type: 'string', description: 'what was learned', required: true } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const message = context.store.update(id, (initiative, journal) => {
      const current = mutable(initiative)
      const signals = signalsFrom(input)
      const floor = signals.scale && scaleAtLeast(signals.scale, initiative.scale) ? signals.scale : initiative.scale
      const result = triage({ origin: initiative.origin, lifecycle: initiative.lifecycle, title: initiative.title, problem: initiative.problem, signals: { ...signals, flags: [...new Set([...initiative.flags, ...(signals.flags ?? [])])], scale: floor } })
      const oldById = new Map(initiative.stages.map((stage) => [stage.id, stage]))
      const currentIndexNew = result.stages.findIndex((stage) => stage.id === current.id)
      const carried: Requirement[] = []
      const stages: StageState[] = result.stages.map((planned, index) => {
        const old = oldById.get(planned.id)
        const passed = currentIndexNew !== -1 && index < currentIndexNew
        if (passed) {
          const had = new Set((old?.requirements ?? []).map(requirementKey))
          for (const requirement of planned.requirements) if (!had.has(requirementKey(requirement))) carried.push({ ...requirement, why: `added by re-triage to "${planned.id}"` })
        }
        if (!old) return { ...planned, status: passed ? 'done' : 'pending', visits: 0, ...(passed ? { completedAt: new Date().toISOString(), carried: true } : {}) }
        const plannedKeys = new Set(planned.requirements.map(requirementKey))
        const keptCarried = old.requirements.filter((requirement) => requirement.why.startsWith('added by re-triage') && !plannedKeys.has(requirementKey(requirement)))
        return { ...planned, requirements: old.status === 'done' ? old.requirements : [...planned.requirements, ...keptCarried], status: old.status, enteredAt: old.enteredAt, completedAt: old.completedAt, visits: old.visits }
      })
      if (currentIndexNew === -1) throw new Error(`re-triage would remove the current stage "${current.id}" — not allowed`)
      const now = stages[currentIndexNew]!
      const have = new Set(now.requirements.map(requirementKey))
      for (const requirement of carried) {
        if (have.has(requirementKey(requirement))) continue
        have.add(requirementKey(requirement))
        now.requirements.push(requirement)
      }
      const before = `${initiative.scale}${initiative.flags.length ? ` [${initiative.flags.join(', ')}]` : ''}`
      initiative.scale = result.scale
      initiative.flags = result.flags
      initiative.triage = [...initiative.triage, `re-triage: ${text(input.reason, 'reason', 600)} → ${result.reasons.join('; ')}`]
      initiative.stages = stages
      journal('retriage', `${before} → ${result.scale} [${result.flags.join(', ')}]`)
      return `${id} re-triaged: ${before} → ${result.scale}${result.flags.length ? ` [${result.flags.join(', ')}]` : ''}.${carried.length ? ` ${carried.length} gate(s) from passed stages now apply to "${current.id}".` : ''}`
    }, context.by)
    return [message, '', renderInitiative(context.store.read(id), context.gate)].join('\n')
  },
})

define({
  tool: 'si_work', action: 'block', summary: 'mark an initiative blocked, with the reason (a dependency, a decision, missing access)',
  params: { id: ID, reason: { type: 'string', description: 'what it is waiting on', required: true } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    return context.store.update(id, (initiative, journal) => {
      mutable(initiative)
      initiative.status = 'blocked'
      initiative.blockedReason = text(input.reason, 'reason', 600)
      journal('blocked', initiative.blockedReason)
      return `${id} is blocked: ${initiative.blockedReason}`
    }, context.by)
  },
})

define({
  tool: 'si_work', action: 'unblock', summary: 'clear a block',
  params: { id: ID, note: { type: 'string', description: 'what cleared it' } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    return context.store.update(id, (initiative, journal) => {
      if (initiative.status !== 'blocked') return `${id} is not blocked.`
      initiative.status = 'active'
      initiative.blockedReason = undefined
      journal('unblocked', input.note ? String(input.note) : undefined)
      return `${id} is active again.`
    }, context.by)
  },
})

define({
  tool: 'si_work', action: 'depend', summary: 'record that this initiative cannot release until others finish (cross-team dependencies)',
  params: { id: ID, on: { type: 'string[]', description: 'initiative ids', required: true } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const on = (input.on as string[]).map((value) => assertInitiativeId(value, 'on'))
    for (const dependency of on) {
      if (dependency === id) throw new Error('an initiative cannot depend on itself')
      if (!context.store.exists(dependency)) throw new Error(`no initiative ${dependency}`)
    }
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true
      if (seen.has(from) || !context.store.exists(from)) return false
      seen.add(from)
      return context.store.read(from).dependsOn.some((next) => reaches(next, target, seen))
    }
    const cycle = on.find((dependency) => reaches(dependency, id))
    if (cycle) throw new Error(`${cycle} already depends on ${id} (directly or through others) — that would be a cycle`)
    return context.store.update(id, (initiative, journal) => {
      mutable(initiative)
      for (const dependency of on) if (!initiative.dependsOn.includes(dependency)) initiative.dependsOn.push(dependency)
      journal('depends', on.join(', '))
      return `${id} now depends on ${initiative.dependsOn.join(', ')}.`
    }, context.by)
  },
})

define({
  tool: 'si_work', action: 'assign', summary: 'give an initiative to the team that owns it',
  params: { id: ID, team: { type: 'string', description: 'team id (si_org structure)', required: true, enum: TEAM_IDS } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const team = TEAMS.find((candidate) => candidate.id === input.team)!
    return context.store.update(id, (initiative, journal) => {
      if (initiative.status === 'abandoned') throw new Error(`${id} was abandoned`)
      initiative.team = team.id
      journal('assign', team.id)
      return `${id} is owned by ${team.name} (led by the ${ORG_ROLES[team.lead].title}).`
    }, context.by)
  },
})

define({
  tool: 'si_work', action: 'link', summary: 'link initiatives that already exist as follow-ups of this one (postmortem action items, RFC implementation work, quarterly projects opened before they were linked)',
  params: { id: { ...ID, description: 'the parent initiative' }, children: { type: 'string[]', description: 'initiative ids to link under it', required: true } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const children = [...new Set((input.children as string[]).map((value) => assertInitiativeId(value, 'children')))]
    const ancestors = new Set<string>()
    for (let cursor: string | undefined = id; cursor && !ancestors.has(cursor) && context.store.exists(cursor); cursor = context.store.read(cursor).parent) ancestors.add(cursor)
    for (const child of children) {
      if (!context.store.exists(child)) throw new Error(`no initiative ${child}`)
      if (ancestors.has(child)) throw new Error(`${child} is ${child === id ? 'this initiative' : `an ancestor of ${id}`} — that would be a cycle`)
      const parent = context.store.read(child).parent
      if (parent && parent !== id) throw new Error(`${child} already follows from ${parent}`)
    }
    context.store.read(id)
    for (const child of children) {
      context.store.update(child, (initiative, journal) => {
        if (initiative.parent === id) return
        initiative.parent = id
        initiative.relation = 'followup'
        journal('linked', `follow-up of ${id}`)
      }, context.by)
    }
    const after = context.store.update(id, (initiative, journal) => {
      for (const child of children) if (!initiative.children.includes(child)) initiative.children.push(child)
      journal('follow-ups', children.join(', '))
      return structuredClone(initiative)
    }, context.by)
    return `${id} follow-ups: ${after.children.join(', ')}.\n${nextStep(after, context.gate)}`
  },
})

define({
  tool: 'si_work', action: 'handoff', summary: 'research → engineering: turn a validated research result with a go/conditional feasibility assessment into an engineering initiative',
  params: {
    id: { ...ID, description: 'the research initiative' },
    title: { type: 'string', description: 'title of the engineering initiative', required: true },
    problem: { type: 'string', description: 'what engineering will build from the result', required: true },
    lifecycle: { type: 'string', description: 'engineering lifecycle (default feature)', enum: LIFECYCLE_IDS },
    ...SIGNAL_PARAMS,
  },
  run(input, context) {
    const source = context.store.read(input.id as string)
    if (source.lifecycle !== 'research' && source.lifecycle !== 'analysis') throw new Error(`${source.id} is a ${source.lifecycle} initiative — a handoff starts from research or analysis`)
    const validated = source.status === 'done' || source.stages.some((stage) => (stage.id === 'validation' || stage.id === 'interpretation') && stage.status === 'done')
    if (!validated) throw new Error(`${source.id} has not passed validation yet — a research result is not production-ready until an independent research review approves it`)
    const feasibility = latestArtifact(source, 'feasibility')
    if (!feasibility) throw new Error(`${source.id} has no feasibility assessment. Write one (si_artifact template artifact:"feasibility"): inference cost, latency, memory, reliability, scalability, security, maintainability, licensing, data requirements, verdict.`)
    if (!feasibility.valid || context.store.artifactIntact(feasibility) !== 'ok') throw new Error(`${feasibility.id} is not a valid, intact feasibility assessment — fix it first`)
    const verdict = markdownSections(context.store.readArtifactFile(feasibility) ?? '').get('verdict') ?? ''
    if (/\bno[- ]go\b/i.test(verdict)) throw new Error(`${feasibility.id} says no-go — the result stays research. Record why with si_record note.`)
    const signals = signalsFrom(input)
    const created = createInitiative(context.store, context.by, {
      title: text(input.title, 'title', 200), problem: `${text(input.problem, 'problem')}\n(From ${source.id}: ${source.title}; feasibility ${feasibility.id}.)`, origin: 'research', lifecycle: (input.lifecycle as string | undefined) ?? 'feature',
      signals: { ...signals, flags: (signals.flags ?? []).filter((flag) => flag !== 'novel') }, parent: source.id, relation: 'handoff',
    })
    return [`Handed ${source.id} to engineering as ${created.id}.`, renderInitiative(created, context.gate), '', nextStep(created, context.gate)].join('\n')
  },
})

define({
  tool: 'si_work', action: 'close', summary: 'abandon an initiative, with the reason (finished work closes itself when its last stage passes)',
  params: { id: ID, reason: { type: 'string', description: 'why it stops here', required: true } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    return context.store.update(id, (initiative, journal) => {
      if (initiative.status === 'done') return `${id} is already done.`
      initiative.status = 'abandoned'
      initiative.outcome = text(input.reason, 'reason', 1000)
      initiative.current = undefined
      journal('abandoned', initiative.outcome)
      return `${id} abandoned: ${initiative.outcome}`
    }, context.by)
  },
})

function recordingInstructions(workerRole: string, initiativeId: string): string {
  const reviewKinds = REVIEW_KIND_IDS.filter((kind) => (REVIEW_KINDS[kind].workers as readonly string[]).includes(workerRole))
  if (reviewKinds.length) {
    return `Record your verdict against ${initiativeId} before you finish: si_record review id:"${initiativeId}" kind:"${reviewKinds[0]}" verdict:"approve"|"changes-requested"|"reject" summary:"…" findings:[…] (each finding: the input or state that triggers it and what goes wrong). Approve only what you actually verified. Your review speaks for the code as it is now; any later change makes it stale.`
  }
  if (workerRole === 'scribe') return `Write documents with si_artifact write id:"${initiativeId}" artifact:"<kind>" (si_artifact template shows the required sections).`
  if (workerRole === 'scout' || workerRole === 'designer') return `Record what you found against ${initiativeId}: si_record note id:"${initiativeId}" summary:"…" (and si_record link for sources). Specific and falsifiable — paths, numbers, sources.`
  return `Attach evidence to ${initiativeId} as you go: si_record check id:"${initiativeId}" command:"<test command>" after your last edit (the engine runs it and records the result), si_record commit if you commit, and si_work item status:"done" for each finished work item.`
}

define({
  tool: 'si_work', action: 'brief', summary: 'compose a ready-to-send task brief for the hat that owns the current stage (or a work item): worker role, prompt, acceptance criteria, verification commands',
  params: {
    id: ID,
    role: { type: 'string', description: 'hat to brief (default: the stage owner, or the item owner)', enum: ORG_ROLE_IDS },
    item: { type: 'string', description: 'work item id to brief' },
    review: { type: 'string', description: 'brief an independent reviewer for this review kind instead', enum: REVIEW_KIND_IDS },
    hat: { type: 'string', description: 'with review: the hat the reviewer wears (default: what the gate asks for)', enum: ORG_ROLE_IDS },
  },
  run(input, context) {
    const initiative = context.store.read(input.id as string)
    const stage = currentStage(initiative)
    if (!stage) return nextStep(initiative, context.gate)
    if (input.review) return reviewerBrief(initiative, stage, input.review as ReviewKind, input.hat as OrgRoleId | undefined, context)
    const item = input.item ? initiative.items.find((candidate) => candidate.id === String(input.item).toUpperCase()) : undefined
    if (input.item && !item) throw new Error(`${initiative.id} has no item ${String(input.item)}`)
    const hat = ORG_ROLES[(input.role as keyof typeof ORG_ROLES | undefined) ?? item?.owner ?? stage.owner]
    const open = evaluateStage(initiative, stage, context.gate).filter((status) => !status.met)
    if (hat.worker === 'lead') return `The ${hat.title} hat is the lead's own: ${hat.owns} For "${stage.id}": ${stage.does} Open gates: ${open.map((status) => status.hint ?? status.detail).join(' · ') || 'none'}`
    const artifacts = [...new Set(initiative.artifacts.map((artifact) => artifact.kind))].map((kind) => latestArtifact(initiative, kind)!).map((artifact) => `${artifact.kind}: ${artifact.path}${artifact.valid ? '' : ' (invalid)'}`)
    const acceptance = item?.acceptance.length ? item.acceptance : open.map((status) => `${requirementLine(status.requirement)} — currently: ${status.detail}`)
    const checks = detectChecks(context.store.cwd)
    const prompt = [
      `You are acting as the ${hat.title} for initiative ${initiative.id} ("${initiative.title}") in elia's System Intelligence mode. You own one question: ${hat.owns}`,
      `Problem: ${initiative.problem}`,
      `Stage: ${stage.title} — ${stage.does}`,
      item ? `Your work item ${item.id}: ${item.title}${item.dependsOn.length ? ` (after ${item.dependsOn.join(', ')})` : ''}.` : '',
      `Scale ${initiative.scale}${initiative.flags.length ? `, flagged ${initiative.flags.join(', ')}` : ''}.`,
      artifacts.length ? `Artifacts on record (read them): ${artifacts.join('; ')}` : '',
      `Your responsibilities in this hat: ${hat.responsibilities.join('; ')}.`,
      `Done means:\n${acceptance.map((line) => `- ${line}`).join('\n')}`,
      recordingInstructions(hat.worker, initiative.id),
      'Report exactly what you did, what you verified and how, and anything you could not finish.',
    ].filter(Boolean).join('\n\n')
    const call = { description: `${hat.id} ${initiative.id} ${item?.id ?? stage.id}`.slice(0, 60), role: hat.worker, prompt, acceptanceCriteria: acceptance, verificationCommands: checks.length ? checks : undefined }
    return `task call for the ${hat.title} (worker role "${hat.worker}"):\n${JSON.stringify(call, null, 2)}${checks.length ? '' : '\n(No project check was detected — a write-capable task needs verificationCommands: add the command that proves the work.)'}`
  },
})

/**
 * A review is briefed to a worker qualified to give it (so it counts as independent), wearing
 * the hat the gate asks for, pointed at exactly what must be reviewed: the current code, or
 * the current version of a design document.
 */
function reviewerBrief(initiative: Initiative, stage: StageState, kind: ReviewKind, hatInput: OrgRoleId | undefined, context: EngineContext): string {
  const spec = REVIEW_KINDS[kind]
  const requirement = stage.requirements.find((candidate) => candidate.type === 'review' && candidate.review === kind && (!hatInput || candidate.hat === hatInput))
  const hat = ORG_ROLES[hatInput ?? requirement?.hat ?? spec.by]
  const onDesign = (requirement?.subject ?? spec.subject) === 'artifact'
  const worker = spec.workers[0]
  const documents = [...new Set(initiative.artifacts.map((artifact) => artifact.kind))].map((artifactKind) => latestArtifact(initiative, artifactKind)!).filter((artifact) => artifact.valid)
  const subject = onDesign
    ? `Review the design documents on record, at their current versions: ${documents.map((artifact) => `${artifact.kind} → ${artifact.path}`).join('; ') || 'none yet — say so and stop'}. Pass the one you reviewed as artifact:"<kind>".`
    : 'Review the exact current code: start from `git status` and `git diff` (including untracked files), then read the changed files in full context.'
  const record = `si_record review id:"${initiative.id}" kind:"${kind}" hat:"${hat.id}"${onDesign ? ' artifact:"<kind>"' : ''} verdict:"approve"|"changes-requested"|"reject" summary:"…" findings:[…]`
  const prompt = [
    `You are the independent reviewer for initiative ${initiative.id} ("${initiative.title}") in elia's System Intelligence mode, wearing the ${hat.title} hat. You did not write this work: verify rather than trust.`,
    `Problem: ${initiative.problem}`,
    `Review: ${kind} — ${spec.asks}`,
    subject,
    `Scale ${initiative.scale}${initiative.flags.length ? `, flagged ${initiative.flags.join(', ')}` : ''}.`,
    `Record your verdict before you finish: ${record}. Approve only what you actually checked. Every finding names the input or state that triggers it and what goes wrong; if you cannot describe how it breaks, it is not a finding. Your review speaks for this exact version — any later change makes it stale.`,
    'Report what you checked, how, and your verdict.',
  ].join('\n\n')
  const call = { description: `${kind} ${initiative.id}`.slice(0, 60), role: worker, prompt, acceptanceCriteria: [`a ${kind} verdict recorded against ${initiative.id} with si_record review`], verificationCommands: detectChecks(context.store.cwd) }
  return `task call for an independent ${kind} (worker role "${worker}", wearing the ${hat.title} hat):\n${JSON.stringify(call, null, 2)}`
}

function requirementLine(requirement: Requirement): string {
  switch (requirement.type) {
    case 'artifact': return `a valid ${artifactTemplate(requirement.artifact!).title} (${requirement.artifact})`
    case 'review': return `an independent ${requirement.review} approval${requirement.hat ? ` from the ${ORG_ROLES[requirement.hat].title}` : ''}${requirement.subject === 'artifact' ? ' of the design' : ''}`
    case 'signoff': return `the person's ${requirement.gate} sign-off`
    case 'check': return requirement.fresh ? 'the project checks pass on the final code' : 'a passing check run'
    case 'change': return 'the change exists in the code'
    default: return requirement.type
  }
}

define({
  tool: 'si_work', action: 'report', summary: `organization views computed from the record: ${REPORT_VIEWS.join(', ')}`,
  params: { view: { type: 'string', description: 'board (default) · priorities (Monday: what matters this week) · week (Friday: shipped/learned/failed/next) · quarter (metrics) · flywheel (lineage) · dependencies (TPM) · risks · knowledge (artifact index) · digest (status update)', enum: REPORT_VIEWS }, days: { type: 'number', description: 'window for week / quarter' } },
  run: (input, context) => report((input.view as ReportView | undefined) ?? 'board', context.store, context.gate, input.days as number | undefined),
})

// ---------------------------------------------------------------- si_artifact

const ARTIFACT_PARAM: ParamSpec = { type: 'string', description: 'artifact kind', required: true, enum: ARTIFACT_KINDS }

define({
  tool: 'si_artifact', action: 'template', summary: 'the Markdown skeleton for an artifact kind, with every required section',
  params: { artifact: ARTIFACT_PARAM, title: { type: 'string', description: 'document title' } },
  run(input) {
    const template = artifactTemplate(input.artifact as string)
    return `${template.title} — owned by the ${ORG_ROLES[template.owner].title}. ${template.purpose}\nEvery "##" section below is required and must hold real content (no TBD).\n\n${renderTemplate(template.kind, input.title as string | undefined)}`
  },
})

define({
  tool: 'si_artifact', action: 'write', summary: 'write a new version of an artifact for an initiative; it is validated against its template and hashed',
  params: { id: ID, artifact: ARTIFACT_PARAM, content: { type: 'string', description: 'the full Markdown document', required: true }, title: { type: 'string', description: 'document title' } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const kind = input.artifact as string
    const content = String(input.content)
    if (content.length > 400_000) throw new Error('content exceeds 400000 characters')
    const validation = validateArtifact(kind, content)
    const template = artifactTemplate(kind)
    const digest = sha256(content)
    const result = context.store.update(id, (initiative, journal) => {
      const stage = mutable(initiative)
      const latest = latestArtifact(initiative, kind)
      if (latest && latest.sha256 === digest && context.store.artifactIntact(latest) === 'ok') return { record: latest, unchanged: true }
      const version = (latest?.version ?? 0) + 1
      const path = context.store.writeArtifactFile(id, kind, version, content)
      const record = { id: `${kind}@v${version}`, kind, version, title: (input.title as string | undefined) ?? /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? template.title, path: context.store.relative(path), sha256: digest, valid: validation.valid, errors: validation.errors, warnings: validation.warnings, stage: stage.id, by: context.by, at: new Date().toISOString() }
      initiative.artifacts.push(record)
      journal('artifact', `${record.id} ${record.valid ? 'valid' : 'invalid'}`)
      return { record, unchanged: false }
    }, context.by)
    const { record } = result
    const lines = [`${id} ${record.id} ${result.unchanged ? 'unchanged (same content as the latest version)' : 'written'} → ${record.path}`, record.valid ? `valid ${template.title}.` : `INVALID — the gate will not accept it until fixed:\n${record.errors.map((error) => `  - ${error}`).join('\n')}`]
    if (record.warnings.length) lines.push(`warnings:\n${record.warnings.map((warning) => `  - ${warning}`).join('\n')}`)
    return lines.join('\n')
  },
})

define({
  tool: 'si_artifact', action: 'validate', summary: 're-check the latest version of an artifact: template sections and that the file still matches its recorded hash',
  params: { id: ID, artifact: ARTIFACT_PARAM },
  run(input, context) {
    const initiative = context.store.read(input.id as string)
    const latest = latestArtifact(initiative, input.artifact as string)
    if (!latest) return `${initiative.id} has no ${String(input.artifact)} yet.`
    const intact = context.store.artifactIntact(latest)
    if (intact !== 'ok') return `${latest.id} is ${intact} on disk since it was recorded — rewrite it with si_artifact write.`
    const validation = validateArtifact(latest.kind, context.store.readArtifactFile(latest) ?? '')
    return validation.valid ? `${latest.id} is valid and intact.${validation.warnings.length ? ` Warnings: ${validation.warnings.join('; ')}` : ''}` : `${latest.id} is INVALID:\n${validation.errors.map((error) => `  - ${error}`).join('\n')}`
  },
})

define({
  tool: 'si_artifact', action: 'show', summary: 'read an artifact version',
  params: { id: ID, artifact: ARTIFACT_PARAM, version: { type: 'number', description: 'version (default latest)' } },
  run(input, context) {
    const initiative = context.store.read(input.id as string)
    const record = input.version ? initiative.artifacts.find((artifact) => artifact.kind === input.artifact && artifact.version === input.version) : latestArtifact(initiative, input.artifact as string)
    if (!record) return `${initiative.id} has no ${String(input.artifact)}${input.version ? ` v${String(input.version)}` : ''}.`
    const content = context.store.readArtifactFile(record)
    if (content === undefined) return `${record.id} is missing from ${record.path}.`
    return `${record.id} (${record.valid ? 'valid' : 'invalid'}, ${context.store.artifactIntact(record)}) — ${record.path}\n\n${content}`
  },
})

define({
  tool: 'si_artifact', action: 'list', summary: 'the knowledge index: artifacts for one initiative or across the organization',
  params: { id: { type: 'string', description: 'initiative id (default: all)' }, kind: { type: 'string', description: 'filter by kind', enum: ARTIFACT_KINDS } },
  run(input, context) {
    if (!input.id && !input.kind) return report('knowledge', context.store, context.gate)
    const initiatives = input.id ? [context.store.read(input.id as string)] : context.store.list()
    const rows = initiatives.flatMap((initiative) => initiative.artifacts.filter((artifact) => !input.kind || artifact.kind === input.kind).map((artifact) => `${initiative.id} ${artifact.id} ${artifact.valid ? 'valid' : 'INVALID'} ${context.store.artifactIntact(artifact)} — ${artifact.path}`))
    return rows.length ? rows.join('\n') : 'No matching artifacts.'
  },
})

define({
  tool: 'si_artifact', action: 'export', summary: 'copy the latest valid version of an artifact into the project (e.g. docs/rfcs/0007-rate-limits.md) so it lives with the code',
  params: { id: ID, artifact: ARTIFACT_PARAM, path: { type: 'string', description: 'project-relative destination path (.md)', required: true }, overwrite: { type: 'boolean', description: 'replace an existing file at path' } },
  run(input, context) {
    const initiative = context.store.read(input.id as string)
    const latest = latestArtifact(initiative, input.artifact as string)
    if (!latest) throw new Error(`${initiative.id} has no ${String(input.artifact)}`)
    if (!latest.valid) throw new Error(`${latest.id} is invalid — only a valid artifact is exported`)
    if (context.store.artifactIntact(latest) !== 'ok') throw new Error(`${latest.id} changed on disk since it was recorded`)
    const path = String(input.path)
    const target = isAbsolute(path) ? path : resolve(context.store.cwd, path)
    const rel = relative(context.store.cwd, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('the export path must be inside the project')
    if (rel.split(/[\\/]/)[0] === '.elia') throw new Error('export into the project, not into .elia')
    if (!/\.(md|markdown|mdx|txt)$/i.test(target)) throw new Error('export to a Markdown (.md) path')
    if (existsSync(target) && input.overwrite !== true) throw new Error(`${rel} already exists — pass overwrite:true to replace it`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, context.store.readArtifactFile(latest) ?? '')
    context.store.update(initiative.id, (record, journal) => {
      const artifact = record.artifacts.find((candidate) => candidate.id === latest.id)
      if (artifact) artifact.exportedTo = [...new Set([...(artifact.exportedTo ?? []), rel.split('\\').join('/')])]
      journal('export', `${latest.id} → ${rel}`)
    }, context.by)
    return `Exported ${latest.id} to ${rel.split('\\').join('/')}.`
  },
})

// ---------------------------------------------------------------- si_record

function addEvidence(context: EngineContext, id: string, build: (initiative: Initiative, stage: StageState) => Omit<Evidence, 'id' | 'stage' | 'by' | 'at'>, event: string): { evidence: Evidence; initiative: Initiative } {
  return context.store.update(id, (initiative, journal) => {
    const stage = mutable(initiative)
    const evidence: Evidence = { id: newId('E'), stage: stage.id, by: context.by, at: new Date().toISOString(), ...build(initiative, stage) }
    initiative.evidence.push(evidence)
    journal(event, evidence.summary.slice(0, 200))
    return { evidence, initiative: structuredClone(initiative) }
  }, context.by)
}

define({
  tool: 'si_record', action: 'note', summary: 'record a finding against the current stage (discovery results, observed metrics, the approach chosen). A note ends soft stages only — never a review, test, or release gate.',
  params: { id: ID, summary: { type: 'string', description: 'the finding — specific and falsifiable', required: true } },
  run(input, context) {
    const { evidence, initiative } = addEvidence(context, assertInitiativeId(input.id), () => ({ kind: 'note', summary: text(input.summary, 'summary') }), 'note')
    return `${initiative.id} note recorded for "${evidence.stage}".\n${nextStep(initiative, context.gate)}`
  },
})

define({
  tool: 'si_record', action: 'link', summary: 'record a reference (pull request, CI run, dashboard, paper, issue) against the current stage',
  params: { id: ID, url: { type: 'string', description: 'http(s) URL or project-relative path', required: true }, summary: { type: 'string', description: 'what it is', required: true } },
  run(input, context) {
    const url = String(input.url).trim()
    if (!/^https?:\/\/\S+$/i.test(url) && (isAbsolute(url) || url.includes('..') || /\s/.test(url))) throw new Error('url must be an http(s) URL or a project-relative path')
    const { evidence, initiative } = addEvidence(context, assertInitiativeId(input.id), () => ({ kind: 'link', url, summary: text(input.summary, 'summary', 600) }), 'link')
    return `${initiative.id} link recorded for "${evidence.stage}": ${url}\n${nextStep(initiative, context.gate)}`
  },
})

define({
  tool: 'si_record', action: 'check', summary: 'run a verification command (tests, typecheck, lint, eval suite, data-quality check, health probe) and record the real result against the current stage — the only way a check counts',
  params: { id: ID, command: { type: 'string', description: 'the command; it is gated exactly like run_command', required: true }, summary: { type: 'string', description: 'what it checks' } },
  async run(input, context) {
    const id = assertInitiativeId(input.id)
    const initiative = context.store.read(id)
    mutable(initiative)
    const command = String(input.command).trim()
    if (!command) throw new Error('"command" must not be empty')
    const before = treeFingerprint(context.store.cwd)
    const outcome = await runVerification([command], context.store.cwd)
    if (outcome.blocked) throw new Error(`the command was not run: ${outcome.blocked}`)
    const result = outcome.results.find((candidate) => !candidate.command.startsWith('[skipped]')) ?? outcome.results[0]
    if (!result) throw new Error(outcome.inconclusive ?? 'nothing ran')
    const after = treeFingerprint(context.store.cwd)
    const noTests = isNoTestsResult(result)
    const passed = result.exitCode === 0 && !result.timedOut && !noTests
    const output = redactSecrets(`${result.stdout}\n${result.stderr}`.trim()).slice(-2500)
    const recorded = addEvidence(context, id, () => ({
      kind: 'check', command, summary: (input.summary as string | undefined) ?? command, exitCode: result.exitCode, passed, noTests, timedOut: result.timedOut, elapsedMs: result.elapsedMs, output, tree: after,
    }), passed ? 'check-pass' : 'check-fail')
    const note = before !== undefined && after !== before ? '\nNote: the command changed the working tree; the result is recorded against the tree as it is now.' : ''
    return `${passed ? 'PASS' : 'FAIL'} ${command} — exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${noTests ? ' (no tests ran — not a pass)' : ''}, ${(result.elapsedMs / 1000).toFixed(1)}s, recorded for "${recorded.evidence.stage}".${note}\n${output ? `--- output (tail) ---\n${output.slice(-1500)}\n---\n` : ''}${nextStep(recorded.initiative, context.gate)}`
  },
})

define({
  tool: 'si_record', action: 'commit', summary: 'record a commit, verified to exist in this repository',
  params: { id: ID, ref: { type: 'string', description: 'commit sha or ref (default HEAD)' } },
  run(input, context) {
    const commit = verifyCommit(context.store.cwd, (input.ref as string | undefined) ?? 'HEAD')
    const id = assertInitiativeId(input.id)
    const baseHead = context.store.read(id).baseHead
    const newCommit = !baseHead || !isAncestor(context.store.cwd, commit.sha, baseHead)
    const { initiative } = addEvidence(context, id, () => ({ kind: 'commit', sha: commit.sha, newCommit, summary: `${commit.subject} (${commit.author}, ${commit.date})` }), 'commit')
    return `${initiative.id} commit ${commit.sha.slice(0, 12)} recorded: ${commit.subject}${newCommit ? '' : ' — it was already in the history when this initiative began, so it is not evidence of a change made for it'}\n${nextStep(initiative, context.gate)}`
  },
})

define({
  tool: 'si_record', action: 'branch', summary: 'record the working branch, verified in git (the default branch does not count)',
  params: { id: ID, name: { type: 'string', description: 'branch name (default: the checked-out branch)' } },
  run(input, context) {
    const branch = verifyBranch(context.store.cwd, input.name as string | undefined)
    const { initiative } = addEvidence(context, assertInitiativeId(input.id), () => ({ kind: 'branch', branch: branch.name, sha: branch.head, isDefaultBranch: branch.isDefault, summary: `branch ${branch.name} at ${branch.head.slice(0, 12)}` }), 'branch')
    return `${initiative.id} branch ${branch.name}${branch.isDefault ? ' recorded — but it is the default branch, so it does not satisfy the branch gate' : ' recorded'}.\n${nextStep(initiative, context.gate)}`
  },
})

define({
  tool: 'si_record', action: 'review', summary: 'record a review verdict on the current code (or an artifact version). It counts toward a gate only when given by an independent reviewer worker — never by the author or the lead.',
  params: {
    id: ID,
    kind: { type: 'string', description: 'review kind', required: true, enum: REVIEW_KIND_IDS },
    verdict: { type: 'string', description: 'the verdict', required: true, enum: ['approve', 'changes-requested', 'reject'] },
    summary: { type: 'string', description: 'what was reviewed and the conclusion', required: true },
    findings: { type: 'string[]', description: 'concrete findings (required unless approving)' },
    hat: { type: 'string', description: 'the hat the reviewer wore (default: the kind\'s usual reviewer)', enum: ORG_ROLE_IDS },
    artifact: { type: 'string', description: 'review this artifact kind\'s latest version instead of the code (required for architecture, design, and research reviews)', enum: ARTIFACT_KINDS },
  },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const kind = input.kind as keyof typeof REVIEW_KINDS
    if (!isReviewKind(kind)) throw new Error('unknown review kind')
    const spec = REVIEW_KINDS[kind]
    const findings = ((input.findings as string[] | undefined) ?? []).map((finding) => finding.trim()).filter(Boolean).slice(0, 40)
    if (input.verdict !== 'approve' && !findings.length) throw new Error('a review that does not approve must list its findings')
    const initiative = context.store.read(id)
    let subject: { type: 'tree' | 'artifact' | 'untracked'; ref: string }
    if (input.artifact || spec.subject === 'artifact') {
      if (!input.artifact) throw new Error(`a ${kind} reviews a document — pass artifact (e.g. ${kind === 'research-review' ? 'experiment-results' : kind === 'design-review' ? 'ux-spec' : 'rfc or design-doc'})`)
      const latest = latestArtifact(initiative, input.artifact as string)
      if (!latest) throw new Error(`${id} has no ${String(input.artifact)} to review`)
      subject = { type: 'artifact', ref: `${latest.id}:${latest.sha256}` }
    } else {
      const tree = treeFingerprint(context.store.cwd)
      subject = tree ? { type: 'tree', ref: tree } : { type: 'untracked', ref: 'no-git' }
    }
    const by = context.by
    const independent = by.role === 'operator' || (by.role !== 'lead' && (spec.workers as readonly string[]).includes(by.role))
    const hat = (input.hat as keyof typeof ORG_ROLES | undefined) ?? spec.by
    const review = context.store.update(id, (record, journal) => {
      const stage = mutable(record)
      const entry = { id: newId('R'), kind, verdict: input.verdict as 'approve' | 'changes-requested' | 'reject', summary: text(input.summary, 'summary', 2000), findings, hat, by, independent, subject, stage: stage.id, at: new Date().toISOString() }
      record.reviews.push(entry)
      journal('review', `${kind} ${entry.verdict} by ${by.name}${independent ? '' : ' (self)'}`)
      return entry
    }, by)
    const after = context.store.read(id)
    const standing = independent ? '' : `\nThis is a self-review (${by.role}), so it does not satisfy the ${kind} gate. Delegate the review: task role:"${spec.workers[0]}" (si_work brief id:"${id}" role:"${spec.by}").`
    return `${id} ${kind} ${review.verdict} recorded (${review.subject.type === 'artifact' ? review.subject.ref.split(':')[0] : review.subject.type === 'tree' ? `code tree ${review.subject.ref.slice(0, 12)}` : 'not a git repository'}).${standing}\n${nextStep(after, context.gate)}`
  },
})

define({
  tool: 'si_record', action: 'decide', summary: 'record a decision (ADR-lite): what was decided, the alternatives, the consequences. Significant ones also deserve an adr artifact.',
  params: { id: ID, title: { type: 'string', description: 'decision title', required: true }, decision: { type: 'string', description: 'what was decided', required: true }, alternatives: { type: 'string[]', description: 'what else was considered', required: true }, consequences: { type: 'string', description: 'what becomes easier and harder', required: true } },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    const decision = context.store.update(id, (initiative, journal) => {
      const stage = mutable(initiative)
      const entry = { id: newId('D'), title: text(input.title, 'title', 200), decision: text(input.decision, 'decision', 2000), alternatives: (input.alternatives as string[]).map((value) => value.trim()).filter(Boolean), consequences: text(input.consequences, 'consequences', 2000), stage: stage.id, by: context.by, at: new Date().toISOString() }
      if (!entry.alternatives.length) throw new Error('name at least one alternative that was considered')
      initiative.decisions.push(entry)
      journal('decision', entry.title)
      return entry
    }, context.by)
    return `${id} decision ${decision.id} recorded: ${decision.title}.`
  },
})

const LEVELS = ['low', 'medium', 'high'] as const

define({
  tool: 'si_record', action: 'risk', summary: 'add a risk to the register, or update one (pass risk: its id)',
  params: {
    id: ID,
    risk: { type: 'string', description: 'existing risk id to update' },
    title: { type: 'string', description: 'the risk (required for a new one)' },
    likelihood: { type: 'string', description: 'likelihood', enum: LEVELS },
    impact: { type: 'string', description: 'impact', enum: LEVELS },
    mitigation: { type: 'string', description: 'how it is reduced' },
    owner: { type: 'string', description: 'owning hat', enum: ORG_ROLE_IDS },
    status: { type: 'string', description: 'status', enum: ['open', 'mitigated', 'accepted', 'closed'] },
  },
  run(input, context) {
    const id = assertInitiativeId(input.id)
    return context.store.update(id, (initiative, journal) => {
      mutable(initiative)
      const now = new Date().toISOString()
      if (input.risk) {
        const risk = initiative.risks.find((candidate) => candidate.id === input.risk)
        if (!risk) throw new Error(`${id} has no risk ${String(input.risk)}`)
        if (input.status === 'accepted') throw new Error('accepting a risk is the person\'s decision — si_record signoff gate:"accept-risk"')
        if (input.title) risk.title = text(input.title, 'title', 300)
        if (input.likelihood) risk.likelihood = input.likelihood as Level
        if (input.impact) risk.impact = input.impact as Level
        if (input.mitigation) risk.mitigation = text(input.mitigation, 'mitigation', 1000)
        if (input.owner) risk.owner = input.owner as OrgRoleId
        if (input.status) risk.status = input.status as never
        risk.updatedAt = now
        journal('risk', `${risk.id} ${risk.status}`)
        return `${id} risk ${risk.id} updated: ${risk.title} [${risk.likelihood}/${risk.impact}, ${risk.status}].`
      }
      if (!input.title || !input.likelihood || !input.impact || !input.mitigation || !input.owner) throw new Error('a new risk needs title, likelihood, impact, mitigation, and owner')
      if (input.status === 'accepted') throw new Error('accepting a risk is the person\'s decision — si_record signoff gate:"accept-risk"')
      const risk = { id: newId('K'), title: text(input.title, 'title', 300), likelihood: input.likelihood as Level, impact: input.impact as Level, mitigation: text(input.mitigation, 'mitigation', 1000), owner: input.owner as OrgRoleId, status: ((input.status as string | undefined) ?? 'open') as 'open', by: context.by, at: now, updatedAt: now }
      initiative.risks.push(risk)
      journal('risk', `${risk.id} ${risk.title}`)
      return `${id} risk ${risk.id} added: ${risk.title} [${risk.likelihood}/${risk.impact}] — owner ${ORG_ROLES[risk.owner].title}.`
    }, context.by)
  },
})

/**
 * Records a sign-off. Reaching `run` means a person approved it: the governor classes
 * every si_record signoff as critical, so it is asked at the terminal (never remembered
 * across different gates) and refused outright when nobody is there to ask.
 */
export function recordSignoff(context: EngineContext, id: string, gate: string, summary: string, via: 'governor-approval' | 'operator-cli'): string {
  if (!isSignoffGate(gate)) throw new Error(`gate must be one of ${SIGNOFF_GATE_IDS.join(', ')}`)
  const initiative = context.store.read(id)
  const stage = mutable(initiative)
  const required = stage.requirements.some((requirement) => requirement.type === 'signoff' && requirement.gate === gate)
  const riskFollowups = gate === 'accept-risk' && stage.requirements.some((requirement) => requirement.type === 'followups')
  if (!required && !riskFollowups && gate !== 'accept-risk') throw new Error(`"${stage.id}" does not call for a ${gate} sign-off. It needs: ${stage.requirements.map((requirement) => requirement.type === 'signoff' ? `${requirement.gate} sign-off` : requirement.type).join(', ')}`)
  const others = evaluateStage(initiative, stage, context.gate).filter((status) => !status.met && status.requirement.type !== 'signoff' && status.requirement.type !== 'followups')
  if (others.length && gate !== 'accept-risk') throw new Error(`not ready for the ${gate} sign-off — finish the rest of "${stage.id}" first:\n${renderGate(others)}`)
  const tree = treeFingerprint(context.store.cwd)
  const { initiative: after } = addEvidence(context, id, () => ({ kind: 'signoff', gate, via, tree, summary: `${SIGNOFF_GATES[gate]} — ${summary}`.slice(0, 1000) }), 'signoff')
  if (gate === 'accept-risk') {
    context.store.update(id, (record) => {
      for (const risk of record.risks) if (risk.status === 'open') { risk.status = 'accepted'; risk.updatedAt = new Date().toISOString() }
    }, context.by)
  }
  return `${id} ${gate} sign-off recorded (${via}).\n${nextStep(after, context.gate)}`
}

define({
  tool: 'si_record', action: 'signoff', summary: 'ask the person for a sign-off only they can give (direction, release, production, accept-risk). The governor always asks them; the engine records it only if they approve and the rest of the stage is already met.',
  params: { id: ID, gate: { type: 'string', description: 'which decision', required: true, enum: SIGNOFF_GATE_IDS }, summary: { type: 'string', description: 'exactly what the person is approving, in one or two sentences', required: true } },
  run: (input, context) => recordSignoff(context, assertInitiativeId(input.id), input.gate as string, text(input.summary, 'summary', 800), context.by.role === 'operator' ? 'operator-cli' : 'governor-approval'),
})

/** For `elia si`: operator actions carry the operator identity, not an agent's. */
export function operatorContext(cwd?: string): EngineContext {
  const store = new SysintelStore(cwd)
  return { store, by: OPERATOR, gate: gateContext(store) }
}

