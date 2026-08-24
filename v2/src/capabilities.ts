import type { AgentPersona } from './agents/types.ts'

export type CapabilityId =
  | 'marketing'
  | 'sports'
  | 'fitness'
  | 'finance'
  | 'business-analysis'
  | 'data-analysis'
  | 'research'
  | 'cybersecurity'
  | 'automation'
  | 'communications'
  | 'ai-ml'
  | 'production-delivery'
  | 'software'

export type CapabilityRisk = 'low' | 'medium' | 'high'

export interface CapabilitySpec {
  id: CapabilityId
  persona: AgentPersona
  label: string
  summary: string
  risk: CapabilityRisk
  patterns: RegExp[]
  preferredTools: string[]
  outputContract: string[]
}

export const CAPABILITIES: CapabilitySpec[] = [
  {
    id: 'marketing',
    persona: 'marketing',
    label: 'Marketing and growth',
    summary: 'Campaigns, brand, positioning, content, audiences, and launches.',
    risk: 'medium',
    patterns: [/\b(campaign|ad copy|audience|brand|launch|content calendar)\b/i],
    preferredTools: ['web_search', 'web_fetch'],
    outputContract: ['audience and objective', 'copy or campaign artifact', 'measurement plan', 'source-backed claims'],
  },
  {
    id: 'sports',
    persona: 'sports',
    label: 'Sports intelligence and operations',
    summary: 'Match analysis, scouting, performance metrics, leagues, events, fan engagement, and sports business workflows.',
    risk: 'medium',
    patterns: [/\b(sports?|athlete|player|coach|team|league|match|game|fixture|tournament|scout|scouting|performance analysis|opponent|fan engagement|sponsorship|stadium|sports business)\b/i],
    preferredTools: ['data_science', 'read_spreadsheet', 'web_search', 'web_fetch', 'browser', 'presentation'],
    outputContract: ['competition or dataset context', 'source-backed observations', 'reproducible metrics or method', 'separation of fact, calculation, and opinion', 'limitations and uncertainty'],
  },
  {
    id: 'fitness',
    persona: 'fitness',
    label: 'Fitness planning and wellbeing support',
    summary: 'Goal setting, training organization, habit tracking, recovery reflection, and conservative fitness-plan adaptation.',
    risk: 'high',
    patterns: [/\b(fitness|workout|training plan|exercise|strength|mobility|cardio|running|lifting|gym|recovery|sleep|steps|calories|macros|nutrition|wellness|weight loss|muscle gain)\b/i],
    preferredTools: ['data_science', 'read_spreadsheet', 'web_search', 'web_fetch', 'write_file'],
    outputContract: ['goal, experience, equipment, and constraints', 'conservative progressive plan', 'tracking and adaptation criteria', 'safety or professional-referral notes', 'limitations and non-medical disclaimer'],
  },
  {
    id: 'finance',
    persona: 'finance',
    label: 'Finance and financial analysis',
    summary: 'Budgets, forecasts, pricing, unit economics, cash flow, ROI, valuation, DCF, and scenarios.',
    risk: 'high',
    patterns: [/\b(budget|forecast|\bcost\b|pricing|\broi\b|cash flow|p&l|runway|unit economics|dcf|valuation|discount rate|terminal value|enterprise value)\b/i],
    preferredTools: ['finance', 'read_spreadsheet', 'web_search', 'web_fetch'],
    outputContract: ['basis and fiscal period', 'assumptions', 'calculations with traceable inputs', 'sensitivity or scenarios', 'limitations and financial-analysis disclaimer'],
  },
  {
    id: 'business-analysis',
    persona: 'business',
    label: 'Business analysis',
    summary: 'Requirements, process maps, KPIs, business cases, prioritization, and stakeholder decisions.',
    risk: 'medium',
    patterns: [/\b(requirements?|process map|kpi|business case|stakeholder|operating model|build or buy|raci)\b/i],
    preferredTools: ['read_file', 'read_spreadsheet', 'web_search', 'web_fetch'],
    outputContract: ['objective and scope', 'actors and constraints', 'options and trade-offs', 'acceptance criteria'],
  },
  {
    id: 'data-analysis',
    persona: 'data',
    label: 'Data analysis',
    summary: 'Data quality, exploratory analysis, metrics, cohorts, experiments, anomalies, and reproducibility.',
    risk: 'medium',
    patterns: [/\b(dataset|data analysis|csv|sql|cohort|funnel|dashboard|anomal|regression|statistics|experiment readout)\b/i],
    preferredTools: ['data_science', 'read_spreadsheet', 'run_command', 'read_file'],
    outputContract: ['schema, quality, and leakage checks', 'method and reproducible calculations', 'tables or visuals', 'uncertainty and limitations', 'artifact or code path for reproduction'],
  },
  {
    id: 'research',
    persona: 'research',
    label: 'Research and evidence synthesis',
    summary: 'Source discovery, fact checking, literature, competitor intelligence, and due diligence.',
    risk: 'medium',
    patterns: [/\b(research|literature|sources?|cite|fact check|due diligence|benchmark study|evidence table)\b/i],
    preferredTools: ['web_search', 'web_fetch', 'browser'],
    outputContract: ['source plan', 'evidence table', 'citations and dates', 'confidence and open questions'],
  },
  {
    id: 'cybersecurity',
    persona: 'cyber',
    label: 'Cybersecurity and defensive assessment',
    summary: 'Authorized threat modeling, secure configuration, vulnerability triage, and remediation.',
    risk: 'high',
    patterns: [/\b(cybersecurity|security audit|vulnerabilit|penetration test|threat model|incident response|cve|hardening|soc)\b/i],
    preferredTools: ['new_engagement', 'run_security_tool', 'run_command'],
    outputContract: ['authorized scope', 'evidence and affected assets', 'severity and impact', 'remediation and retest criteria'],
  },
  {
    id: 'automation',
    persona: 'automation',
    label: 'Automation and integrations',
    summary: 'Workflows, triggers, schedules, APIs, webhooks, synchronization, and resumable execution.',
    risk: 'high',
    patterns: [/\b(workflow|automate|schedule|cron|webhook|sync|pipeline|orchestration)\b/i],
    preferredTools: ['run_command', 'browser', 'web_fetch'],
    outputContract: ['trigger and state', 'idempotent steps', 'approval points', 'retry and recovery policy', 'delivery receipt'],
  },
  {
    id: 'communications',
    persona: 'communications',
    label: 'External communications',
    summary: 'Email, messages, calendar invitations, stakeholder updates, and follow-ups.',
    risk: 'high',
    patterns: [/\b(email|inbox|co-founder|message|send|reply|calendar|meeting request|stakeholder update)\b/i],
    preferredTools: ['browser'],
    outputContract: ['recipient and channel check', 'draft', 'approval record', 'delivery evidence'],
  },
  {
    id: 'ai-ml',
    persona: 'ai',
    label: 'AI and machine learning',
    summary: 'Model selection, prompts, evaluation, retrieval, inference, and agent architecture.',
    risk: 'medium',
    patterns: [/\b(\bAI\b|LLM|model eval|prompt|RAG|embedding|fine-tun|inference|agent architecture)\b/i],
    preferredTools: ['run_command', 'read_spreadsheet', 'browser'],
    outputContract: ['evaluation question', 'model/version and conditions', 'metrics', 'reproducible experiment', 'risk notes'],
  },
  {
    id: 'production-delivery',
    persona: 'production',
    label: 'Production SaaS delivery',
    summary: 'Release readiness, deployment planning, migrations, rollback, observability, and incident operations.',
    risk: 'high',
    patterns: [/\b(production|release|deploy(?:ment)?|ci\/cd|observability|rollback|on-call|incident|sre|docker|kubernetes|terraform|migration)\b/i],
    preferredTools: ['production_readiness', 'project_profile', 'deployment', 'run_command', 'read_file', 'edit_file', 'task'],
    outputContract: ['release scope and environment', 'preflight evidence', 'migration and rollback plan', 'observability and incident plan', 'approval boundaries and postconditions'],
  },
  {
    id: 'software',
    persona: 'tech',
    label: 'Software and infrastructure',
    summary: 'Coding, debugging, APIs, deployment, infrastructure, and technical integration.',
    risk: 'high',
    patterns: [/\b(bug|\bbuild\b|deploy|script|\bapi\b|error|how do i set up|debug|repository)\b/i],
    preferredTools: ['run_command', 'read_file', 'edit_file', 'deployment', 'task'],
    outputContract: ['implemented change', 'tests or verification', 'security review', 'operational notes'],
  },
]

export function detectCapabilities(request: string): CapabilitySpec[] {
  return CAPABILITIES.filter((capability) => capability.patterns.some((pattern) => pattern.test(request)))
}

export function capabilityForPersona(persona: AgentPersona): CapabilitySpec | undefined {
  return CAPABILITIES.find((capability) => capability.persona === persona)
}
