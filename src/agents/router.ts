import type { Tool } from '../tools/types.ts'
import { runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { tierConfig } from '../config.ts'
import type { Usage } from '../providers/types.ts'
import { AGENT_PERSONAS, isAgentPersona, type AgentPersona, type AgentRoute } from './types.ts'

const OVERRIDE_PATTERNS: { pattern: RegExp; persona: AgentPersona }[] = [
  { pattern: /\bas the marketing agent\b/i, persona: 'marketing' },
  { pattern: /\bmarketing take\b/i, persona: 'marketing' },
  { pattern: /\bas the finance agent\b/i, persona: 'finance' },
  { pattern: /\bfinance take\b/i, persona: 'finance' },
  { pattern: /\bas the tech agent\b/i, persona: 'tech' },
  { pattern: /\btech take\b/i, persona: 'tech' },
]

/**
 * An explicit ask like "as the Tech agent..." or "give me the Marketing take"
 * always wins over classification, per the orchestrator's routing rules — and
 * checked first so it never costs a model round-trip.
 */
export function parseOverride(request: string): AgentPersona | undefined {
  for (const { pattern, persona } of OVERRIDE_PATTERNS) {
    if (pattern.test(request)) return persona
  }
  return undefined
}

const KEYWORD_TABLE: { pattern: RegExp; persona: AgentPersona }[] = [
  { pattern: /\b(campaign|ad copy|audience|brand|launch|content calendar)\b/i, persona: 'marketing' },
  { pattern: /\b(budget|forecast|\bcost\b|pricing|\broi\b|cash flow|p&l|runway)\b/i, persona: 'finance' },
  { pattern: /\b(bug|\bbuild\b|automate|integrate|deploy|script|\bapi\b|error|how do i set up)\b/i, persona: 'tech' },
]

/** The spec's keyword first-pass, as a pure function so it's testable and can be handed to the router as a hint. */
export function keywordHint(request: string): AgentPersona[] {
  const hits: AgentPersona[] = []
  for (const { pattern, persona } of KEYWORD_TABLE) {
    if (pattern.test(request) && !hits.includes(persona)) hits.push(persona)
  }
  return hits
}

const ROUTER_PROMPT = `You are the routing layer in front of three specialist agents: Marketing, Finance, and Tech.

Read the request and decide which agent(s) should handle it, and in what order they should run if more than one applies.

First-pass signal table (use judgment beyond it — this is not exhaustive):
- campaign, ad copy, audience, brand, launch, content calendar -> marketing
- budget, forecast, cost, pricing, ROI, cash flow, P&L, runway -> finance
- bug, build, automate, integrate, deploy, script, API, error, "how do I set up..." -> tech

Route to more than one agent when the request genuinely spans domains — e.g. "should we build or buy this" needs finance then tech; "plan the launch for our new pricing tier" needs marketing then finance. List personas in the order they should run: whichever agent's output the others need as input goes first.

Call submit_route exactly once with your decision.`

interface RouteCapture {
  tool: Tool
  taken(): AgentRoute | undefined
}

function createRouteTool(): RouteCapture {
  let captured: AgentRoute | undefined

  const tool: Tool = {
    name: 'submit_route',
    description: 'Submit which agent(s) should handle this request, in run order. Call exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        personas: {
          type: 'array',
          items: { type: 'string', enum: AGENT_PERSONAS },
          description: 'One or more of: marketing, finance, tech — in the order they should run',
        },
        rationale: { type: 'string', description: 'One sentence: why this routing' },
      },
      required: ['personas', 'rationale'],
    },
    async execute(input) {
      const raw = Array.isArray(input.personas) ? input.personas.filter(isAgentPersona) : []
      // A model can plausibly list the same persona twice (or repeat one while also
      // meaning a different order) — dedupe while keeping first-seen order rather
      // than running that persona's turn more than once.
      const personas = [...new Set(raw)]
      if (personas.length === 0) {
        throw new Error('personas must include at least one of: marketing, finance, tech. Call submit_route again.')
      }
      captured = { personas, rationale: typeof input.rationale === 'string' ? input.rationale : '' }
      return 'Route recorded.'
    },
  }

  return {
    tool,
    taken() {
      const route = captured
      captured = undefined
      return route
    },
  }
}

/**
 * Classifies a request into one or more personas via a cheap fast-tier call.
 * Falls back to ['tech'] — elia's original default persona — if the model
 * never calls submit_route, so a router hiccup degrades gracefully instead of
 * failing the whole request. Returns its own usage so the caller can fold the
 * routing cost into the run's total instead of losing it silently.
 */
export async function classifyRequest(request: string): Promise<AgentRoute & { usage: Usage }> {
  const routeCapture = createRouteTool()
  const hint = keywordHint(request)
  const hintLine = hint.length > 0 ? `\n\n(First-pass keyword signal: ${hint.join(', ')} — use your judgment, this is only a hint.)` : ''

  const messages: ConversationMessage[] = [
    { role: 'user', content: [{ type: 'text', text: `Request:\n${request}${hintLine}` }] },
  ]

  const fast = tierConfig('fast')
  const result = await runAgentLoop({
    messages,
    systemPrompt: ROUTER_PROMPT,
    tools: [routeCapture.tool],
    provider: fast.provider,
    model: fast.model,
    maxSteps: 3,
    useAnimation: false,
    verbose: false,
  })

  const route = routeCapture.taken() ?? {
    personas: ['tech'] as AgentPersona[],
    rationale: 'router did not classify the request; defaulting to tech',
  }
  return { ...route, usage: result.usage }
}
