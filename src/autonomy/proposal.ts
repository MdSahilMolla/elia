import type { Tool } from '../tools/types.ts'
import { isRoleName, ROLE_NAMES, type Proposal, type ProposalStep } from './types.ts'
import { fileCollisions, planWaves } from './fleet.ts'
import { bold, dim, cyan, red, gold } from '../ui/theme.ts'
import { box, wrapText } from '../ui/layout.ts'

/**
 * Turns whatever the model produced into a validated proposal, or an explanation
 * of what was wrong with it.
 *
 * Models get plan structure *almost* right — a missing dependsOn, a role that
 * isn't real, a step id referenced before it exists. Repairing that here is much
 * better than either crashing or handing the executor a plan whose dependency
 * graph is a lie, so anything recoverable is coerced and anything that would
 * change the meaning of the plan is rejected with a message the model can act on.
 */
export function parseProposal(raw: unknown): { proposal: Proposal } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'proposal must be an object' }
  const input = raw as Record<string, unknown>

  const goal = asString(input.goal)
  if (!goal) return { error: 'proposal.goal is required' }

  const rawSteps = Array.isArray(input.steps) ? input.steps : []
  if (rawSteps.length === 0) return { error: 'proposal.steps must contain at least one step' }

  const steps: ProposalStep[] = []
  for (const [index, rawStep] of rawSteps.entries()) {
    if (typeof rawStep !== 'object' || rawStep === null) {
      return { error: `proposal.steps[${index}] must be an object` }
    }
    const step = rawStep as Record<string, unknown>

    const title = asString(step.title)
    const instructions = asString(step.instructions)
    if (!title) return { error: `proposal.steps[${index}].title is required` }
    if (!instructions) return { error: `proposal.steps[${index}].instructions is required` }

    steps.push({
      id: asString(step.id) ?? `s${index + 1}`,
      title,
      instructions,
      role: isRoleName(step.role) ? step.role : 'builder',
      files: uniqueStrings(asStringArray(step.files)),
      dependsOn: uniqueStrings(asStringArray(step.dependsOn)),
    })
  }

  const ids = new Set(steps.map((step) => step.id))
  if (ids.size !== steps.length) return { error: 'proposal step ids must be unique' }

  // A dependency on a step that does not exist would silently become "no
  // dependency" during wave planning, quietly parallelising work the model
  // deliberately ordered. Surface it instead.
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) return { error: `step "${step.id}" cannot depend on itself` }
      if (!ids.has(dependency)) {
        return { error: `step "${step.id}" depends on unknown step "${dependency}"` }
      }
    }
  }

  const { unreachable } = planWaves(steps)
  if (unreachable.length > 0) {
    return {
      error: `steps ${unreachable.map((step) => `"${step.id}"`).join(', ')} form a dependency cycle`,
    }
  }

  // A plan with nothing to check against is the one failure mode that costs the
  // most: the work runs, the gate silently has nothing to run, and "done" means
  // only that the workers stopped. Weaker models omit this field even though the
  // schema requires it, so it is enforced here rather than assumed.
  const verification = asStringArray(input.verification)
  if (verification.length === 0) {
    return {
      error:
        'proposal.verification needs at least one shell command that will actually fail if the work is wrong. Look one up in this project (package.json scripts, its README, its CI config). If it genuinely has no test or build command, give the most specific check you can run instead',
    }
  }

  return {
    proposal: {
      goal,
      understanding: asString(input.understanding) ?? '',
      assumptions: asStringArray(input.assumptions),
      steps,
      risks: asStringArray(input.risks),
      verification,
      outOfScope: asStringArray(input.outOfScope),
      acceptanceCriteria: asStringArray(input.acceptanceCriteria),
      sideEffects: asStringArray(input.sideEffects),
      recovery: asStringArray(input.recovery),
    },
  }
}

export interface ProposalCapture {
  tool: Tool
  /** Returns the captured proposal and clears it, so a retry can't reuse a stale one. */
  taken(): Proposal | undefined
}

/**
 * Built per run rather than shared, so two planners (an `elia auto` run and the
 * evolution engine, say) can never capture into the same slot.
 */
export function createProposalTool(): ProposalCapture {
  let captured: Proposal | undefined

  const tool: Tool = {
    name: 'submit_proposal',
    description: `Submit your plan for the user to approve. Call this exactly once, after you have finished investigating and know what you are actually going to do. Do not call it with placeholder content — every step's instructions must be complete enough for a worker who has never seen this conversation to execute it alone.

Break the work into the smallest number of steps that are genuinely separable, and use dependsOn only where a step truly cannot start until another finishes — steps with no unmet dependencies run in parallel, so unnecessary dependencies directly cost wall-clock time. List the files each step will touch so collisions between parallel steps can be caught before they happen.`,
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'One sentence: what will be true when this is done' },
        understanding: {
          type: 'string',
          description:
            'What you now believe about this codebase that is relevant to the task — the specific files, patterns, and constraints you found. Be concrete; this is what the user checks first.',
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Decisions you made where the request was ambiguous, so the user can correct them cheaply',
        },
        steps: {
          type: 'array',
          description: 'The work, decomposed for parallel execution',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short unique id, e.g. "s1"' },
              title: { type: 'string', description: 'Short label for the step' },
              role: {
                type: 'string',
                enum: ROLE_NAMES,
                description: 'Which kind of worker should do it',
              },
              instructions: {
                type: 'string',
                description: 'Complete, self-contained instructions — the worker sees only this',
              },
              files: { type: 'array', items: { type: 'string' }, description: 'Files this step expects to touch' },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Step ids that must finish first' },
            },
            required: ['title', 'instructions'],
          },
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description: 'What could go wrong, and what you will do about it',
        },
        verification: {
          type: 'array',
          items: { type: 'string' },
          description: 'Shell commands that must all pass for this to count as done, e.g. "bun test"',
        },
        outOfScope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Related things you are deliberately not doing',
        },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Observable conditions and evidence required for completion' },
        sideEffects: { type: 'array', items: { type: 'string' }, description: 'External or irreversible effects identified in this plan' },
        recovery: { type: 'array', items: { type: 'string' }, description: 'What to do when a dependency, credential, environment, or approval blocks progress' },
      },
      required: ['goal', 'understanding', 'steps', 'verification'],
    },
    async execute(input) {
      const parsed = parseProposal(input)
      if ('error' in parsed) {
        // Thrown, not returned, so the model sees it as a tool error and retries.
        throw new Error(`Proposal rejected: ${parsed.error}. Fix it and call submit_proposal again.`)
      }
      captured = parsed.proposal
      return 'Proposal recorded. Stop here — do not start the work; the user reviews it first.'
    },
  }

  return {
    tool,
    taken() {
      const proposal = captured
      captured = undefined
      return proposal
    },
  }
}

/** Renders a proposal for the terminal, including the parallelism it implies. */
export function renderProposal(proposal: Proposal): string {
  const lines: string[] = []
  const { waves } = planWaves(proposal.steps)

  lines.push(dim('nothing has been changed yet'))
  lines.push('')
  lines.push(`${bold('Goal')}  ${proposal.goal}`)

  if (proposal.understanding) {
    lines.push('')
    lines.push(bold('What I found'))
    for (const line of wrapText(proposal.understanding, 84)) lines.push(`  ${line}`)
  }

  const stepsWithoutOwnership = proposal.steps.filter((step) => step.files.length === 0).length
  if (stepsWithoutOwnership > 0) {
    lines.push(`${red('!')} ${stepsWithoutOwnership} step${stepsWithoutOwnership === 1 ? '' : 's'} declare no file ownership; collision detection is limited`)
  }

  if (proposal.assumptions.length > 0) {
    lines.push('')
    lines.push(`${bold('Assuming')} ${dim("(correct me and I'll replan)")}`)
    for (const assumption of proposal.assumptions) lines.push(`  ${dim('·')} ${assumption}`)
  }

  lines.push('')
  const workerCount = proposal.steps.length
  const waveWord = waves.length === 1 ? 'wave' : 'waves'
  lines.push(
    `${bold('Plan')} ${dim(`— ${workerCount} ${workerCount === 1 ? 'worker' : 'workers'} in ${waves.length} ${waveWord}`)}`,
  )
  for (const [index, wave] of waves.entries()) {
    const parallelNote = wave.length > 1 ? ` ${dim(`(${wave.length} in parallel)`)}` : ''
    lines.push(`  ${dim(`wave ${index + 1}`)}${parallelNote}`)
    for (const step of wave) {
      lines.push(`    ${cyan(step.role.padEnd(8))} ${step.id}  ${step.title}`)
      if (step.files.length > 0) lines.push(`             ${dim(step.files.join(', '))}`)
    }

    for (const collision of fileCollisions(wave)) {
      lines.push(`    ${red('!')} ${collision.file} is claimed by ${collision.steps.join(' and ')} in the same wave`)
    }
  }

  if (proposal.acceptanceCriteria?.length) {
    lines.push('')
    lines.push(bold('Acceptance'))
    for (const criterion of proposal.acceptanceCriteria) lines.push(`  ${dim('·')} ${criterion}`)
  }

  if (proposal.sideEffects?.length) {
    lines.push('')
    lines.push(bold('Side effects'))
    for (const effect of proposal.sideEffects) lines.push(`  ${dim('·')} ${effect}`)
  }

  if (proposal.risks.length > 0) {
    lines.push('')
    lines.push(bold('Risks'))
    for (const risk of proposal.risks) lines.push(`  ${dim('·')} ${risk}`)
  }

  lines.push('')
  lines.push(bold('Done when'))
  for (const command of proposal.verification) lines.push(`  ${dim('$')} ${command}`)
  if (proposal.verification.length === 0) lines.push(`  ${dim('(no verification commands given)')}`)

  if (proposal.outOfScope.length > 0) {
    lines.push('')
    lines.push(bold('Not doing'))
    for (const item of proposal.outOfScope) lines.push(`  ${dim('·')} ${item}`)
  }

  return `\n${box(lines, { title: 'Proposal', borderColor: gold })}\n`
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}
