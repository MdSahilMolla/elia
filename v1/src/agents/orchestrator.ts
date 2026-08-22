import { ZERO_USAGE, addUsage, recordUsage } from '../usage.ts'
import type { Usage } from '../providers/types.ts'
import { runAgentLoop, lastAssistantText, type ConversationMessage } from '../agentLoop.ts'
import { allWorkerTools } from '../tools/registry.ts'
import { taskTool } from '../tools/task.ts'
import { autoFallbacksFor, tierConfig } from '../config.ts'
import { writeText, writeNotice } from '../ui/stream.ts'
import type { AgentPersona } from './types.ts'
import { parseOverride, classifyRequest } from './router.ts'
import { personaPrompt, personaTools } from './personas.ts'

export interface AgentSectionResult {
  persona: AgentPersona
  report: string
  /** True when this persona's turn threw and the report below is a degraded fallback, not real output. */
  failed?: boolean
}

export interface AgentRunResult {
  personas: AgentPersona[]
  rationale: string
  sections: AgentSectionResult[]
  combined?: string
  usage: Usage
}

function toolsForPersona(persona: AgentPersona) {
  return persona === 'tech' ? [...allWorkerTools(), taskTool] : personaTools(persona)
}

/**
 * Marketing and Finance do focused, mostly single-pass creative/analytical
 * work with a small toolset (no run_command, no task) — the coding fleet's
 * 80-step default is sized for open-ended engineering work they never do, so
 * a much smaller budget keeps a stuck run from burning tokens for minutes.
 * Tech keeps elia's normal budget since it uses elia's normal toolset.
 */
function maxStepsForPersona(persona: AgentPersona): number | undefined {
  return persona === 'tech' ? undefined : 30
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Runs one persona's turn, given everything prior personas in this request already found. */
async function runSection(
  persona: AgentPersona,
  request: string,
  priorSections: AgentSectionResult[],
  signal?: AbortSignal,
): Promise<{ section: AgentSectionResult; usage: Usage }> {
  const handoff =
    priorSections.length > 0
      ? `\n\n## What the other agent(s) already found\n${priorSections.map((s) => `### ${capitalize(s.persona)}\n${s.report}`).join('\n\n')}`
      : ''

  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: `${request}${handoff}` }] }]

  const result = await runAgentLoop({
    messages,
    systemPrompt: personaPrompt(persona),
    tools: toolsForPersona(persona),
    onText: writeText,
    useAnimation: true,
    verbose: true,
    maxSteps: maxStepsForPersona(persona),
    signal,
  })

  return { section: { persona, report: lastAssistantText(messages, '(no response)') }, usage: result.usage }
}

/**
 * Cheap fast-tier pass that reconciles what each persona produced into one
 * recommendation, surfacing conflicts instead of silently picking a side — per
 * the orchestrator's handoff rules.
 */
async function synthesize(request: string, sections: AgentSectionResult[]): Promise<{ text: string; usage: Usage }> {
  const fast = tierConfig('fast')
  const messages: ConversationMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Original request:\n${request}\n\n${sections.map((s) => `## ${capitalize(s.persona)} take\n${s.report}`).join('\n\n')}\n\nWrite a short combined recommendation (2-5 sentences). If the agents' recommendations conflict, say so explicitly instead of silently picking one.`,
        },
      ],
    },
  ]

  const result = await runAgentLoop({
    messages,
    systemPrompt: 'You reconcile the outputs of specialist agents into one short, direct recommendation for the user.',
    tools: [],
    provider: fast.provider,
    providerName: fast.providerName,
    model: fast.model,
    fallbacks: autoFallbacksFor(fast.providerName),
    useAnimation: false,
    verbose: false,
  })

  return { text: lastAssistantText(messages, '(no response)'), usage: result.usage }
}

const SEARCH_TOOL_PERSONAS: AgentPersona[] = ['marketing', 'finance']
const warnedPersonas = new Set<AgentPersona>()

/**
 * One-time-per-persona-per-process heads-up, not a hard stop — the persona
 * still runs and can fall back to asking for real numbers or a placeholder.
 * Deduplicated so a REPL session forced into /marketing doesn't repeat this
 * on every turn.
 */
function warnIfSearchUnconfigured(personas: AgentPersona[]): void {
  if (process.env.ELIA_SEARCH_API_KEY) return
  const unwarned = personas.filter((persona) => SEARCH_TOOL_PERSONAS.includes(persona) && !warnedPersonas.has(persona))
  if (unwarned.length === 0) return
  for (const persona of unwarned) warnedPersonas.add(persona)
  writeNotice(
    'ELIA_SEARCH_API_KEY is not set — web_search/web_fetch will fail if this agent tries to use them. See .env.example.',
  )
}

/**
 * Routes a request to Marketing, Finance, and/or Tech and runs each in
 * sequence, carrying context forward so later agents don't repeat earlier
 * ones' work. A single persona just answers in that persona's voice — the
 * routing stays invisible, per the orchestrator's own rule not to expose it
 * unless asked. More than one persona gets "## X take" headers plus a
 * combined recommendation.
 */
export async function runAgentRequest(request: string, opts: { signal?: AbortSignal } = {}): Promise<AgentRunResult> {
  const override = parseOverride(request)
  let usage = ZERO_USAGE

  let personas: AgentPersona[]
  let rationale: string
  if (override) {
    personas = [override]
    rationale = 'explicit override in the request'
  } else {
    const route = await classifyRequest(request)
    personas = route.personas
    rationale = route.rationale
    usage = addUsage(usage, route.usage)
    recordUsage(route.usage)
  }

  warnIfSearchUnconfigured(personas)

  const sections: AgentSectionResult[] = []

  for (const persona of personas) {
    if (opts.signal?.aborted) break
    if (personas.length > 1) process.stdout.write(`\n## ${capitalize(persona)} take\n\n`)

    // One persona's turn failing (a provider error, a tool crash) shouldn't take
    // down a multi-domain request that's otherwise fine — report the failure as
    // that section's content and let the remaining personas still run.
    try {
      const { section, usage: sectionUsage } = await runSection(persona, request, sections, opts.signal)
      sections.push(section)
      usage = addUsage(usage, sectionUsage)
      recordUsage(sectionUsage)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      writeNotice(`${capitalize(persona)} agent failed: ${message}`)
      sections.push({ persona, report: `(this agent failed: ${message})`, failed: true })
    }
  }

  let combined: string | undefined
  if (sections.length > 1) {
    const synthesis = await synthesize(request, sections)
    combined = synthesis.text
    usage = addUsage(usage, synthesis.usage)
    recordUsage(synthesis.usage)
    process.stdout.write(`\n## Combined recommendation\n\n${combined}\n`)
  }

  return { personas, rationale, sections, combined, usage }
}

/**
 * Forces a single persona for one turn of an ongoing conversation (REPL
 * /marketing, /finance, /tech), mutating `messages` in place like agent.ts's
 * runTurn — used when the user has explicitly picked a persona for the rest
 * of the session, so the router never runs.
 */
export async function runPersonaTurn(messages: ConversationMessage[], persona: AgentPersona): Promise<Usage> {
  warnIfSearchUnconfigured([persona])
  const result = await runAgentLoop({
    messages,
    systemPrompt: personaPrompt(persona),
    tools: toolsForPersona(persona),
    onText: writeText,
    useAnimation: true,
    verbose: true,
    maxSteps: maxStepsForPersona(persona),
  })
  recordUsage(result.usage)
  return result.usage
}
