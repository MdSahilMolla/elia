import { runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { roleConfig } from '../config.ts'
import type { Tool } from '../tools/types.ts'
import { ROLE_NAMES, type RoleName } from '../autonomy/types.ts'
import { role as roleDefinition } from '../autonomy/roles.ts'
import type { DistillableTrace } from './corpus.ts'
import { clusterByDominantRole } from './corpus.ts'

/**
 * Turns a cluster of verified-successful traces into a candidate standing
 * instruction for the role that did the work.
 *
 * Deliberately narrow for v1: the only output is a short prompt fragment for a
 * role. It runs on the fast tier — this is summarisation over material already
 * in hand, not fresh reasoning — and every candidate it produces still has to
 * clear the gate before it changes anything.
 */

export interface DistillationCandidate {
  role: RoleName
  /** One imperative sentence, written as a standing instruction to that role. */
  fragment: string
  /** Why the traces support it. */
  rationale: string
  /** Run ids it was drawn from. */
  sourceRunIds: string[]
}

export interface MineOptions {
  /** Minimum cluster size before a role is worth distilling for. */
  minCluster?: number
  signal?: AbortSignal
}

export async function proposeDistillations(traces: DistillableTrace[], options: MineOptions = {}): Promise<DistillationCandidate[]> {
  const minCluster = options.minCluster ?? 3
  const clusters = clusterByDominantRole(traces)
  const candidates: DistillationCandidate[] = []

  for (const [role, clusterTraces] of clusters) {
    if (clusterTraces.length < minCluster) continue
    if (!ROLE_NAMES.includes(role)) continue
    const candidate = await mineOne(role, clusterTraces, options.signal)
    if (candidate) candidates.push(candidate)
  }

  return candidates
}

async function mineOne(role: RoleName, traces: DistillableTrace[], signal?: AbortSignal): Promise<DistillationCandidate | undefined> {
  const capture = createCaptureTool()
  const tier = roleConfig('scribe', 'fast')

  const brief = `You are looking at ${traces.length} autonomous runs on this project where the \`${role}\` worker did the bulk of the work and the run finished with verification and review both passing.

Current standing instructions for the \`${role}\` role:
"""
${roleDefinition(role).prompt}
"""

The runs:
${traces
  .map(
    (t, i) =>
      `${i + 1}. goal: ${t.goal}\n   files: ${[...new Set(t.steps.flatMap((s) => s.files))].slice(0, 8).join(', ') || '(unrecorded)'}\n   verified with: ${t.verification.join(' && ') || '(project checks)'}\n   lessons noted: ${t.lessons.join(' | ') || '(none)'}`,
  )
  .join('\n')}

If — and only if — these runs show the \`${role}\` worker repeatedly having to work out the same non-obvious thing that the current instructions do not already tell it, propose ONE sentence to add to its instructions so a future run starts with it. It must be:
- a durable working habit for this project, not a fact about one run's code
- not already implied by the current instructions
- concrete enough to act on

If the runs do not show a clear repeated pattern, submit nothing. A weak or padded fragment makes every future run worse. Call submit_fragment exactly once, or do not call it at all.`

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: brief }] }]
  try {
    await runAgentLoop({
      messages,
      systemPrompt: 'You distill durable working habits from a project\'s successful run history. You are conservative: most of the time the right answer is to propose nothing.',
      tools: [capture.tool],
      onText: () => {},
      useAnimation: false,
      verbose: false,
      provider: tier.provider,
      providerName: tier.providerName,
      model: tier.model,
      maxSteps: 3,
      signal,
    })
  } catch {
    return undefined
  }

  const taken = capture.taken()
  if (!taken) return undefined
  return { role, fragment: taken.fragment, rationale: taken.rationale, sourceRunIds: traces.map((t) => t.runId) }
}

function createCaptureTool(): { tool: Tool; taken(): { fragment: string; rationale: string } | undefined } {
  let captured: { fragment: string; rationale: string } | undefined
  const tool: Tool = {
    name: 'submit_fragment',
    description:
      'Submit the single sentence to add to this role\'s standing instructions, with the pattern in the run history that justifies it. Call at most once; not calling it is a valid outcome.',
    input_schema: {
      type: 'object',
      properties: {
        fragment: { type: 'string', description: 'One imperative sentence, a standing instruction to the role' },
        rationale: { type: 'string', description: 'The repeated pattern across the runs that supports it' },
      },
      required: ['fragment', 'rationale'],
    },
    async execute(input) {
      const fragment = typeof input.fragment === 'string' ? input.fragment.replace(/\s+/g, ' ').trim() : ''
      const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : ''
      if (fragment.length < 12 || fragment.length > 400) throw new Error('fragment must be one concrete sentence (12–400 chars)')
      captured = { fragment, rationale }
      return 'Fragment recorded.'
    },
  }
  return { tool, taken: () => { const c = captured; captured = undefined; return c } }
}
