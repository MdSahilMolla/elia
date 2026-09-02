import type { Tool } from '../tools/types.ts'
import type { ConversationMessage } from '../agentLoop.ts'
import type { Usage } from '../providers/types.ts'
import { AGENT_PERSONAS, isAgentPersona, type AgentPersona, type AgentRoute } from './types.ts'
import { detectCapabilities } from '../capabilities.ts'

const OVERRIDE_PATTERNS: { pattern: RegExp; persona: AgentPersona }[] = [
  { pattern: /\bas the marketing agent\b|\bmarketing take\b/i, persona: 'marketing' },
  { pattern: /\bas the sports agent\b|\bsports take\b|\bas the sports analyst\b/i, persona: 'sports' },
  { pattern: /\bas the fitness agent\b|\bfitness take\b|\bas the fitness coach\b/i, persona: 'fitness' },
  { pattern: /\bas the finance agent\b|\bfinance take\b/i, persona: 'finance' },
  { pattern: /\bas the business analyst\b|\bbusiness analysis take\b|\bbusiness analyst take\b/i, persona: 'business' },
  { pattern: /\bas the data analyst\b|\bdata analysis take\b|\bdata analyst take\b/i, persona: 'data' },
  { pattern: /\bas the research agent\b|\bresearch take\b/i, persona: 'research' },
  { pattern: /\bas the cybersecurity agent\b|\bas the cyber agent\b|\bcybersecurity take\b/i, persona: 'cyber' },
  { pattern: /\bas the automation agent\b|\bautomation take\b/i, persona: 'automation' },
  { pattern: /\bas the communications agent\b|\bcommunications take\b/i, persona: 'communications' },
  { pattern: /\bas the AI agent\b|\bas the AI\/ML agent\b|\bAI take\b/i, persona: 'ai' },
  { pattern: /\bas the production agent\b|\bas the production engineering agent\b|\bproduction take\b/i, persona: 'production' },
  { pattern: /\bas the tech agent\b|\btech take\b/i, persona: 'tech' },
]

/** Explicit requests always win over classification and cost no model round-trip. */
export function parseOverride(request: string): AgentPersona | undefined {
  for (const { pattern, persona } of OVERRIDE_PATTERNS) {
    if (pattern.test(request)) return persona
  }
  return undefined
}

export function keywordHint(request: string): AgentPersona[] {
  return detectCapabilities(request).map((capability) => capability.persona)
}

const ROUTER_PROMPT = `You are the routing layer in front of these specialist agents: Marketing, Sports Intelligence, Fitness Planning, Finance, Business Analyst, Data Analyst, Research, Cybersecurity, Automation, Communications, AI/ML, and Tech.

Read the request and decide which agent(s) should handle it, and in what order they should run if more than one applies. Route to the smallest set that can complete the work, but include every domain whose output is needed. Treat keyword hints as weak evidence only.

Specialist boundaries:
- marketing: campaigns, brand, copy, audience, launches
- sports: match and opponent analysis, scouting, athletes, teams, leagues, events, sports business, performance metrics
- fitness: workouts, training plans, strength, mobility, cardio, recovery, habits, and safe wellbeing support
- finance: budgets, forecasts, pricing, unit economics, financial scenarios
- business: requirements, process/KPI analysis, business cases, stakeholder decisions
- data: datasets, metrics, statistics, experiments, dashboards, reproducible analysis
- research: evidence gathering, source synthesis, fact checking, due diligence
- cyber: authorized defensive security, threat modeling, vulnerability triage, remediation
- automation: workflows, triggers, schedules, APIs, integrations, resumable execution
- communications: drafting and preparing email, messages, calendar, and stakeholder updates
- ai: AI/ML systems, model selection, prompts, evaluation, retrieval, inference
- production: release readiness, deployment, migrations, rollback, observability, and incident operations
- tech: coding, debugging, infrastructure, implementation, and technical integration

For external communication or security work, route to the specialist even when Tech is also needed. Call submit_route exactly once with the personas in dependency order. You may also provide dependency waves: put personas in the same wave only when they can independently investigate without writing or taking external actions. Any persona that must implement, send, publish, deploy, or mutate shared state belongs in a singleton wave after its dependencies.`

interface RouteCapture {
  tool: Tool
  taken(): AgentRoute | undefined
}

function createRouteTool(): RouteCapture {
  let captured: AgentRoute | undefined
  const tool: Tool = {
    name: 'submit_route',
    description: 'Submit which specialist agent(s) should handle this request, in dependency order. Call exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        personas: { type: 'array', items: { type: 'string', enum: AGENT_PERSONAS }, description: 'One or more specialist names in dependency order' },
        waves: { type: 'array', items: { type: 'array', items: { type: 'string', enum: AGENT_PERSONAS } }, description: 'Optional dependency waves. Personas in one wave run concurrently in read-only mode; waves run in order.' },
        rationale: { type: 'string', description: 'One sentence explaining the route' },
      },
      required: ['personas', 'rationale'],
    },
    async execute(input) {
      const raw = Array.isArray(input.personas) ? input.personas.filter(isAgentPersona) : []
      const personas = [...new Set(raw)]
      if (personas.length === 0) throw new Error(`personas must include at least one of: ${AGENT_PERSONAS.join(', ')}`)
      const candidateWaves = Array.isArray(input.waves)
        ? input.waves.map((wave) => Array.isArray(wave) ? [...new Set(wave.filter(isAgentPersona))] : []).filter((wave) => wave.length > 0)
        : []
      const flattened = candidateWaves.flat()
      const waves = flattened.length === personas.length && new Set(flattened).size === personas.length && personas.every((persona) => flattened.includes(persona))
        ? candidateWaves
        : undefined
      captured = { personas, rationale: typeof input.rationale === 'string' ? input.rationale : '', waves }
      return 'Route recorded.'
    },
  }
  return { tool, taken: () => { const route = captured; captured = undefined; return route } }
}

export function deterministicRoute(request: string): AgentRoute {
  const override = parseOverride(request)
  if (override) return { personas: [override], rationale: 'explicit override in the request' }
  const hints = keywordHint(request)
  return hints.length > 0
    ? { personas: hints, rationale: 'dry-run used deterministic capability hints; full execution uses the model router' }
    : { personas: ['tech'], rationale: 'dry-run found no capability hint; defaulting to tech' }
}

export async function classifyRequest(request: string): Promise<AgentRoute & { usage: Usage }> {
  const { runAgentLoop } = await import('../agentLoop.ts')
  const { autoFallbacksFor, tierConfig } = await import('../config.ts')
  const routeCapture = createRouteTool()
  const hint = keywordHint(request)
  const hintLine = hint.length > 0 ? `\n\n(Weak keyword signal: ${hint.join(', ')} — use judgment; this is not a decision.)` : ''
  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: `Request:\n${request}${hintLine}` }] }]
  const fast = tierConfig('fast')
  const result = await runAgentLoop({
    messages,
    systemPrompt: ROUTER_PROMPT,
    tools: [routeCapture.tool],
    provider: fast.provider,
    providerName: fast.providerName,
    model: fast.model,
    fallbacks: autoFallbacksFor(fast.providerName),
    maxSteps: 3,
    useAnimation: false,
    verbose: false,
  })
  const route = routeCapture.taken() ?? { personas: ['tech'] as AgentPersona[], rationale: 'router did not classify the request; defaulting to tech' }
  return { ...route, usage: result.usage }
}
