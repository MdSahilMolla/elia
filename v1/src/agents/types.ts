export type AgentPersona = 'marketing' | 'finance' | 'tech'

export const AGENT_PERSONAS: AgentPersona[] = ['marketing', 'finance', 'tech']

export function isAgentPersona(value: unknown): value is AgentPersona {
  return typeof value === 'string' && (AGENT_PERSONAS as string[]).includes(value)
}

/** What the router decided, and why — surfaced to the user only if they ask which agent handled it. */
export interface AgentRoute {
  personas: AgentPersona[]
  rationale: string
}
