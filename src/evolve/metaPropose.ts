import { runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { allWorkerTools } from '../tools/registry.ts'
import type { Tool } from '../tools/types.ts'
import { writeText } from '../ui/stream.ts'
import { writePhase, writeSubStep } from '../ui/report.ts'
import { learningRate, readLedger, renderLedgerForPrompt } from './ledger.ts'
import { incumbentStrategy, renderFunnelForPrompt, writeChallenger, type Strategy } from './strategy.ts'

/**
 * The step where the improver rewrites how it improves.
 *
 * Called when recent generations banked nothing. The model reads the ledger —
 * what was tried, how far each attempt got, what the current strategy says —
 * and writes a different strategy. It does not replace the incumbent: it goes on
 * trial (strategy.ts), and only the generations it steers decide whether it stays.
 */

const META_MAX_STEPS = 20
const MIN_STRATEGY_CHARS = 200

const META_PROMPT = `You are elia, improving how you improve yourself.

\`elia evolve\` runs generations: a proposer (following a written search strategy) picks one change to elia's own source, a builder implements it in a sandbox, and fixed gates decide whether it is promoted — typecheck, unit tests, a benchmark scored by code, an independent confirmation run, and checks that the verifier and values did not get worse.

Recent generations banked nothing. Your job is to write a better search strategy: the guidance the proposer follows when choosing what to try. It will be put on trial against the current one, and kept only if the generations it steers get further through the gates.

What a good strategy does:
- Reads the funnel. If attempts die at "built" or "compiled", the strategy should steer toward smaller, well-typed changes; if they reach "measured" but are not "better", it should steer toward the failing tasks' actual failure causes; if they are "better" but not "confirmed", toward changes whose effect is large enough to survive sampling noise.
- Is concrete: name kinds of changes, kinds of evidence to gather first, and what to avoid given what has already been rejected.
- Stays within the rules. It cannot relax what may not be changed, and must not suggest editing the benchmark, the gates, tests, or safety code — those are enforced regardless, so a strategy that aims there only wastes generations.

Write 5–12 bullet points. Submit them with \`submit_strategy\`, then stop.`

function brief(current: Strategy): string {
  const records = readLedger()
  const learning = learningRate(records)
  return `## The current search strategy (${current.id})
${current.text}

## How far generations got
${renderFunnelForPrompt(records)}

Learning trend: ${learning.trend}; ${learning.promotions} of ${learning.generations} generation(s) promoted.

## The ledger
${renderLedgerForPrompt()}

Write a strategy that would have done better with this history, and submit it.`
}

export async function proposeChallengerStrategy(generation: number, signal?: AbortSignal): Promise<Strategy | undefined> {
  writePhase('reflect', 'recent generations banked nothing — writing a new search strategy to trial')
  let captured: string | undefined
  const submit: Tool = {
    name: 'submit_strategy',
    description: 'Submit the new search strategy (5–12 bullet points), then stop. Call exactly once.',
    input_schema: {
      type: 'object',
      properties: { strategy: { type: 'string', description: 'The full strategy as markdown bullet points' } },
      required: ['strategy'],
    },
    async execute(input) {
      const text = typeof input.strategy === 'string' ? input.strategy.trim() : ''
      if (text.length < MIN_STRATEGY_CHARS) throw new Error(`a strategy needs to be concrete — at least ${MIN_STRATEGY_CHARS} characters of guidance`)
      captured = text
      return 'Strategy recorded. Stop now.'
    },
  }
  const readOnly = allWorkerTools().filter((tool) => ['read_file', 'list_files', 'grep'].includes(tool.name))
  const messages: ConversationMessage[] = [{ role: 'user', content: [{ type: 'text', text: brief(incumbentStrategy()) }] }]
  try {
    // Ends on the first accepted strategy: the first run here asked for one and
    // got thirteen submissions, each overwriting the last and each paid for.
    await runAgentLoop({ messages, systemPrompt: META_PROMPT, tools: [...readOnly, submit], onText: writeText, useAnimation: true, verbose: true, maxSteps: META_MAX_STEPS, signal, finishAfterTool: 'submit_strategy' })
  } catch (err) {
    writeSubStep(`could not write a new strategy: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
  if (!captured) {
    writeSubStep('no strategy was submitted — the current one stays, with no trial')
    return undefined
  }
  const strategy = writeChallenger(captured, generation)
  writeSubStep(`strategy ${strategy.id} is on trial: the next generations flip a coin between it and ${incumbentStrategy().id}`)
  return strategy
}
