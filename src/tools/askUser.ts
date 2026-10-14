import type { Tool } from './types.ts'
import { activeMode } from '../autonomy/mode.ts'
import { formatCostUsd, sessionCostLive } from '../usage.ts'
import { requestSpendIncrease } from '../spendLimit.ts'

/**
 * Installed per-session by the interactive loop, which is the only place with a
 * terminal to read from. A tool that had to reach for a global would mean any
 * code path that ran tools — a sub-agent, a test — could put a question in front
 * of a person who never asked to be there.
 */
let promptOperator: ((question: string) => Promise<string | undefined>) | null = null

export function setOperatorPrompt(fn: ((question: string) => Promise<string | undefined>) | null): void {
  promptOperator = fn
}

export function hasOperatorPrompt(): boolean {
  return promptOperator !== null
}

/** How much this session has already spent, for a model deciding whether an ask is even sensible. */
function spentSoFar(): string {
  return formatCostUsd(sessionCostLive().usd)
}

/**
 * `ask_user` — the one question a cyber run is allowed to ask.
 *
 * Its whole existence is the spending ceiling. A solve that runs out of budget
 * two steps before the flag has exactly one useful question to put to a person,
 * and making it end the turn instead meant the person had to reconstruct and
 * retype the request. The scope of the question is narrow on purpose: it asks
 * for money to continue, nothing else. A run that could ask "what should I try
 * next?" is a run being supervised, which is the mode this is not.
 */
export const askUserTool: Tool = {
  name: 'ask_user',
  description:
    'Ask the operator to raise the spending ceiling so an unfinished task can continue. Use this only when a run has hit its budget mid-task and the remaining work is worth finishing — state what is done, what is left, and what the extra budget buys. It cannot be used for methodology questions, scope questions, or anything else: outside cyber mode, or with nobody at a terminal, it refuses. An unanswered or declined ask ends the task with a summary.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'What you need, why the work is unfinished, and what the extra budget buys' },
      usd: {
        type: 'number',
        description: 'Total budget in USD for the whole session, not the amount to add. Must be more than has already been spent.',
      },
    },
    required: ['question', 'usd'],
  },
  async execute(input) {
    if (activeMode() !== 'cyber') return 'ask_user is only available in cyber mode. Carry on with the task as it stands.'
    if (!promptOperator) return 'There is nobody at a terminal to ask, so there is no point asking. Summarise what is done and what is left.'

    const question = typeof input.question === 'string' ? input.question.trim() : ''
    if (question.length === 0) throw new Error('question must be a non-empty string')
    if (question.length > 4_000) throw new Error('question exceeds 4000 characters')
    const usd = typeof input.usd === 'number' ? input.usd : Number.parseFloat(String(input.usd))

    const ask = `${question}\n\n(session has spent about ${spentSoFar()} so far; asking for a total budget of $${usd})`
    let answer: string | undefined
    try {
      answer = await promptOperator(ask)
    } catch (error) {
      return `The operator could not be asked (${error instanceof Error ? error.message : String(error)}). Summarise what is done and what is left.`
    }
    if (answer === undefined) return 'The operator declined to raise the ceiling. Summarise what is done, what is left, and what you would do next.'

    const granted = Number.parseFloat(answer.trim().replace(/^\$/, ''))
    if (!Number.isFinite(granted) || granted <= 0) return `"${answer.trim()}" is not an amount, so the ceiling was not changed. Summarise what is done and what is left.`

    // Apply it. Telling the model "continue" without moving the ceiling is the
    // failure this tool exists to prevent: `spendState` is re-read at the top of
    // every turn, so the next one would report `exceeded` again and the operator
    // would be asked the same question a second time. The run would loop on the
    // approval it had already been given. requestSpendIncrease refuses a ceiling
    // at or below what is already spent, for the same reason.
    const applied = requestSpendIncrease({ spentUsd: sessionCostLive().usd, exceeded: true }, granted)
    if (!applied.ok) {
      return `The operator answered ${formatCostUsd(granted)}, but the ceiling was not changed: ${applied.reason} Summarise what is done and what is left.`
    }
    if (granted < usd) {
      // The operator answered with less than the model asked for. Take the
      // operator's number as authoritative — it is their money, and a lower
      // ceiling than requested is a real decision, not a failed ask.
      return `The operator set the ceiling to ${formatCostUsd(granted)}, which is less than the ${formatCostUsd(usd)} you asked for. Continue within ${formatCostUsd(granted)}.`
    }
    return `The operator approved a ceiling of ${formatCostUsd(granted)}. Continue with the task.`
  },
}
