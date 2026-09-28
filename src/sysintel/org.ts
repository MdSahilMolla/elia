import type { RoleName } from '../autonomy/types.ts'

/**
 * The organization System Intelligence mode runs work through: the hats a mature technical
 * organization is made of, the one question each hat owns, what it produces and reviews,
 * and which of elia's workers wears it. The model is data, not prose, so the engine can
 * route a stage to an owner, pick the right worker for a delegated brief, and decide
 * whether a review came from someone independent of the work.
 */

export type OrgFunction = 'leadership' | 'research' | 'product' | 'engineering' | 'data-ml' | 'reliability-security' | 'program' | 'knowledge'

export const ORG_ROLE_IDS = [
  'cto', 'chief-scientist', 'staff-engineer', 'principal-engineer', 'engineering-manager',
  'research-scientist', 'research-engineer', 'applied-researcher',
  'product-manager', 'product-designer',
  'backend-engineer', 'frontend-engineer', 'fullstack-engineer', 'platform-engineer', 'infrastructure-engineer',
  'data-engineer', 'data-scientist', 'ml-engineer', 'mlops-engineer', 'ai-engineer',
  'sre', 'security-engineer', 'qa-engineer',
  'tpm', 'technical-writer',
] as const

export type OrgRoleId = (typeof ORG_ROLE_IDS)[number]

export interface OrgRole {
  id: OrgRoleId
  title: string
  function: OrgFunction
  /** The single question this hat is accountable for answering. */
  owns: string
  responsibilities: string[]
  /** Artifact kinds this hat normally writes. */
  produces: string[]
  /** Review kinds this hat is qualified to give. */
  reviews: string[]
  /**
   * The elia worker that wears this hat when the stage is delegated. `lead` means the
   * lead agent does it itself: decisions and coordination, not delegated labour.
   */
  worker: RoleName | 'lead'
  /** How the work itself flows for this hat, in order. */
  workflow?: string[]
}

export const ORG_ROLES: Record<OrgRoleId, OrgRole> = {
  'cto': {
    id: 'cto', title: 'CTO', function: 'leadership',
    owns: 'Is this the right technical direction for the organization?',
    responsibilities: ['what to build and what not to build', 'which technologies to adopt', 'architecture direction', 'where engineering effort is invested', 'technical risk', 'how engineering scales', 'what the organization looks like in 1–3 years'],
    produces: ['strategy', 'adr'], reviews: ['architecture-review'], worker: 'lead',
    workflow: ['strategy', 'technology direction', 'organization', 'architecture', 'execution'],
  },
  'chief-scientist': {
    id: 'chief-scientist', title: 'Chief Scientist / Head of Research', function: 'leadership',
    owns: 'What is technically possible, and what should we investigate?',
    responsibilities: ['research agenda', 'scientific direction and methodology', 'research infrastructure', 'publications', 'long-term technical bets'],
    produces: ['research-proposal', 'strategy'], reviews: ['research-review'], worker: 'critic',
  },
  'staff-engineer': {
    id: 'staff-engineer', title: 'Staff Engineer', function: 'leadership',
    owns: 'How should this technical problem work across every team it touches?',
    responsibilities: ['cross-team architecture', 'standards and engineering practices', 'technical strategy for a problem area', 'design and RFC review'],
    produces: ['rfc', 'design-doc', 'adr'], reviews: ['architecture-review', 'code-review'], worker: 'critic',
  },
  'principal-engineer': {
    id: 'principal-engineer', title: 'Principal Engineer', function: 'leadership',
    owns: 'What should the whole technical architecture look like over the next five years?',
    responsibilities: ['company-wide architecture', 'major technology decisions', 'large-scale migrations', 'long-term engineering direction'],
    produces: ['strategy', 'rfc', 'adr'], reviews: ['architecture-review'], worker: 'critic',
  },
  'engineering-manager': {
    id: 'engineering-manager', title: 'Engineering Manager', function: 'leadership',
    owns: 'Do the people and teams have what they need to deliver?',
    responsibilities: ['staffing and ownership', 'delivery health', 'unblocking', 'growth of engineers'],
    produces: ['program-plan'], reviews: [], worker: 'lead',
  },
  'research-scientist': {
    id: 'research-scientist', title: 'Research Scientist', function: 'research',
    owns: 'Does this approach work?',
    responsibilities: ['literature review', 'identify the gap', 'hypotheses', 'experimental design', 'analysis against baselines', 'statistical significance', 'documenting findings — including refuted hypotheses'],
    produces: ['literature-review', 'research-proposal', 'experiment-plan', 'experiment-results'], reviews: ['research-review'], worker: 'scout',
    workflow: ['literature', 'identify gap', 'hypothesis', 'experimental design', 'experiment', 'results', 'analysis', 'conclusion', 'paper / prototype / new hypothesis'],
  },
  'research-engineer': {
    id: 'research-engineer', title: 'Research Engineer', function: 'research',
    owns: 'Can we experimentally validate it — reproducibly?',
    responsibilities: ['experiment infrastructure', 'training and evaluation pipelines', 'datasets', 'reproducibility', 'experiment automation', 'research code'],
    produces: ['benchmark-report', 'experiment-results'], reviews: [], worker: 'builder',
    workflow: ['research idea', 'implementation', 'experiment infrastructure', 'run', 'evaluate', 'analyze', 'back to the researcher'],
  },
  'applied-researcher': {
    id: 'applied-researcher', title: 'Applied Researcher', function: 'research',
    owns: 'Can research solve this real product problem well enough to matter?',
    responsibilities: ['connect research to a product outcome', 'feasibility against real constraints', 'prototype on real data'],
    produces: ['feasibility', 'experiment-results'], reviews: ['research-review'], worker: 'builder',
  },
  'product-manager': {
    id: 'product-manager', title: 'Product Manager', function: 'product',
    owns: 'Are we solving the right problem — what, why, for whom, and in what order?',
    responsibilities: ['problem definition', 'requirements', 'roadmap and priorities', 'user stories', 'acceptance criteria', 'success metrics'],
    produces: ['prd', 'roadmap', 'user-stories'], reviews: [], worker: 'scout',
  },
  'product-designer': {
    id: 'product-designer', title: 'Product Designer / UX', function: 'product',
    owns: 'How should the user interact with the system?',
    responsibilities: ['user research', 'user flows', 'wireframes', 'prototypes', 'usability testing', 'final design'],
    produces: ['ux-spec'], reviews: ['design-review'], worker: 'designer',
    workflow: ['user research', 'problem definition', 'user flow', 'wireframe', 'prototype', 'usability testing', 'final design'],
  },
  'backend-engineer': {
    id: 'backend-engineer', title: 'Backend Engineer', function: 'engineering',
    owns: 'Can we build the service logic reliably?',
    responsibilities: ['APIs', 'databases', 'business logic', 'distributed systems', 'services'],
    produces: ['design-doc', 'api-spec'], reviews: ['code-review'], worker: 'backend',
    workflow: ['requirement', 'technical design', 'implementation', 'unit tests', 'code review', 'CI', 'deployment'],
  },
  'frontend-engineer': {
    id: 'frontend-engineer', title: 'Frontend Engineer', function: 'engineering',
    owns: 'Can users actually use what we built?',
    responsibilities: ['web applications', 'dashboards', 'interfaces', 'interaction systems', 'client-side logic'],
    produces: ['design-doc'], reviews: ['code-review'], worker: 'frontend',
  },
  'fullstack-engineer': {
    id: 'fullstack-engineer', title: 'Full-Stack Engineer', function: 'engineering',
    owns: 'Can one owner carry the feature end to end — frontend, API, backend, database?',
    responsibilities: ['whole-feature ownership across frontend, API, backend, database, and infrastructure'],
    produces: ['design-doc'], reviews: ['code-review'], worker: 'builder',
  },
  'platform-engineer': {
    id: 'platform-engineer', title: 'Platform Engineer', function: 'engineering',
    owns: 'Can engineers build, ship, and operate it efficiently?',
    responsibilities: ['internal developer platform', 'CI/CD and deployment systems', 'service templates', 'infrastructure automation', 'secrets management', 'observability', 'developer tooling'],
    produces: ['design-doc', 'runbook', 'release-plan'], reviews: ['code-review'], worker: 'builder',
    workflow: ['developer', 'git push', 'CI/CD', 'build', 'test', 'deploy', 'infrastructure'],
  },
  'infrastructure-engineer': {
    id: 'infrastructure-engineer', title: 'Infrastructure / Cloud Engineer', function: 'engineering',
    owns: 'Is the compute, network, and storage underneath it sound?',
    responsibilities: ['servers and clusters', 'networking', 'cloud resources', 'GPU infrastructure', 'storage', 'scaling', 'infrastructure as code'],
    produces: ['design-doc', 'runbook'], reviews: ['reliability-review'], worker: 'builder',
  },
  'data-engineer': {
    id: 'data-engineer', title: 'Data Engineer', function: 'data-ml',
    owns: 'Does data arrive correct, complete, and on time?',
    responsibilities: ['ETL/ELT pipelines', 'warehouses and lakes', 'streaming systems', 'data quality systems', 'data contracts and lineage'],
    produces: ['data-contract', 'lineage'], reviews: ['data-review'], worker: 'backend',
    workflow: ['raw data', 'ingestion', 'validation', 'transformation', 'warehouse / lake', 'analytics / ML'],
  },
  'data-scientist': {
    id: 'data-scientist', title: 'Data Scientist', function: 'data-ml',
    owns: 'What does the data actually say?',
    responsibilities: ['statistical analysis', 'prediction models', 'experiment analysis', 'business insight', 'forecasting'],
    produces: ['analysis-report'], reviews: ['data-review'], worker: 'builder',
    workflow: ['question', 'data collection', 'cleaning', 'EDA', 'feature engineering', 'modeling', 'evaluation', 'interpretation', 'recommendation'],
  },
  'ml-engineer': {
    id: 'ml-engineer', title: 'Machine Learning Engineer', function: 'data-ml',
    owns: 'Can we run the model in production at acceptable cost and latency?',
    responsibilities: ['model serving and inference', 'pipelines', 'optimization', 'feature systems', 'model versioning', 'production monitoring'],
    produces: ['model-card', 'design-doc'], reviews: ['code-review'], worker: 'backend',
  },
  'mlops-engineer': {
    id: 'mlops-engineer', title: 'MLOps Engineer', function: 'data-ml',
    owns: 'Is every model reproducible, versioned, monitored, and retrainable?',
    responsibilities: ['reproducibility', 'model and dataset versions', 'training pipelines', 'model registry', 'drift monitoring', 'retraining'],
    produces: ['model-card', 'runbook'], reviews: ['reliability-review'], worker: 'builder',
    workflow: ['dataset', 'training', 'evaluation', 'model registry', 'deployment', 'monitoring', 'retraining'],
  },
  'ai-engineer': {
    id: 'ai-engineer', title: 'AI / LLM Engineer', function: 'data-ml',
    owns: 'Does the LLM system solve the user problem — as measured by evals, not demos?',
    responsibilities: ['LLM applications', 'RAG', 'agents and tool calling', 'prompting and fine-tuning', 'model routing', 'evaluations', 'inference cost and latency'],
    produces: ['eval-report', 'design-doc'], reviews: ['code-review'], worker: 'builder',
    workflow: ['user problem', 'model selection', 'prompt / architecture', 'evaluation', 'optimization', 'deployment', 'monitoring'],
  },
  'sre': {
    id: 'sre', title: 'Site Reliability Engineer', function: 'reliability-security',
    owns: 'Does it stay reliable in the real world?',
    responsibilities: ['uptime, latency, availability', 'SLIs, SLOs, and SLAs', 'incidents', 'capacity', 'deployment safety', 'observability — logs, metrics, traces'],
    produces: ['slo', 'runbook', 'incident-report', 'postmortem'], reviews: ['reliability-review'], worker: 'critic',
    workflow: ['alert', 'incident', 'triage', 'identify cause', 'mitigation', 'recovery', 'root cause analysis', 'prevent recurrence'],
  },
  'security-engineer': {
    id: 'security-engineer', title: 'Security Engineer', function: 'reliability-security',
    owns: 'Can it be trusted?',
    responsibilities: ['identity, authentication, authorization', 'encryption and secrets', 'vulnerability management', 'application and cloud security', 'supply-chain security', 'incident response'],
    produces: ['threat-model', 'security-review', 'vulnerability-report'], reviews: ['security-review'], worker: 'security',
    workflow: ['design', 'threat modeling', 'implementation', 'security testing', 'deployment', 'monitoring', 'incident response'],
  },
  'qa-engineer': {
    id: 'qa-engineer', title: 'QA / Test Engineer', function: 'reliability-security',
    owns: 'Did the change break anything, and does it hold up under real use and load?',
    responsibilities: ['unit, integration, and end-to-end tests', 'load testing', 'regression testing', 'security testing with the security team'],
    produces: ['test-plan'], reviews: ['qa-signoff'], worker: 'tester',
  },
  'tpm': {
    id: 'tpm', title: 'Technical Program Manager', function: 'program',
    owns: 'Does everything connect — dependencies, timelines, risks, and milestones?',
    responsibilities: ['cross-team dependencies', 'timelines and milestones', 'risk register', 'cross-team communication', 'technical execution'],
    produces: ['program-plan'], reviews: [], worker: 'lead',
  },
  'technical-writer': {
    id: 'technical-writer', title: 'Technical Writer', function: 'knowledge',
    owns: 'Can someone else understand, use, and operate it without asking?',
    responsibilities: ['API documentation', 'architecture docs', 'runbooks', 'onboarding and developer guides', 'operational procedures'],
    produces: ['developer-guide', 'runbook', 'api-spec'], reviews: [], worker: 'scribe',
  },
}

export function isOrgRoleId(value: unknown): value is OrgRoleId {
  return typeof value === 'string' && (ORG_ROLE_IDS as readonly string[]).includes(value)
}

export function orgRole(id: string): OrgRole {
  if (!isOrgRoleId(id)) throw new Error(`unknown role "${id}" — use one of: ${ORG_ROLE_IDS.join(', ')}`)
  return ORG_ROLES[id]
}

/** Where work comes from (every one of these eventually becomes technical work). */
export const ORIGINS = {
  business: { raisedBy: 'cto', example: 'Customers are losing money because of X.', lifecycle: 'feature' },
  product: { raisedBy: 'product-manager', example: 'Users need capability X.', lifecycle: 'feature' },
  research: { raisedBy: 'research-scientist', example: 'A new technique could make X possible.', lifecycle: 'research' },
  engineering: { raisedBy: 'staff-engineer', example: 'Our current architecture cannot support X efficiently.', lifecycle: 'change' },
  data: { raisedBy: 'data-scientist', example: 'The data shows a major opportunity or problem.', lifecycle: 'analysis' },
  security: { raisedBy: 'security-engineer', example: 'This system has a vulnerability.', lifecycle: 'vulnerability' },
  operations: { raisedBy: 'sre', example: 'Production reliability is degrading.', lifecycle: 'incident' },
} as const satisfies Record<string, { raisedBy: OrgRoleId; example: string; lifecycle: string }>

export type Origin = keyof typeof ORIGINS
export const ORIGIN_IDS = Object.keys(ORIGINS) as Origin[]

export function isOrigin(value: unknown): value is Origin {
  return typeof value === 'string' && value in ORIGINS
}

/** Review kinds, and which elia workers count as independent of the work for each. */
export const REVIEW_KINDS = {
  'code-review': { by: 'staff-engineer', workers: ['critic', 'bughunter'], subject: 'tree', asks: 'Should this code become part of the long-term system — correctness, architecture, security, maintainability, performance, tests, readability?' },
  'security-review': { by: 'security-engineer', workers: ['security'], subject: 'tree', asks: 'Can an attacker break it? Injection, authn/authz, secrets, trust boundaries, supply chain.' },
  'architecture-review': { by: 'principal-engineer', workers: ['critic'], subject: 'artifact', asks: 'Is the design sound across teams and over years — alternatives, trade-offs, failure modes, migration and rollback?' },
  'reliability-review': { by: 'sre', workers: ['critic', 'tester'], subject: 'tree', asks: 'Will it stay reliable — SLOs, capacity, observability, safe rollout and rollback?' },
  'qa-signoff': { by: 'qa-engineer', workers: ['tester'], subject: 'tree', asks: 'Do unit, integration, end-to-end, and regression tests show it works and nothing else broke?' },
  'accessibility-review': { by: 'product-designer', workers: ['accessibility'], subject: 'tree', asks: 'Can every user operate it — semantics, keyboard, contrast, screen readers?' },
  'design-review': { by: 'product-designer', workers: ['designer', 'accessibility'], subject: 'artifact', asks: 'Does the interaction design solve the user problem it was meant to?' },
  'research-review': { by: 'chief-scientist', workers: ['critic'], subject: 'artifact', asks: 'Does the evidence support the conclusion — baselines, significance, ablations, reproduction?' },
  'data-review': { by: 'data-engineer', workers: ['critic', 'tester'], subject: 'tree', asks: 'Is the data correct, complete, fresh, and true to its contract and lineage?' },
} as const satisfies Record<string, { by: OrgRoleId; workers: RoleName[]; subject: 'tree' | 'artifact'; asks: string }>

export type ReviewKind = keyof typeof REVIEW_KINDS
export const REVIEW_KIND_IDS = Object.keys(REVIEW_KINDS) as ReviewKind[]

export function isReviewKind(value: unknown): value is ReviewKind {
  return typeof value === 'string' && value in REVIEW_KINDS
}

/** Decisions only a person can make. The engine records them; it never makes them. */
export const SIGNOFF_GATES = {
  direction: 'Executive direction: this strategic initiative is the right bet for the organization (CTO / leadership).',
  release: 'Release: this change may be merged and shipped.',
  production: 'Production: this change may be deployed to (or change) a live production system.',
  'accept-risk': 'Accept risk: a known residual risk is accepted rather than fixed.',
} as const

export type SignoffGate = keyof typeof SIGNOFF_GATES
export const SIGNOFF_GATE_IDS = Object.keys(SIGNOFF_GATES) as SignoffGate[]

export function isSignoffGate(value: unknown): value is SignoffGate {
  return typeof value === 'string' && value in SIGNOFF_GATES
}

/** Individual-contributor and management ladders, and what widens at each step. */
export const LADDERS = {
  engineering: [
    ['Intern', 'learns the codebase on scoped tasks'],
    ['Junior Engineer', 'owns well-defined tasks'],
    ['Software Engineer', 'owns features'],
    ['Senior Engineer', 'owns a system'],
    ['Staff Engineer', 'owns a technical problem spanning multiple teams'],
    ['Senior Staff Engineer', 'owns a problem area across an organization'],
    ['Principal Engineer', 'owns company-wide architecture and multi-year direction'],
    ['Distinguished Engineer', 'owns industry-level technical direction'],
  ],
  management: [
    ['Engineering Manager', 'a team'],
    ['Senior Manager', 'several teams'],
    ['Director', 'an organization'],
    ['VP Engineering', 'engineering as a whole'],
    ['CTO', 'the technology direction of the company'],
  ],
} as const

/** The rhythms that keep information moving between teams. */
export const CADENCE = {
  daily: ['check issues', 'standup or async update', 'design / coding (deep work is the core)', 'code review', 'testing', 'collaboration', 'documentation', 'deploy / monitor'],
  research: ['read papers', 'analyze existing work', 'experiment', 'code', 'run experiments', 'analyze results', 'discuss with the team', 'document', 'next experiment'],
  weekly: ['Monday — planning: what matters this week? (si_work report view:"priorities")', 'Tuesday–Thursday — execution: research, engineering, testing, deployment', 'Friday — review: what shipped, what did we learn, what failed, what is next? (si_work report view:"week")'],
  quarterly: ['company strategy', 'technical strategy', 'objectives', 'projects', 'teams', 'execution', 'metrics', 'review'],
  forums: ['1:1s', 'design reviews', 'code reviews', 'research meetings', 'planning', 'architecture reviews', 'incident reviews', 'documentation', 'chat', 'issue trackers', 'email', 'technical presentations'],
} as const

/**
 * Where each forum lives in the record. Information has to move between teams; these are the
 * places it moves, and what each one leaves behind.
 */
export const FORUMS: Record<string, string> = {
  'design review': 'design-review / architecture-review on a ux-spec, design-doc, or rfc (si_record review artifact:…)',
  'code review': 'code-review on the exact code (si_record review)',
  'architecture review': 'the rfc lifecycle: staff review → principal architecture review → security review → decision (adr)',
  'research meeting': 'research-review on experiment-results; refuted hypotheses loop back (si_work advance to:"hypothesis")',
  'incident review': 'the postmortem artifact and its follow-up initiatives',
  'planning': 'si_work report view:"priorities" (Monday) and the planning lifecycle (quarter)',
  'standup / async update': 'si_work report view:"digest"',
  'Friday review': 'si_work report view:"week"',
  '1:1s, chat, email, presentations': 'drafted by elia on request; sending anything to a person asks you first',
  'documentation': 'artifacts, exported into the repository with si_artifact export',
}

export interface Team {
  id: string
  name: string
  /** The team this one sits under in the org chart. */
  parent?: string
  lead: OrgRoleId
  roles: OrgRoleId[]
  mission: string
  /** One of the specialised teams an autonomous-AI / recursive-improvement organization adds. */
  specialised?: boolean
}

/** The org chart: which teams exist, who leads them, what they own, and where they sit. */
export const TEAMS: Team[] = [
  { id: 'leadership', name: 'CTO / Chief Scientist', lead: 'cto', roles: ['cto', 'chief-scientist', 'principal-engineer', 'staff-engineer', 'engineering-manager'], mission: 'technology and research direction, architecture, and how the organization scales' },
  { id: 'research', name: 'Research', parent: 'leadership', lead: 'chief-scientist', roles: ['research-scientist', 'research-engineer', 'applied-researcher'], mission: 'what is possible — research science and applied research' },
  { id: 'product', name: 'Product', parent: 'leadership', lead: 'product-manager', roles: ['product-manager', 'product-designer'], mission: 'the right problem, for the right users, in the right order — PM and design' },
  { id: 'engineering', name: 'Engineering', parent: 'leadership', lead: 'engineering-manager', roles: ['backend-engineer', 'frontend-engineer', 'fullstack-engineer', 'platform-engineer', 'infrastructure-engineer'], mission: 'software, platform, and infrastructure engineering' },
  { id: 'data-ml-ai', name: 'Data / ML / AI', parent: 'leadership', lead: 'ml-engineer', roles: ['data-engineer', 'data-scientist', 'ml-engineer', 'mlops-engineer', 'ai-engineer'], mission: 'data platforms, models, MLOps, and AI systems' },
  { id: 'reliability-security', name: 'Reliability / Security / QA', parent: 'leadership', lead: 'sre', roles: ['sre', 'security-engineer', 'qa-engineer'], mission: 'production stays reliable, trusted, and correct' },
  { id: 'program', name: 'Programs and documentation', parent: 'leadership', lead: 'tpm', roles: ['tpm', 'technical-writer'], mission: 'cross-team execution and the written record' },
  { id: 'agent-research', name: 'Agent research', parent: 'research', lead: 'research-scientist', roles: ['research-scientist', 'research-engineer'], mission: 'how agents plan, act, remember, and improve themselves', specialised: true },
  { id: 'evaluation', name: 'Evaluation', parent: 'data-ml-ai', lead: 'ai-engineer', roles: ['ai-engineer', 'research-engineer', 'qa-engineer'], mission: 'benchmarks and evals that say whether a change is actually better', specialised: true },
  { id: 'experiment-infrastructure', name: 'Experiment infrastructure', parent: 'research', lead: 'research-engineer', roles: ['research-engineer', 'platform-engineer'], mission: 'reproducible experiment pipelines, compute, and tracking', specialised: true },
  { id: 'model-engineering', name: 'Model engineering', parent: 'data-ml-ai', lead: 'ml-engineer', roles: ['ml-engineer', 'mlops-engineer'], mission: 'training, serving, optimizing, and versioning models', specialised: true },
  { id: 'agent-runtime', name: 'Agent runtime', parent: 'engineering', lead: 'backend-engineer', roles: ['backend-engineer', 'ai-engineer', 'platform-engineer'], mission: 'the runtime agents execute in — tools, orchestration, state', specialised: true },
  { id: 'observability', name: 'Observability', parent: 'reliability-security', lead: 'sre', roles: ['sre', 'platform-engineer'], mission: 'logs, metrics, and traces — for AI: prompts, tool calls, tokens, cost, failures', specialised: true },
  { id: 'safety-security', name: 'Safety and security', parent: 'reliability-security', lead: 'security-engineer', roles: ['security-engineer', 'research-scientist'], mission: 'that autonomous systems stay inside their bounds and cannot be turned against their users', specialised: true },
  { id: 'data-infrastructure', name: 'Data infrastructure', parent: 'data-ml-ai', lead: 'data-engineer', roles: ['data-engineer', 'infrastructure-engineer'], mission: 'pipelines, warehouses, and data quality', specialised: true },
  { id: 'automated-experimentation', name: 'Automated experimentation', parent: 'research', lead: 'research-engineer', roles: ['research-engineer', 'mlops-engineer'], mission: 'experiments that design, run, and report themselves', specialised: true },
  { id: 'research-knowledge', name: 'Research knowledge management', parent: 'research', lead: 'technical-writer', roles: ['technical-writer', 'research-scientist'], mission: 'what the organization has learned, findable and reusable', specialised: true },
]

export const TEAM_IDS = TEAMS.map((team) => team.id)

export function isTeamId(value: unknown): value is string {
  return typeof value === 'string' && TEAM_IDS.includes(value)
}

/** The loop the whole organization turns — the reason the mode exists. */
export const FLYWHEEL = 'Research discovers → engineering builds → production generates evidence → evaluation measures → research learns → engineering improves.'
