import { ZERO_USAGE, addUsage, recordUsage } from '../usage.ts'
import type { Usage } from '../providers/types.ts'
import { runAgentLoop, lastAssistantText, type ConversationMessage } from '../agentLoop.ts'
import { allWorkerTools, getSynthesizedTools } from '../tools/registry.ts'
import { taskTool } from '../tools/task.ts'
import { autoFallbacksFor, tierConfig } from '../config.ts'
import { endTextTurn, writeText, writeNotice } from '../ui/stream.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import type { AgentPersona } from './types.ts'
import { parseOverride, classifyRequest, deterministicRoute } from './router.ts'
import { personaPrompt, personaTools } from './personas.ts'
import { capabilityForPersona } from '../capabilities.ts'

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
  dryRun?: boolean
}

function toolsForPersona(persona: AgentPersona, selectedSkillNames?: string[]) {
  const selected = new Set(selectedSkillNames ?? [])
  const synthesized = new Set(getSynthesizedTools().map((tool) => tool.name))
  const filterSkills = (tools: ReturnType<typeof allWorkerTools>) => tools.filter((tool) => selectedSkillNames === undefined || !synthesized.has(tool.name) || selected.has(tool.name))
  return persona === 'tech' || persona === 'production' ? [...filterSkills(allWorkerTools()), taskTool] : personaTools(persona, selectedSkillNames)
}

const PARALLEL_READ_TOOLS = new Set(['environment', 'read_file', 'list_files', 'grep', 'web_search', 'web_fetch', 'read_spreadsheet', 'data_science', 'finance'])

/**
 * Domain specialists do focused work with scoped toolsets; Tech and Production
 * keep the full worker set plus task delegation. A bounded budget keeps a stuck specialist
 * from burning tokens for minutes while still allowing multi-step analysis.
 */
function maxStepsForPersona(persona: AgentPersona): number | undefined {
  return persona === 'tech' ? undefined : 30
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Runs one persona with context from completed dependency waves. */
async function runSection(
  persona: AgentPersona,
  request: string,
  priorSections: AgentSectionResult[],
  signal?: AbortSignal,
  selectedSkillNames?: string[],
  streamOutput = true,
  readOnly = false,
): Promise<{ section: AgentSectionResult; usage: Usage }> {
  const handoff = priorSections.length > 0
    ? `\n\n## What completed dependency waves found\n${priorSections.map((section) => `### ${capitalize(section.persona)}\n${section.report}`).join('\n\n')}`
    : ''
  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: `${request}${handoff}` }] }]
  const capability = capabilityForPersona(persona)
  const contract = capability
    ? `\n\n## Capability contract\nRisk class: ${capability.risk}.\nRequired output elements: ${capability.outputContract.join('; ')}.\nPreferred tools: ${capability.preferredTools.join(', ')}.\nDo not claim completion until the required elements are addressed or explicitly marked unavailable.`
    : ''

  const route = tierConfig(readOnly ? 'fast' : 'deep')
  const tools = toolsForPersona(persona, selectedSkillNames)
  const result = await runAgentLoop({
    messages,
    systemPrompt: `${personaPrompt(persona)}${contract}${readOnly ? '\n\nThis is a parallel investigation wave. Read and analyze only; do not modify files, run commands, use a browser, communicate externally, or create artifacts. A dependent wave will integrate your report.' : ''}`,
    tools: readOnly ? tools.filter((tool) => PARALLEL_READ_TOOLS.has(tool.name)) : tools,
    provider: route.provider,
    providerName: route.providerName,
    model: route.model,
    fallbacks: autoFallbacksFor(route.providerName),
    onText: streamOutput ? writeText : undefined,
    useAnimation: streamOutput,
    verbose: streamOutput,
    maxSteps: maxStepsForPersona(persona),
    signal,
  })

  return { section: { persona, report: lastAssistantText(messages, '(no response)') }, usage: result.usage }
}

/**
 * Deep-tier pass that reconciles what each persona produced into one
 * recommendation, surfacing conflicts instead of silently picking a side — per
 * the orchestrator's handoff rules.
 */
async function synthesize(request: string, sections: AgentSectionResult[]): Promise<{ text: string; usage: Usage }> {
  const deep = tierConfig('deep')
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
    provider: deep.provider,
    providerName: deep.providerName,
    model: deep.model,
    fallbacks: autoFallbacksFor(deep.providerName),
    useAnimation: false,
    verbose: false,
  })

  return { text: lastAssistantText(messages, '(no response)'), usage: result.usage }
}

const SEARCH_TOOL_PERSONAS: AgentPersona[] = ['marketing', 'sports', 'fitness', 'finance', 'business', 'data', 'research', 'automation', 'communications', 'ai', 'cyber']
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
 * Routes a request to one or more specialist personas. Independent specialist
 * sections run in parallel; the combined recommendation waits for the whole
 * wave. A single persona answers directly in that persona's voice.
 */
export async function runAgentRequest(request: string, opts: { signal?: AbortSignal; skillNames?: string[]; dryRun?: boolean } = {}): Promise<AgentRunResult> {
  const override = parseOverride(request)
  let usage = ZERO_USAGE

  let personas: AgentPersona[]
  let rationale: string
  let routeWaves: AgentPersona[][] | undefined
  if (override) {
    personas = [override]
    rationale = 'explicit override in the request'
    routeWaves = [[override]]
  } else if (opts.dryRun) {
    const route = deterministicRoute(request)
    personas = route.personas
    rationale = route.rationale
    routeWaves = route.waves
  } else {
    const route = await classifyRequest(request)
    personas = route.personas
    rationale = route.rationale
    routeWaves = route.waves
    usage = addUsage(usage, route.usage)
    recordUsage(route.usage)
  }

  warnIfSearchUnconfigured(personas)

  if (opts.dryRun) return { personas, rationale, sections: [], usage, dryRun: true }

  // A lone 'tech' route is just "this is a coding/build request" with no other
  // specialist domain involved — hand it straight to the real dev-mode agent
  // (agent.ts) instead of running the lighter orchestrator section, so it gets
  // the action governor, tool-result cache/prefetcher, and task/preview tools
  // dev mode normally has. Multi-domain routes still run 'tech' as a bounded
  // section below, since composing several specialists' takes is what the
  // section runner is for.
  if (personas.length === 1 && personas[0] === 'tech') {
    const { runTurn } = await import('../agent.ts')
    const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: request }] }]
    const result = await runTurn(messages, { mode: 'dev', signal: opts.signal, skipStats: true })
    usage = addUsage(usage, result.usage)
    recordUsage(result.usage)
    return { personas, rationale, sections: [{ persona: 'tech', report: lastAssistantText(messages, '(no response)') }], usage }
  }

  const multiPersona = personas.length > 1
  const executionWaves = routeWaves ?? personas.map((persona) => [persona])
  const sections: AgentSectionResult[] = []
  for (const [waveIndex, wave] of executionWaves.entries()) {
    if (opts.signal?.aborted) break
    const priorSections = [...sections]
    const parallel = wave.length > 1
    for (const persona of wave) if (multiPersona && machineReadable) emitEvent('persona_started', { persona, wave: waveIndex + 1, providerTier: parallel ? 'fast' : 'deep' })
    const sectionRuns = await Promise.all(wave.map(async (persona) => {
      try {
        return await runSection(persona, request, priorSections, opts.signal, opts.skillNames, !multiPersona, parallel)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        writeNotice(`${capitalize(persona)} agent failed: ${message}`)
        return { section: { persona, report: `(this agent failed: ${message})`, failed: true }, usage: ZERO_USAGE }
      }
    }))
    for (const { section, usage: sectionUsage } of sectionRuns) {
      sections.push(section)
      usage = addUsage(usage, sectionUsage)
      recordUsage(sectionUsage)
      if (multiPersona) {
        if (machineReadable) emitEvent('persona_completed', { persona: section.persona, report: section.report, failed: section.failed ?? false, wave: waveIndex + 1 })
        else {
          process.stdout.write(`\n## ${capitalize(section.persona)} take\n\n`)
          writeText(section.report)
          endTextTurn()
        }
      }
    }
  }

  let combined: string | undefined
  if (sections.length > 1) {
    const synthesis = await synthesize(request, sections)
    combined = synthesis.text
    usage = addUsage(usage, synthesis.usage)
    recordUsage(synthesis.usage)
    if (machineReadable) emitEvent('combined_recommendation', { text: combined })
    else process.stdout.write(`\n## Combined recommendation\n\n${combined}\n`)
  }

  return { personas, rationale, sections, combined, usage }
}

/**
 * Forces a single persona for one turn of an ongoing conversation (REPL
 * persona commands, mutating `messages` in place like agent.ts's
 * runTurn — used when the user has explicitly picked a persona for the rest
 * of the session, so the router never runs.
 */
export async function runPersonaTurn(
  messages: ConversationMessage[],
  persona: AgentPersona,
  selectedSkillNames?: string[],
  signal?: AbortSignal,
): Promise<Usage> {
  if (persona === 'tech') {
    const { runTurn } = await import('../agent.ts')
    const result = await runTurn(messages, { mode: 'dev', skillNames: selectedSkillNames, signal, skipStats: true })
    recordUsage(result.usage)
    return result.usage
  }
  warnIfSearchUnconfigured([persona])
  const result = await runAgentLoop({
    messages,
    systemPrompt: personaPrompt(persona),
    tools: toolsForPersona(persona, selectedSkillNames),
    onText: writeText,
    useAnimation: true,
    verbose: true,
    maxSteps: maxStepsForPersona(persona),
    signal,
  })
  recordUsage(result.usage)
  return result.usage
}
