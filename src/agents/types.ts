export type AgentPersona =
  | 'marketing'
  | 'sports'
  | 'fitness'
  | 'finance'
  | 'business'
  | 'data'
  | 'research'
  | 'cyber'
  | 'automation'
  | 'communications'
  | 'ai'
  | 'production'
  | 'tech'

export const AGENT_PERSONAS: AgentPersona[] = [
  'business',
  'data',
  'research',
  'cyber',
  'automation',
  'communications',
  'ai',
  'production',
  'marketing',
  'sports',
  'fitness',
  'finance',
  'tech',
]

export function isAgentPersona(value: unknown): value is AgentPersona {
  return typeof value === 'string' && (AGENT_PERSONAS as string[]).includes(value)
}

/** What the router decided, and why — surfaced to the user only if they ask which agent handled it. */
export interface AgentRoute {
  personas: AgentPersona[]
  rationale: string
  /** Dependency waves; personas in one wave are independent read-only peers. */
  waves?: AgentPersona[][]
}
