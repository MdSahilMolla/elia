import type { EliaMode } from '../serverTypes.ts'

export const ELIA_DOMAINS = ['code', 'research', 'data', 'finance', 'writing', 'strategy', 'general'] as const
export type EliaDomain = (typeof ELIA_DOMAINS)[number]

export const DOMAIN_MODES: Readonly<Record<EliaDomain, EliaMode>> = {
  code: 'dev',
  research: 'research',
  data: 'data',
  finance: 'finance',
  writing: 'presentation',
  strategy: 'battmann',
  general: 'general',
}

export const DOMAIN_LABELS: Readonly<Record<EliaDomain, string>> = {
  code: 'Software and code work',
  research: 'Research and evidence synthesis',
  data: 'Data analysis',
  finance: 'Finance and financial analysis',
  writing: 'Writing and document production',
  strategy: 'Strategy and business planning',
  general: 'General assistance',
}

const GENERAL_CONFIDENCE = 0.3
const AMBIGUITY_RATIO = 0.72
const MAX_SIGNALS = 6
const MAX_REASONING_CHARS = 240

export interface DomainScores {
  code: number
  research: number
  data: number
  finance: number
  writing: number
  strategy: number
  general: number
}

export interface DomainDetection {
  domain: EliaDomain
  mode: EliaMode
  confidence: number
  reasoning: string
  scores: DomainScores
  signals: string[]
  ambiguous: boolean
  runnerUp?: EliaDomain
  signalSource: 'goal' | 'context' | 'none'
  contextUsed: boolean
}

interface Signal {
  readonly pattern: RegExp
  readonly weight: number
}

const PHRASE = 4
const STRONG = 3
const KEYWORD = 1.5

const SIGNAL_SETS: Readonly<Record<Exclude<EliaDomain, 'general'>, readonly Signal[]>> = {
  code: [
    { pattern: /\b(stack ?trace|null ?pointer|segmentation fault|type ?error|traceback|exception)\b/i, weight: PHRASE },
    { pattern: /\b(unit test|integration test|test suite|test case|snapshot test|flaky test)\b/i, weight: PHRASE },
    { pattern: /\b(typecheck(?:ing)?|type error|compile error|build (?:is )?failing|does not compile)\b/i, weight: PHRASE },
    { pattern: /\b(api endpoint|http handler|rest endpoint|graphql schema)\b/i, weight: PHRASE },
    { pattern: /\b(pull request|code review|merge conflict|git branch|rebase)\b/i, weight: PHRASE },
    { pattern: /\b(bug|bugfix|crash(?:es|ed|ing)?|regression(?:s)?|refactor(?:s|ed|ing)?|patch(?:es|ed|ing)?|compil(?:e|es|ed|ing|ation)|typescript|javascript|python|rust|golang|sql migration|lint error|runtime error|deadlock|memory leak)\b/i, weight: STRONG },
    { pattern: /\b(repository|codebase|module|function|class|method|package|dependenc(?:y|ies)|import|export|commit|endpoint|handler|schema|test(?:s|ed|ing)?|fail(?:s|ed|ing|ure)?|fix(?:es|ed|ing)?|debug(?:s|ged|ging)?|implement(?:s|ed|ing|ation)?|migrat(?:e|es|ed|ing|ion))\b/i, weight: KEYWORD },
  ],
  research: [
    { pattern: /\b(literature review|citation|peer[- ]reviewed|source(s)? (?:for|to) (?:cite|citing))\b/i, weight: PHRASE },
    { pattern: /\b(background on|what (?:is|are|was|were) the (?:history|evidence|state of))\b/i, weight: PHRASE },
    { pattern: /\b(due diligence|fact[- ]check|evidence table|field study|survey the literature)\b/i, weight: PHRASE },
    { pattern: /\b(research|investigat(?:e|es|ed|ing|ion)|compare vendors?|landscape|prior art|open questions|source(s)?|cites?|papers?|studies|study|evidence|findings?)\b/i, weight: KEYWORD },
    { pattern: /\b(peer[- ]reviewed|cited|empirical|systematic review)\b/i, weight: STRONG },
    { pattern: /\b(why does|how does|explain|context on|overview of|state of the art|survey)\b/i, weight: KEYWORD },
  ],
  data: [
    { pattern: /\b(data ?frame|missing values?|outliers?|exploratory data|eda|pivot table|group by|rolling average)\b/i, weight: PHRASE },
    { pattern: /\b(select .+ from|join .+ on|group by|order by)\b/i, weight: PHRASE },
    { pattern: /\b(csv|parquet|dataset|datasets?|metrics?|statistics|statistical|histogram|scatter plot|heatmap|anomal(?:y|ies)|cohorts?|funnels?|retention)\b/i, weight: STRONG },
    { pattern: /\b(analy[sz](?:e|es|ed|ing)|aggregate|aggregation|clean|normalis|normaliz|visuali[sz]|chart|charts|plots?|dashboard|query|queries|correlation|regression|median|percentile)\b/i, weight: KEYWORD },
  ],
  finance: [
    { pattern: /\b(discounted cash flow|dcf|cash flow|unit economics|burn rate|runway|p&l|profit and loss|market cap|market capitalisation|market capitalization)\b/i, weight: PHRASE },
    { pattern: /\b(cap table|term sheet|valuation model|sensitivity analysis|price point|cost model|revenue model|roi|arr|mrr|cac|ltv)\b/i, weight: PHRASE },
    { pattern: /\b(revenue|budget|forecast|pricing|valuation|margins?|investment|invest|cost|costs|spend|expense|expenses|profit|earnings|tax|taxes|invoice|invoicing|billing)\b/i, weight: STRONG },
    { pattern: /\b(financial|finance|quarter|annual|fiscal|monetary|balance sheet|discount rate|terminal value|enterprise value)\b/i, weight: KEYWORD },
  ],
  writing: [
    { pattern: /\b(blog post|press release|release notes|newsletter|landing page copy|product description|email draft|social post)\b/i, weight: PHRASE },
    { pattern: /\b(rewrit(?:e|es|ing)|draft(?:s|ed|ing)?|proofread(?:s|ed|ing)?|rephras(?:e|es|ing)|paraphras(?:e|es|ing))\b/i, weight: STRONG },
    { pattern: /\b(writing|wrote|written|edit(?:s|ed|ing)?|copy|copywriting|prose|narrative|documentation)\b/i, weight: STRONG },
    { pattern: /\b(wording|tone|style guide|voice|headline|paragraph|summari[sz]e into|readme|changelog|article|essay|announcement)\b/i, weight: KEYWORD },
  ],
  strategy: [
    { pattern: /\b(go[- ]to[- ]market|total addressable market|tam|business model|competitive (?:landscape|advantage|positioning)|market (?:entry|share|size|positioning))\b/i, weight: PHRASE },
    { pattern: /\b(pricing strategy|growth strategy|expansion strategy|partnership strategy|technology strategy|hiring plan)\b/i, weight: PHRASE },
    { pattern: /\b(roadmap|three[- ]year plan|next quarter|priorit(?:y|ies|ise|ize|ization)|strategic)\b/i, weight: PHRASE },
    { pattern: /\b(strateg(?:y|ies|ic)|positioning|okrs?|objectives|moat|differentiation|segment|persona|market)\b/i, weight: STRONG },
    { pattern: /\b(plan|decision|trade[- ]?off|leverage|growth|quarter|board|executive|vision)\b/i, weight: KEYWORD },
  ],
}

const GOAL_WEIGHT = 1
const CONTEXT_WEIGHT = 0.35
const MAX_TEXT_CHARS = 20_000

const SCORE_KEYS = ELIA_DOMAINS.filter((domain): domain is Exclude<EliaDomain, 'general'> => domain !== 'general')

function emptyScores(): DomainScores {
  return { code: 0, research: 0, data: 0, finance: 0, writing: 0, strategy: 0, general: 0 }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS)
}

interface DomainMatch {
  readonly domain: Exclude<EliaDomain, 'general'>
  readonly goalScore: number
  readonly contextScore: number
  readonly signals: string[]
}

function scoreDomain(domain: Exclude<EliaDomain, 'general'>, goal: string, context: string): DomainMatch {
  let goalScore = 0
  let contextScore = 0
  const signals: string[] = []
  for (const signal of SIGNAL_SETS[domain]) {
    const inGoal = signal.pattern.test(goal)
    const inContext = context.length > 0 && signal.pattern.test(context)
    if (inGoal) {
      goalScore += signal.weight * GOAL_WEIGHT
      signals.push(goal.match(signal.pattern)?.[0]?.toLowerCase() ?? signal.pattern.source)
    }
    if (inContext) {
      contextScore += signal.weight * CONTEXT_WEIGHT
      if (!inGoal) signals.push(context.match(signal.pattern)?.[0]?.toLowerCase() ?? signal.pattern.source)
    }
  }
  return { domain, goalScore, contextScore, signals }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function detectEliaDomain(goal: string, context = ''): DomainDetection {
  const goalText = normalize(typeof goal === 'string' ? goal : '')
  const contextText = normalize(typeof context === 'string' ? context : '')
  const scores = emptyScores()
  const signalsByDomain = new Map<EliaDomain, string[]>()
  const usedContext = contextText.length > 0

  const matches = SCORE_KEYS.map((domain) => scoreDomain(domain, goalText, contextText))
  const goalCarries = matches.some((match) => match.goalScore > 0)
  const signalSource: DomainDetection['signalSource'] = goalCarries ? 'goal' : usedContext && matches.some((match) => match.contextScore > 0) ? 'context' : 'none'

  for (const match of matches) {
    const score = goalCarries ? match.goalScore + match.contextScore : match.contextScore
    if (score <= 0) continue
    scores[match.domain] = round(score)
    signalsByDomain.set(match.domain, match.signals)
  }

  const ranked = SCORE_KEYS.map((domain) => ({ domain, score: scores[domain] }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
  const winner = ranked[0]
  const runnerUp = ranked[1]

  if (!winner) {
    return {
      domain: 'general',
      mode: DOMAIN_MODES.general,
      confidence: GENERAL_CONFIDENCE,
      reasoning: goalText.length === 0
        ? 'no goal text supplied, so no domain signal could be scored'
        : 'no domain signal matched the goal or its context, so it falls back to general assistance',
      scores,
      signals: [],
      ambiguous: false,
      signalSource: 'none',
      contextUsed: usedContext,
    }
  }

  const secondScore = runnerUp?.score ?? 0
  const margin = winner.score - secondScore
  const confidence = round(clamp(margin / (winner.score || 1)))
  const ambiguous = runnerUp !== undefined && secondScore >= winner.score * AMBIGUITY_RATIO
  const signals = [...new Set(signalsByDomain.get(winner.domain) ?? [])].slice(0, MAX_SIGNALS)
  const marginText = runnerUp ? `${round(margin)} ahead of ${runnerUp.domain}` : `no runner-up`
  const sourceText = signalSource === 'context' ? 'scored from context only, the goal carried no signal' : usedContext ? 'context scored at 0.35x' : ''
  const reasoning = `${DOMAIN_LABELS[winner.domain]}: matched ${signals.length} signal${signals.length === 1 ? '' : 's'} (${signals.join(', ')}), ${marginText}${
    sourceText ? `; ${sourceText}` : ''
  }`.slice(0, MAX_REASONING_CHARS)

  return {
    domain: winner.domain,
    mode: DOMAIN_MODES[winner.domain],
    confidence,
    reasoning,
    scores,
    signals,
    ambiguous,
    runnerUp: runnerUp?.domain,
    signalSource,
    contextUsed: usedContext,
  }
}

export function modeForDomain(domain: EliaDomain): EliaMode {
  return DOMAIN_MODES[domain]
}

export function domainsForMode(mode: EliaMode): EliaDomain[] {
  return ELIA_DOMAINS.filter((domain) => DOMAIN_MODES[domain] === mode)
}

export function domainForMode(mode: EliaMode): EliaDomain {
  return domainsForMode(mode)[0] ?? 'general'
}

export function isEliaDomain(value: unknown): value is EliaDomain {
  return typeof value === 'string' && (ELIA_DOMAINS as readonly string[]).includes(value)
}
