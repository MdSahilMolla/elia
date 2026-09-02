import { expect, test } from 'bun:test'
import type { ContentBlock, Provider, StreamTurnParams } from '../providers/types.ts'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads; every test below
// swaps in a stub provider so no real network call ever happens.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-orchestrator-test'

const { config } = await import('../config.ts')
const { runAgentRequest } = await import('./orchestrator.ts')

type Responder = (params: StreamTurnParams, toolNames: string[]) => { content: ContentBlock[] } | Promise<{ content: ContentBlock[] }>

/** Stubs both the ambient provider and the fast tier used by routing and parallel read-only waves. */
function stubProvider(respond: Responder): void {
  const provider: Provider = {
    async streamTurn(params) {
      const toolNames = params.tools.map((tool) => tool.name)
      const { content } = await respond(params, toolNames)
      return { content, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
  config.provider = provider
  config.tiers.deep.provider = provider
  config.tiers.fast.provider = provider
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function routeBlock(personas: string[], rationale: string, waves?: string[][]): ContentBlock[] {
  return [{ type: 'tool_use', id: 'route1', name: 'submit_route', input: { personas, rationale, waves } }]
}

test('a single-persona request answers directly with no headers or combined section', async () => {
  stubProvider((_params, toolNames) => {
    if (toolNames.includes('submit_route')) return { content: routeBlock(['marketing'], 'ad copy request') }
    return { content: textBlock('here are 3 captions') }
  })

  const result = await runAgentRequest('write 3 instagram captions for our new product')

  expect(result.personas).toEqual(['marketing'])
  expect(result.sections).toHaveLength(1)
  expect(result.sections[0]).toEqual({ persona: 'marketing', report: 'here are 3 captions' })
  expect(result.combined).toBeUndefined()
})

test('an explicit override skips the router entirely', async () => {
  let routerCalled = false
  stubProvider((_params, toolNames) => {
    if (toolNames.includes('submit_route')) routerCalled = true
    return { content: textBlock('tech answer') }
  })

  const result = await runAgentRequest('as the Tech agent, explain this error')

  expect(result.personas).toEqual(['tech'])
  expect(result.rationale).toBe('explicit override in the request')
  expect(routerCalled).toBe(false)
})

test('a multi-domain request runs personas in the routed order and produces a combined recommendation', async () => {
  let routed = false
  stubProvider((params, toolNames) => {
    if (toolNames.includes('submit_route')) {
      // A real model calls the tool once, then stops calling tools on its next turn —
      // mimic that so the router's loop terminates after exactly one route.
      if (!routed) {
        routed = true
        return { content: routeBlock(['finance', 'tech'], 'build vs buy') }
      }
      return { content: textBlock('') }
    }
    if (toolNames.length === 0) return { content: textBlock('finance and tech agree: build it') } // synthesis call
    if (params.system.includes('Finance agent')) return { content: textBlock('finance report') }
    if (params.system.includes('dev mode')) return { content: textBlock('tech report') }
    throw new Error(`unexpected system prompt: ${params.system}`)
  })

  const result = await runAgentRequest('should we build an in-house CRM or buy one')

  expect(result.personas).toEqual(['finance', 'tech'])
  expect(result.sections.map((s) => s.persona)).toEqual(['finance', 'tech'])
  expect(result.sections[0]!.report).toBe('finance report')
  expect(result.sections[1]!.report).toBe('tech report')
  expect(result.combined).toBe('finance and tech agree: build it')
})

test('independent persona sections overlap while preserving routed result order', async () => {
  let routed = false
  let inFlight = 0
  let maxInFlight = 0
  stubProvider(async (params, toolNames) => {
    if (toolNames.includes('submit_route')) {
      if (!routed) {
        routed = true
        return { content: routeBlock(['finance', 'marketing'], 'parallel review', [['finance', 'marketing']]) }
      }
      return { content: textBlock('') }
    }
    if (toolNames.length === 0) return { content: textBlock('combined') }
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await Bun.sleep(params.system.includes('Finance agent') ? 40 : 10)
    inFlight -= 1
    return { content: textBlock(params.system.includes('Finance agent') ? 'finance report' : 'marketing report') }
  })

  const result = await runAgentRequest('compare the financial and marketing plans')

  expect(maxInFlight).toBe(2)
  expect(result.sections.map((section) => section.persona)).toEqual(['finance', 'marketing'])
  expect(result.sections.map((section) => section.report)).toEqual(['finance report', 'marketing report'])
})

test('falls back to tech when the router never calls submit_route', async () => {
  stubProvider(() => ({ content: textBlock('a normal reply with no tool call') }))

  const result = await runAgentRequest('a request with no clear routing signal')

  expect(result.personas).toEqual(['tech'])
  expect(result.rationale).toContain('defaulting to tech')
})

test('duplicate personas from the router are deduped, so a repeated persona only runs once', async () => {
  let routed = false
  const runsPerPersona: Record<string, number> = {}
  stubProvider((params, toolNames) => {
    if (toolNames.includes('submit_route')) {
      if (!routed) {
        routed = true
        return { content: routeBlock(['tech', 'tech', 'marketing'], 'tech mentioned twice by mistake') }
      }
      return { content: textBlock('') }
    }
    if (toolNames.length === 0) return { content: textBlock('combined') }
    const persona = params.system.includes('dev mode') ? 'tech' : 'marketing'
    runsPerPersona[persona] = (runsPerPersona[persona] ?? 0) + 1
    return { content: textBlock(`${persona} report`) }
  })

  const result = await runAgentRequest('duplicate persona test')

  expect(result.personas).toEqual(['tech', 'marketing'])
  expect(result.sections).toHaveLength(2)
  expect(runsPerPersona.tech).toBe(1)
  expect(runsPerPersona.marketing).toBe(1)
})

test('one persona failing does not take down the rest of a multi-domain request', async () => {
  let routed = false
  stubProvider((params, toolNames) => {
    if (toolNames.includes('submit_route')) {
      if (!routed) {
        routed = true
        return { content: routeBlock(['finance', 'tech'], 'build vs buy') }
      }
      return { content: textBlock('') }
    }
    if (params.system.includes('Finance agent')) throw new Error('provider unavailable')
    if (toolNames.length === 0) return { content: textBlock('tech alone: proceed with the build') }
    return { content: textBlock('tech report') }
  })

  const result = await runAgentRequest('should we build an in-house CRM or buy one')

  expect(result.sections).toHaveLength(2)
  expect(result.sections[0]).toEqual({ persona: 'finance', report: '(this agent failed: provider unavailable)', failed: true })
  expect(result.sections[1]!.report).toBe('tech report')
  // Synthesis still ran over what's left, rather than the whole request failing.
  expect(result.combined).toBe('tech alone: proceed with the build')
})

test('usage is summed across every persona turn plus the router and synthesis calls', async () => {
  let routed = false
  stubProvider((_params, toolNames) => {
    if (toolNames.includes('submit_route')) {
      if (!routed) {
        routed = true
        return { content: routeBlock(['finance', 'tech'], 'build vs buy') }
      }
      return { content: textBlock('') } // model's turn after the tool call, ending the router's loop
    }
    if (toolNames.length === 0) return { content: textBlock('combined') }
    return { content: textBlock('report') }
  })

  const result = await runAgentRequest('should we build or buy this')

  // router (2: one tool call + one stop) + finance (1) + tech (1) + synthesis (1) = 5 calls, 1 input/output token each —
  // and the router's own usage must actually reach the total, not just the persona/synthesis calls.
  expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 })
})
