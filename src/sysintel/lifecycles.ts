import type { OrgRoleId, ReviewKind, SignoffGate } from './org.ts'

/**
 * How work actually moves through the organization. Each lifecycle is a sequence of
 * stages; each stage has an owner hat and the evidence that ends it. Which stages and
 * which gates apply depends on the work's scale and flags — a one-line fix does not get
 * an RFC, an irreversible migration does — and is fixed at intake so the gates an
 * initiative is held to are recorded with it, not re-derived later.
 */

export const SCALES = ['trivial', 'small', 'medium', 'large', 'strategic'] as const
export type Scale = (typeof SCALES)[number]

export const FLAGS = ['security', 'data', 'deployed', 'infrastructure', 'user-facing', 'ml', 'api', 'novel', 'irreversible'] as const
export type Flag = (typeof FLAGS)[number]

export const FLAG_MEANING: Record<Flag, string> = {
  'security': 'touches authentication, authorization, secrets, personal data, cryptography, or another trust boundary',
  'data': 'changes schemas, pipelines, migrations, or stored data',
  'deployed': 'ships to a running production environment (so deployment and monitoring stages apply)',
  'infrastructure': 'changes infrastructure, CI/CD, deployment, or runtime configuration',
  'user-facing': 'changes what users see or interact with',
  'ml': 'trains, changes, or serves an ML model or LLM behaviour',
  'api': 'changes a public or cross-team contract',
  'novel': 'feasibility is unproven — research is needed before committing',
  'irreversible': 'cannot be cleanly undone (data deletion, destructive migration, external commitment)',
}

export function scaleAtLeast(scale: Scale, minimum: Scale): boolean {
  return SCALES.indexOf(scale) >= SCALES.indexOf(minimum)
}

export interface Condition {
  minScale?: Scale
  /** Applies when ANY of these flags is set. */
  flags?: Flag[]
}

export type RequirementType = 'note' | 'artifact' | 'check' | 'change' | 'branch' | 'review' | 'signoff' | 'plan' | 'items' | 'followups' | 'dependencies' | 'children' | 'teams'

export interface RequirementSpec {
  type: RequirementType
  artifact?: string
  review?: ReviewKind
  gate?: SignoffGate
  /** For checks: must have passed on the current working tree, not merely since the stage began. */
  fresh?: boolean
  /** For reviews: the hat the reviewer must have worn (a staff review is not a principal review). */
  hat?: OrgRoleId
  /** For reviews: what was reviewed — the code, or a design document. Defaults to the review kind's usual subject. */
  subject?: 'tree' | 'artifact'
  when?: Condition
}

export interface StageSpec {
  id: string
  title: string
  owner: OrgRoleId
  does: string
  when?: Condition
  requires: RequirementSpec[]
}

export interface LifecycleSpec {
  id: string
  title: string
  summary: string
  stages: StageSpec[]
}

const note: RequirementSpec = { type: 'note' }
const change: RequirementSpec = { type: 'change' }
const check = (when?: Condition): RequirementSpec => ({ type: 'check', when })
const freshCheck = (when?: Condition): RequirementSpec => ({ type: 'check', fresh: true, when })
const artifact = (kind: string, when?: Condition): RequirementSpec => ({ type: 'artifact', artifact: kind, when })
const review = (kind: ReviewKind, when?: Condition, options: { hat?: OrgRoleId; subject?: 'tree' | 'artifact' } = {}): RequirementSpec => ({ type: 'review', review: kind, when, ...options })
const signoff = (gate: SignoffGate, when?: Condition): RequirementSpec => ({ type: 'signoff', gate, when })
const stage = (id: string, title: string, owner: OrgRoleId, does: string, requires: RequirementSpec[], when?: Condition): StageSpec => ({ id, title, owner, does, requires, when })

const SMALL: Condition = { minScale: 'small' }
const MEDIUM: Condition = { minScale: 'medium' }
const LARGE: Condition = { minScale: 'large' }
const DEPLOYED: Condition = { flags: ['deployed'] }
const SECURITY: Condition = { flags: ['security'] }

export const LIFECYCLES: LifecycleSpec[] = [
  {
    id: 'feature', title: 'Feature lifecycle', summary: 'Problem → discovery → research → specification → design → planning → implementation → testing → evaluation → review → release → deployment → monitoring → feedback.',
    stages: [
      stage('discovery', 'Discovery', 'product-manager', 'Investigate existing approaches, who has the problem, feasibility, constraints, and limitations.', [note], MEDIUM),
      stage('research', 'Research', 'research-scientist', 'Test candidate approaches (models, architectures, tools) against a baseline before committing to one.', [artifact('experiment-results')], { flags: ['novel'] }),
      stage('specification', 'Specification', 'product-manager', 'Define inputs, outputs, requirements, constraints, and acceptance criteria.', [note, artifact('prd', MEDIUM), artifact('user-stories', { minScale: 'large' })]),
      stage('design', 'Design', 'staff-engineer', 'Decide the architecture; security and infrastructure review it.', [
        note, artifact('design-doc', MEDIUM), artifact('rfc', LARGE), artifact('threat-model', { flags: ['security'], minScale: 'medium' }),
        artifact('data-contract', { flags: ['data'], minScale: 'medium' }), artifact('api-spec', { flags: ['api'] }), artifact('ux-spec', { flags: ['user-facing'], minScale: 'medium' }),
        review('architecture-review', LARGE), review('design-review', { flags: ['user-facing'], minScale: 'large' }),
        // "Security reviews it. Infrastructure reviews it." — the design, before anyone builds it.
        review('security-review', { flags: ['security'], minScale: 'medium' }, { subject: 'artifact' }),
        review('reliability-review', { flags: ['infrastructure', 'deployed'], minScale: 'large' }, { subject: 'artifact', hat: 'infrastructure-engineer' }),
        signoff('direction', { minScale: 'strategic' }),
      ], SMALL),
      stage('planning', 'Planning', 'tpm', 'Break the work into owned tasks with priority, estimate, dependencies, and acceptance criteria.', [{ type: 'plan' }, artifact('program-plan', { minScale: 'strategic' })], MEDIUM),
      stage('implementation', 'Implementation', 'fullstack-engineer', 'Build it, task by task.', [change, { type: 'items', when: MEDIUM }]),
      stage('testing', 'Testing', 'qa-engineer', 'Unit, integration, end-to-end, and regression tests on the finished change.', [freshCheck(), artifact('test-plan', LARGE)]),
      stage('evaluation', 'Evaluation', 'ai-engineer', 'Measure model or LLM quality against a baseline — evals, not demos.', [artifact('eval-report'), check()], { flags: ['ml'] }),
      stage('review', 'Review', 'staff-engineer', 'Independent review of the exact change that will ship.', [
        freshCheck(), review('code-review', SMALL), review('security-review', SECURITY), review('accessibility-review', { flags: ['user-facing'], minScale: 'medium' }),
        review('qa-signoff', LARGE), review('reliability-review', { flags: ['deployed'], minScale: 'large' }), review('data-review', { flags: ['data'], minScale: 'medium' }),
      ]),
      stage('release', 'Release', 'platform-engineer', 'Merge and ship — the person who owns the product decides.', [{ type: 'dependencies' }, freshCheck(), signoff('release', SMALL)]),
      stage('deployment', 'Deployment', 'platform-engineer', 'Roll out to production with a canary, flag, blue/green, or rolling strategy and a rollback trigger.', [artifact('release-plan', MEDIUM), signoff('production')], DEPLOYED),
      stage('monitoring', 'Monitoring', 'sre', 'Watch logs, metrics, and traces (and for AI: tokens, cost, failures, hallucination, tool errors) against the SLOs.', [note, artifact('runbook', MEDIUM), artifact('slo', LARGE)], DEPLOYED),
      stage('feedback', 'Feedback', 'product-manager', 'What did production and users teach us? New problems become new initiatives.', [note], MEDIUM),
    ],
  },
  {
    id: 'change', title: 'Engineering change (git workflow)', summary: 'Issue → branch → code → local tests → pull request → CI → code review → security checks → merge → staging → QA → production.',
    stages: [
      stage('branch', 'Branch', 'fullstack-engineer', 'Work on a branch, not the default branch.', [{ type: 'branch' }], SMALL),
      stage('code', 'Code', 'fullstack-engineer', 'Make the change.', [change]),
      stage('local-tests', 'Local tests', 'qa-engineer', 'Run the focused tests locally.', [freshCheck()]),
      stage('pull-request', 'Pull request', 'fullstack-engineer', 'Open a PR (or record why review happens locally).', [note], SMALL),
      stage('ci', 'Continuous integration', 'platform-engineer', 'Build, lint, unit and integration tests, security scan — the full gate.', [freshCheck()], SMALL),
      stage('code-review', 'Code review', 'staff-engineer', 'Another engineer decides whether this code should become part of the long-term system.', [review('code-review'), review('security-review', SECURITY)], SMALL),
      stage('merge', 'Merge', 'fullstack-engineer', 'Merge the reviewed change.', [{ type: 'dependencies' }, freshCheck(), signoff('release', SMALL)]),
      stage('staging', 'Staging', 'platform-engineer', 'Deploy to staging and smoke-test.', [note], DEPLOYED),
      stage('qa', 'QA', 'qa-engineer', 'QA sign-off on staging.', [review('qa-signoff')], { flags: ['deployed'], minScale: 'medium' }),
      stage('production', 'Production', 'sre', 'Deploy to production.', [signoff('production')], DEPLOYED),
    ],
  },
  {
    id: 'research', title: 'Research loop', summary: 'Question → literature → hypothesis → experiment design → experiment → analysis (↺ new hypothesis) → ablation → benchmark → reproduction → validation → outcome. Failure is a result.',
    stages: [
      stage('literature', 'Literature review', 'research-scientist', 'What is already known, and where is the gap?', [note, artifact('literature-review', MEDIUM)]),
      stage('hypothesis', 'Hypothesis', 'research-scientist', 'A falsifiable claim, and the result that would refute it.', [artifact('research-proposal')]),
      stage('experiment-design', 'Experimental design', 'research-scientist', 'Baseline, variables, metrics, seeds, ablations, stopping rule — decided before the run.', [artifact('experiment-plan')]),
      stage('experiment', 'Experiment', 'research-engineer', 'Run it, reproducibly.', [check()]),
      stage('analysis', 'Analysis', 'research-scientist', 'Compare against the baseline with uncertainty. A refuted hypothesis loops back to a new one.', [artifact('experiment-results')]),
      stage('ablation', 'Ablation', 'research-scientist', 'Remove components to learn which ones matter.', [note, check()], LARGE),
      stage('benchmark', 'Benchmark', 'research-engineer', 'Measure on the standard benchmark.', [check(), artifact('benchmark-report', LARGE)], MEDIUM),
      stage('reproduction', 'Reproduction', 'research-engineer', 'Re-run from scratch and get the same answer.', [check()]),
      stage('validation', 'Validation', 'chief-scientist', 'Independent review: does the evidence support the conclusion?', [review('research-review')]),
      stage('outcome', 'Outcome', 'research-scientist', 'Paper, algorithm, dataset, benchmark, prototype, new direction — or a documented refutation. Validated results can hand off to engineering.', [note]),
    ],
  },
  {
    id: 'incident', title: 'Incident management', summary: 'Alert → triage → identify cause → mitigation → recovery → root cause analysis → prevent recurrence.',
    stages: [
      stage('triage', 'Triage', 'sre', 'Severity, impact, scope — open the incident report.', [artifact('incident-report')]),
      stage('identify-cause', 'Identify cause', 'sre', 'Find what is causing it, from logs, metrics, traces.', [note]),
      stage('mitigation', 'Mitigation', 'sre', 'Stop the bleeding first — rollback, flag off, failover.', [note]),
      stage('recovery', 'Recovery', 'sre', 'Show the system is healthy again.', [check()]),
      stage('root-cause-analysis', 'Root cause analysis', 'sre', 'Blameless postmortem: not only what broke, but why the system allowed it.', [note, artifact('postmortem', SMALL)]),
      stage('prevent-recurrence', 'Prevent recurrence', 'staff-engineer', 'Every action item becomes a tracked follow-up initiative that changes the system (or the residual risk is explicitly accepted).', [{ type: 'followups', when: SMALL }, note]),
    ],
  },
  {
    id: 'vulnerability', title: 'Security vulnerability', summary: 'Report → triage → threat model → fix → verification → release → monitoring.',
    stages: [
      stage('report', 'Report', 'security-engineer', 'Document the vulnerability precisely enough to fix and verify.', [artifact('vulnerability-report')]),
      stage('triage', 'Triage', 'security-engineer', 'Severity, exposure, and urgency.', [note]),
      stage('threat-model', 'Threat model', 'security-engineer', 'What else an attacker could reach the same way.', [artifact('threat-model')], MEDIUM),
      stage('fix', 'Fix', 'backend-engineer', 'Fix the cause, not the symptom.', [change]),
      stage('verification', 'Verification', 'security-engineer', 'A regression test proves the fix; security reviews it.', [freshCheck(), review('security-review')]),
      stage('release', 'Release', 'platform-engineer', 'Ship the fix.', [freshCheck(), signoff('release'), signoff('production', DEPLOYED)]),
      stage('monitoring', 'Monitoring', 'security-engineer', 'Watch for exploitation attempts and regressions.', [note], DEPLOYED),
    ],
  },
  {
    id: 'data-pipeline', title: 'Data pipeline', summary: 'Contract → ingestion → validation → transformation → review → release → consumption.',
    stages: [
      stage('contract', 'Data contract', 'data-engineer', 'Agree schema, semantics, quality, and freshness with consumers.', [artifact('data-contract')]),
      stage('ingestion', 'Ingestion', 'data-engineer', 'Build the ingestion.', [change]),
      stage('validation', 'Validation', 'data-engineer', 'Data-quality checks run and pass.', [check()]),
      stage('transformation', 'Transformation', 'data-engineer', 'Transform into the warehouse / lake shape.', [freshCheck(), artifact('lineage', MEDIUM)]),
      stage('review', 'Review', 'data-engineer', 'Independent data and code review.', [review('data-review', SMALL), review('code-review', MEDIUM), review('security-review', SECURITY)]),
      stage('release', 'Release', 'platform-engineer', 'Ship the pipeline.', [freshCheck(), signoff('release', SMALL), signoff('production', DEPLOYED)]),
      stage('consumption', 'Consumption', 'data-scientist', 'Consumers (analytics, ML) confirm the data serves them.', [note]),
    ],
  },
  {
    id: 'analysis', title: 'Data analysis', summary: 'Question → data collection → cleaning → EDA → modeling → evaluation → interpretation → recommendation. (For a fully recorded analysis engine use /mode datascience.)',
    stages: [
      stage('question', 'Question', 'data-scientist', 'The decision this analysis informs.', [note]),
      stage('data-collection', 'Data collection', 'data-engineer', 'Sources, grain, time window, known gaps.', [note]),
      stage('cleaning', 'Cleaning', 'data-scientist', 'Clean reproducibly — a script, never hand edits.', [check()], SMALL),
      stage('eda', 'Exploratory analysis', 'data-scientist', 'Distributions, relationships, anomalies.', [note]),
      stage('modeling', 'Modeling', 'data-scientist', 'Fit the model or statistical test.', [check()], MEDIUM),
      stage('evaluation', 'Evaluation', 'data-scientist', 'Against a baseline, with uncertainty.', [note], MEDIUM),
      stage('interpretation', 'Interpretation', 'data-scientist', 'What the numbers mean for the decision.', [artifact('analysis-report')]),
      stage('recommendation', 'Recommendation', 'product-manager', 'What to do, and an independent check of the reasoning.', [note, review('data-review', MEDIUM)]),
    ],
  },
  {
    id: 'ml', title: 'ML model lifecycle (MLOps)', summary: 'Dataset → training → evaluation → registry → review → deployment → monitoring → retraining.',
    stages: [
      stage('dataset', 'Dataset', 'data-engineer', 'A versioned dataset with a contract.', [note, artifact('data-contract', MEDIUM)]),
      stage('training', 'Training', 'ml-engineer', 'A reproducible training run.', [check()]),
      stage('evaluation', 'Evaluation', 'mlops-engineer', 'Held-out evaluation against a baseline.', [artifact('eval-report'), check()]),
      stage('registry', 'Model registry', 'mlops-engineer', 'Versioned, documented, and rollback-able.', [artifact('model-card')]),
      stage('review', 'Review', 'staff-engineer', 'Independent review of the serving code and the model.', [freshCheck(), review('code-review', SMALL), review('reliability-review', { flags: ['deployed'], minScale: 'medium' }), review('security-review', SECURITY)]),
      stage('deployment', 'Deployment', 'ml-engineer', 'Serve it at acceptable cost and latency.', [artifact('release-plan', MEDIUM), signoff('production')], DEPLOYED),
      stage('monitoring', 'Monitoring', 'mlops-engineer', 'Drift, quality, latency, cost.', [note, artifact('runbook', MEDIUM)], DEPLOYED),
      stage('retraining', 'Retraining', 'mlops-engineer', 'When and how the model is retrained.', [note]),
    ],
  },
  {
    id: 'llm', title: 'AI / LLM system', summary: 'User problem → model selection → architecture → implementation → evaluation → optimization → review → release → deployment → monitoring.',
    stages: [
      stage('user-problem', 'User problem', 'product-manager', 'The user problem the LLM system solves.', [note]),
      stage('model-selection', 'Model selection', 'ai-engineer', 'Which model(s), and why — capability, cost, latency, licence.', [note, artifact('adr', MEDIUM)]),
      stage('architecture', 'Architecture', 'ai-engineer', 'Prompting, RAG, agents, tool calling, routing.', [note, artifact('design-doc', MEDIUM), artifact('threat-model', SECURITY)]),
      stage('implementation', 'Implementation', 'ai-engineer', 'Build it.', [change]),
      stage('evaluation', 'Evaluation', 'ai-engineer', 'Eval suite against a baseline: quality, hallucination, tool errors, latency, tokens, cost.', [artifact('eval-report'), check()]),
      stage('optimization', 'Optimization', 'ai-engineer', 'Improve what the evals showed, then re-run them.', [freshCheck()], MEDIUM),
      stage('review', 'Review', 'staff-engineer', 'Independent review.', [freshCheck(), review('code-review', SMALL), review('security-review', SECURITY)]),
      stage('release', 'Release', 'platform-engineer', 'Ship it.', [freshCheck(), signoff('release', SMALL)]),
      stage('deployment', 'Deployment', 'platform-engineer', 'Roll out to production.', [signoff('production')], DEPLOYED),
      stage('monitoring', 'Monitoring', 'ai-engineer', 'Prompt → model → tool call → output traces; latency, tokens, cost, failures, hallucination, tool errors.', [note], DEPLOYED),
    ],
  },
  {
    id: 'ux', title: 'Product design (UX)', summary: 'User research → problem definition → user flow → wireframe → prototype → usability testing → final design.',
    stages: [
      stage('user-research', 'User research', 'product-designer', 'Learn how users work today.', [note]),
      stage('problem-definition', 'Problem definition', 'product-designer', 'The user problem in one statement.', [note]),
      stage('user-flow', 'User flow', 'product-designer', 'The steps the user takes.', [note]),
      stage('wireframe', 'Wireframe', 'product-designer', 'Layout and hierarchy.', [note]),
      stage('prototype', 'Prototype', 'frontend-engineer', 'Something a user can try.', [change]),
      stage('usability-testing', 'Usability testing', 'product-designer', 'Try it; fix what confuses people.', [note, review('accessibility-review', SMALL)]),
      stage('final-design', 'Final design', 'product-designer', 'The spec engineering implements.', [artifact('ux-spec'), review('design-review', MEDIUM)]),
    ],
  },
  {
    id: 'rfc', title: 'RFC and architecture review', summary: 'Engineer drafts → senior/staff review → principal architecture review → security review → approval (ADR) → implementation handoff.',
    stages: [
      stage('draft', 'Draft', 'staff-engineer', 'Problem, background, current system, proposal, alternatives, trade-offs, costs, risks, migration, rollback.', [artifact('rfc')]),
      stage('staff-review', 'Senior / staff review', 'staff-engineer', 'Senior and staff engineers review the technical design across the teams it touches.', [review('architecture-review', undefined, { hat: 'staff-engineer' })]),
      stage('architecture-review', 'Architecture review', 'principal-engineer', 'The architecture review: is this right for the whole system, over years?', [review('architecture-review', undefined, { hat: 'principal-engineer' })], MEDIUM),
      stage('security-review', 'Security review', 'security-engineer', 'Threat model and security review of the design.', [artifact('threat-model'), review('security-review', undefined, { subject: 'artifact' })], SECURITY),
      stage('decision', 'Decision', 'cto', 'Record the decision; strategic direction is the person\'s call.', [artifact('adr'), signoff('direction', LARGE)]),
      stage('handoff', 'Implementation handoff', 'tpm', 'The accepted RFC becomes tracked implementation initiatives.', [{ type: 'followups' }]),
    ],
  },
  {
    id: 'planning', title: 'Quarterly technical planning', summary: 'Company strategy → technical strategy → objectives → projects → execution → metrics → review.',
    stages: [
      stage('strategy', 'Technical strategy', 'cto', 'Where technology goes, and what we will not do.', [artifact('strategy')]),
      stage('objectives', 'Objectives', 'cto', 'Objectives and measurable key results.', [artifact('okrs')]),
      stage('projects', 'Projects', 'tpm', 'Initiatives that move the key results, created and linked.', [{ type: 'followups' }]),
      stage('teams', 'Teams', 'engineering-manager', 'Every project has a team that owns it.', [{ type: 'teams' }]),
      stage('execution', 'Execution', 'tpm', 'Teams deliver; the quarter closes when its projects do.', [{ type: 'children' }]),
      stage('review', 'Review', 'cto', 'Metrics against the key results: what worked, what did not, what next.', [note, signoff('direction', { minScale: 'strategic' })]),
    ],
  },
]

const BY_ID = new Map(LIFECYCLES.map((lifecycle) => [lifecycle.id, lifecycle]))
export const LIFECYCLE_IDS = LIFECYCLES.map((lifecycle) => lifecycle.id)

export function lifecycle(id: string): LifecycleSpec {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`unknown lifecycle "${id}" — use one of: ${LIFECYCLE_IDS.join(', ')}`)
  return found
}

export function isLifecycleId(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value)
}

export function conditionHolds(condition: Condition | undefined, scale: Scale, flags: readonly Flag[]): boolean {
  if (!condition) return true
  if (condition.minScale && !scaleAtLeast(scale, condition.minScale)) return false
  if (condition.flags && !condition.flags.some((flag) => flags.includes(flag))) return false
  return true
}

/** A requirement as fixed on one initiative: concrete, with the reason it applies. */
export interface Requirement {
  type: RequirementType
  artifact?: string
  review?: ReviewKind
  gate?: SignoffGate
  fresh?: boolean
  hat?: OrgRoleId
  subject?: 'tree' | 'artifact'
  why: string
}

function reason(condition: Condition | undefined): string {
  if (!condition) return 'always'
  const parts: string[] = []
  if (condition.minScale) parts.push(`${condition.minScale}+ scale`)
  if (condition.flags) parts.push(`flagged ${condition.flags.join(' or ')}`)
  return parts.join(', ')
}

export interface PlannedStage {
  id: string
  title: string
  owner: OrgRoleId
  does: string
  requirements: Requirement[]
}

/** The stages and gates one initiative is held to, given its scale and flags. */
export function instantiate(lifecycleId: string, scale: Scale, flags: readonly Flag[]): PlannedStage[] {
  const spec = lifecycle(lifecycleId)
  const planned: PlannedStage[] = []
  for (const stageSpec of spec.stages) {
    if (!conditionHolds(stageSpec.when, scale, flags)) continue
    const requirements = stageSpec.requires
      .filter((requirement) => conditionHolds(requirement.when, scale, flags))
      .map(({ when, ...requirement }) => ({ ...requirement, why: reason(when) }))
    planned.push({ id: stageSpec.id, title: stageSpec.title, owner: stageSpec.owner, does: stageSpec.does, requirements })
  }
  return planned
}
