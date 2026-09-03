import type { Tool } from '../tools/types.ts'
import { runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { autoFallbacksFor, tierConfig } from '../config.ts'
import type { Usage } from '../providers/types.ts'

export interface RiskVerdict {
  risky: boolean
  reason: string
}

// A cheap first-pass signal, same role as router.ts's KEYWORD_TABLE — a hint
// handed to the classifier, never authoritative on its own.
const RISK_KEYWORDS =
  /\b(delete|remove|rm -rf|del |drop table|force.?push|push --force|reset --hard|shutdown|format|sudo|uninstall|send|email|dm |message|post|publish|tweet|buy|purchase|pay|spend|transfer|wire|subscribe|cancel|deploy to prod|production)\b/i

function keywordHint(command: string): string {
  return RISK_KEYWORDS.test(command)
    ? '\n\n(First-pass keyword signal: this looks like it might involve an irreversible or high-impact action — use your judgment, this is only a hint.)'
    : ''
}

// Shell-ish / destructive tokens that, on their own, mean "actually run the
// full classifier" even if the message opens like a question.
const ACTS_ON_THE_WORLD = /[;&|`$]|\b(rm|mv|cp|dd|chmod|chown|kill|curl|wget|npm|pnpm|yarn|bun|pip|docker|kubectl|ssh|scp)\b|\bgit\s+(push|reset|clean|rebase|checkout)\b/i

/**
 * A local, zero-latency pre-filter for manual mode's per-message risk check.
 * When a message carries none of the risk keywords or shell tokens and reads
 * as a question or a request to explain rather than an instruction to act, it
 * cannot itself be a risky command — so skip the fast-tier round-trip that
 * otherwise sits between the user pressing Enter and the turn starting.
 *
 * This only removes a *courtesy pre-warning*: anything the model then decides
 * to actually do is still assessed per-action by the autonomy governor, which
 * is the real safety boundary. Conservative by construction — any doubt
 * (keywords, shell syntax, length, a non-interrogative opening) falls through
 * to the model classifier.
 */
export function looksObviouslySafe(command: string): boolean {
  const t = command.trim()
  if (t.length === 0 || t.length > 280) return false
  if (RISK_KEYWORDS.test(t) || ACTS_ON_THE_WORLD.test(t)) return false
  // Short interrogatives take a word boundary ("is" but not "isotope");
  // explain-style openers match as a prefix ("summ" covers "summarize").
  const interrogative = /^(what|why|how|who|whom|whose|when|where|which|is|are|was|were|do|does|did|can|could|should|would|will)\b/i
  const askToExplain = /^(explain|describe|summ|tell me|show me|walk me|give me|help me understand|remind me)/i
  return interrogative.test(t) || askToExplain.test(t)
}

const RISK_PROMPT = `You are the safety gate in front of an autonomous coding/PC agent. It is about to run a command with no further confirmation once it starts — read the command and decide whether it needs a human to confirm first.

Flag risky = true when the command could plausibly cause an irreversible or high-impact effect: deleting or overwriting files/data outside easy version-control recovery, destructive or system-level shell commands (rm -rf, format, drop table, sudo, force-push, hard reset), sending a message/email on the user's behalf, posting or publishing anything publicly, spending money or committing an ad/purchase, changing account or security settings, or anything the user would be upset to discover happened without being asked.

Flag risky = false for ordinary, easily-reversible work: reading files, writing/editing code in the project, listing/searching, running builds/tests/typechecks, local exploratory commands, answering questions.

When genuinely unsure, prefer risky = true — a human will just say yes if it's fine.

Call flag_risk exactly once with your decision.`

/**
 * The fast-tier classifier occasionally stutters and repeats the same
 * sentence two or three times in one `reason` string — harmless to the
 * verdict itself, but it shows up verbatim in the confirmation prompt the
 * user has to read. Collapsing repeats here fixes it for every caller at the
 * source, rather than patching each place that renders `reason`.
 */
export function dedupeRepeatedSentences(text: string): string {
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const unique: string[] = []
  for (const part of parts) {
    const key = part.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(part)
  }
  return unique.join(' ')
}

function createRiskTool(): { tool: Tool; taken(): RiskVerdict | undefined } {
  let captured: RiskVerdict | undefined

  const tool: Tool = {
    name: 'flag_risk',
    description: 'Report whether the command needs human confirmation before it runs. Call exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        risky: { type: 'boolean', description: 'true if this needs human confirmation before running' },
        reason: { type: 'string', description: 'One short sentence: why (or why not)' },
      },
      required: ['risky', 'reason'],
    },
    async execute(input) {
      captured = {
        risky: input.risky === true,
        reason: typeof input.reason === 'string' ? dedupeRepeatedSentences(input.reason) : '',
      }
      return 'Risk verdict recorded.'
    },
  }

  return {
    tool,
    taken() {
      const verdict = captured
      captured = undefined
      return verdict
    },
  }
}

/**
 * Classifies a command as risky or not via a cheap fast-tier call, so "manual"
 * mode only interrupts the user for commands that actually warrant it instead
 * of asking every single time. Fails closed — if the classifier never calls
 * flag_risk (provider hiccup, malformed response), the command is treated as
 * risky, same philosophy as verify.ts's requireCriticVerdict: a missing safety
 * check is never implicit permission.
 */
export async function classifyRisk(command: string): Promise<RiskVerdict & { usage: Usage }> {
  const riskCapture = createRiskTool()

  const messages: ConversationMessage[] = [
    { role: 'user', content: [{ type: 'text', text: `Command:\n${command}${keywordHint(command)}` }] },
  ]

  const fast = tierConfig('fast')
  const result = await runAgentLoop({
    messages,
    systemPrompt: RISK_PROMPT,
    tools: [riskCapture.tool],
    provider: fast.provider,
    providerName: fast.providerName,
    model: fast.model,
    fallbacks: autoFallbacksFor(fast.providerName),
    maxSteps: 3,
    useAnimation: false,
    verbose: false,
  })

  const verdict = riskCapture.taken() ?? {
    risky: true,
    reason: 'risk classifier did not respond; defaulting to asking first',
  }
  return { ...verdict, usage: result.usage }
}
