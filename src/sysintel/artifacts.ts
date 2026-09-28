import type { OrgRoleId } from './org.ts'

/**
 * The organization's written memory. A mature organization does not rely on people
 * remembering: it keeps PRDs, RFCs, design docs, threat models, runbooks, postmortems,
 * experiment plans and results, data contracts, model cards. Each template names the
 * sections a reviewer needs, and `validateArtifact` checks that they are really there
 * and really filled in — a heading followed by "TBD" is not a rollback plan.
 */

export interface SectionSpec {
  name: string
  /** Other headings accepted for this section. */
  aliases?: string[]
  guidance: string
  /** Minimum characters of real content (default 20). */
  minChars?: number
  /** At least this many list items ("- …", "1. …", or table rows). */
  minItems?: number
  /** The body must match — e.g. a conclusion must say supported, refuted, or inconclusive. */
  mustMatch?: { pattern: RegExp; message: string }
}

export interface ArtifactTemplate {
  kind: string
  title: string
  owner: OrgRoleId
  area: 'product' | 'engineering' | 'research' | 'operations' | 'security' | 'data' | 'ml' | 'planning' | 'knowledge'
  purpose: string
  sections: SectionSpec[]
  /** Phrases that trigger a warning (never a failure) with this message. */
  warnOn?: { pattern: RegExp; message: string }[]
}

const s = (name: string, guidance: string, extra: Omit<SectionSpec, 'name' | 'guidance'> = {}): SectionSpec => ({ name, guidance, ...extra })

const LIST = { minItems: 1 }

export const ARTIFACT_TEMPLATES: ArtifactTemplate[] = [
  // Product
  { kind: 'prd', title: 'Product Requirements Document', owner: 'product-manager', area: 'product', purpose: 'What we build, why, for whom, and how we will know it worked.', sections: [
    s('Problem', 'The user or business problem, with evidence it is real.'),
    s('Users', 'Who has the problem; the primary persona.', { aliases: ['Target Users', 'Personas'] }),
    s('Goals', 'Outcomes this must achieve.'),
    s('Non-goals', 'What is explicitly out of scope.', { aliases: ['Non goals', 'Out of Scope'] }),
    s('Requirements', 'Functional and non-functional requirements.', LIST),
    s('Constraints', 'Technical, legal, cost, time, or dependency constraints.'),
    s('Acceptance Criteria', 'Observable conditions for "done".', LIST),
    s('Success Metrics', 'How success is measured after launch, with targets.', { aliases: ['Metrics'] }),
  ] },
  { kind: 'roadmap', title: 'Roadmap', owner: 'product-manager', area: 'product', purpose: 'What ships in what order, and why that order.', sections: [
    s('Themes', 'The outcomes the roadmap serves.'),
    s('Now', 'Committed work in progress.', LIST),
    s('Next', 'Planned work after that.', LIST),
    s('Later', 'Directional bets.', LIST),
    s('Prioritization Rationale', 'Why this order — impact, effort, risk, dependencies.', { aliases: ['Rationale'] }),
  ] },
  { kind: 'user-stories', title: 'User Stories', owner: 'product-manager', area: 'product', purpose: 'Requirements as user outcomes with testable acceptance criteria.', sections: [
    s('Stories', '"As a <user>, I want <capability>, so that <outcome>."', { minItems: 1, mustMatch: { pattern: /\bas an?\b[\s\S]*\bi want\b[\s\S]*\bso that\b/i, message: 'write at least one story as "As a …, I want …, so that …"' } }),
    s('Acceptance Criteria', 'Testable conditions per story (Given/When/Then works well).', LIST),
  ] },
  // Engineering
  { kind: 'rfc', title: 'Request for Comments', owner: 'staff-engineer', area: 'engineering', purpose: 'A significant change proposed for review before anyone implements it.', sections: [
    s('Problem', 'What is wrong or missing, and for whom.'),
    s('Background', 'Context a reviewer needs.'),
    s('Current System', 'How it works today.', { aliases: ['Current State'] }),
    s('Proposed Solution', 'The change, concretely.', { aliases: ['Proposal'] }),
    s('Alternatives', 'Other options considered and why they lost.', { aliases: ['Alternatives Considered'] }),
    s('Trade-offs', 'What this choice costs and gains.', { aliases: ['Tradeoffs'] }),
    s('Costs', 'Engineering effort, infrastructure, and ongoing cost.', { aliases: ['Cost'] }),
    s('Risks', 'What could go wrong and how it is mitigated.', LIST),
    s('Migration Plan', 'How the system moves from current to proposed.', { aliases: ['Migration'] }),
    s('Rollback Plan', 'How to undo it, and what triggers a rollback.', { aliases: ['Rollback'] }),
  ] },
  { kind: 'adr', title: 'Architecture Decision Record', owner: 'staff-engineer', area: 'engineering', purpose: 'One decision, its context, and its consequences — so the next person trusts it instead of re-deriving it.', sections: [
    s('Status', 'proposed | accepted | superseded | deprecated', { minChars: 6, mustMatch: { pattern: /\b(proposed|accepted|superseded|deprecated|rejected)\b/i, message: 'status must be proposed, accepted, rejected, superseded, or deprecated' } }),
    s('Context', 'The forces at play.'),
    s('Decision', 'What was decided.'),
    s('Alternatives', 'What else was considered.', { aliases: ['Options Considered', 'Alternatives Considered'] }),
    s('Consequences', 'What becomes easier and harder.'),
  ] },
  { kind: 'design-doc', title: 'Technical Design Document', owner: 'backend-engineer', area: 'engineering', purpose: 'How a system will be built before it is built.', sections: [
    s('Overview', 'One paragraph a reviewer can hold in their head.', { aliases: ['Summary'] }),
    s('Goals', 'What the design must achieve.'),
    s('Non-goals', 'What it deliberately does not do.', { aliases: ['Non goals'] }),
    s('Architecture', 'Components and how requests flow between them.', { aliases: ['Design', 'Detailed Design'] }),
    s('Data Model', 'Entities, storage, schemas.', { aliases: ['Data'] }),
    s('Interfaces', 'APIs and contracts between components.', { aliases: ['APIs', 'API'] }),
    s('Failure Modes', 'What happens when each dependency fails.', { aliases: ['Failure Handling', 'Error Handling'] }),
    s('Security', 'Trust boundaries, authn/authz, secrets, data exposure.'),
    s('Observability', 'Logs, metrics, traces, alerts.'),
    s('Testing', 'How correctness will be shown.', { aliases: ['Test Plan'] }),
    s('Rollout', 'How it ships and how it is rolled back.', { aliases: ['Rollout Plan', 'Deployment'] }),
  ] },
  { kind: 'api-spec', title: 'API Specification', owner: 'backend-engineer', area: 'engineering', purpose: 'The contract other teams build against.', sections: [
    s('Endpoints', 'Each operation with method and path (or function signature).', LIST),
    s('Requests', 'Parameters and bodies, with types and validation.', { aliases: ['Request'] }),
    s('Responses', 'Success shapes.', { aliases: ['Response'] }),
    s('Errors', 'Error codes and when each happens.'),
    s('Authentication', 'Who may call what.', { aliases: ['Auth', 'Authorization'] }),
    s('Versioning', 'Compatibility guarantees and how breaking changes ship.', { aliases: ['Compatibility'] }),
  ] },
  { kind: 'test-plan', title: 'Test Plan', owner: 'qa-engineer', area: 'engineering', purpose: 'How we will know it works and nothing else broke.', sections: [
    s('Scope', 'What is and is not under test.'),
    s('Unit Tests', 'Individual functions.', { aliases: ['Unit'] }),
    s('Integration Tests', 'Multiple systems together.', { aliases: ['Integration'] }),
    s('End-to-End Tests', 'The whole user journey.', { aliases: ['E2E Tests', 'End to End Tests', 'E2E'] }),
    s('Regression', 'What existing behaviour must still hold.', { aliases: ['Regression Tests'] }),
    s('Load and Security', 'Traffic the system must handle; how attackers are simulated — or why not applicable.', { aliases: ['Load Testing', 'Performance and Security', 'Non-functional'] }),
    s('Exit Criteria', 'When testing is done.', LIST),
  ] },
  { kind: 'release-plan', title: 'Release Plan', owner: 'platform-engineer', area: 'engineering', purpose: 'How a change reaches production safely and how it comes back out.', sections: [
    s('Change', 'What is shipping.'),
    s('Strategy', 'Canary, feature flag, blue/green, or rolling — and why.', { mustMatch: { pattern: /\b(canary|feature[- ]flag|blue[/ -]?green|rolling|big[- ]bang|dark launch|staged)\b/i, message: 'name the rollout strategy (canary, feature flag, blue/green, rolling, …)' } }),
    s('Preconditions', 'What must be true before starting (CI green, approvals, backups).', LIST),
    s('Verification', 'The signals checked after each step.', { aliases: ['Validation'] }),
    s('Rollback Trigger', 'The exact signal that means roll back.', { aliases: ['Rollback Criteria'] }),
    s('Rollback Steps', 'How to roll back.', { aliases: ['Rollback'] }),
  ] },
  // Research
  { kind: 'literature-review', title: 'Literature Review', owner: 'research-scientist', area: 'research', purpose: 'What is already known, and the gap worth working on.', sections: [
    s('Question', 'The research question.'),
    s('Sources', 'Papers, systems, benchmarks reviewed — with links or citations.', LIST),
    s('Findings', 'What the prior work shows.'),
    s('Gap', 'What is unknown or unsolved.'),
  ] },
  { kind: 'research-proposal', title: 'Research Proposal', owner: 'research-scientist', area: 'research', purpose: 'A falsifiable question worth spending experiments on.', sections: [
    s('Question', 'The research question.'),
    s('Motivation', 'Why the answer matters (a product or production problem, or a capability).'),
    s('Prior Work', 'What is already known.', { aliases: ['Related Work', 'Background'] }),
    s('Hypothesis', 'The claim under test.'),
    s('Falsification', 'The result that would prove the hypothesis wrong.', { aliases: ['Falsification Criteria', 'Disconfirming Evidence'] }),
    s('Method', 'How it will be tested.', { aliases: ['Approach'] }),
    s('Success Criteria', 'What counts as a positive result, numerically.'),
  ] },
  { kind: 'experiment-plan', title: 'Experiment Plan', owner: 'research-scientist', area: 'research', purpose: 'An experiment designed before it runs, so its result means something.', sections: [
    s('Hypothesis', 'What the experiment tests.'),
    s('Baseline', 'What the new approach is compared against.', { aliases: ['Baselines'] }),
    s('Variables', 'What changes, what is held fixed.'),
    s('Benchmark', 'The dataset, benchmark, or task suite.', { aliases: ['Dataset', 'Benchmark and Dataset'] }),
    s('Metrics', 'Primary and guardrail metrics.'),
    s('Sample Size and Seeds', 'Runs, seeds, and why that is enough power.', { aliases: ['Sample Size', 'Seeds'] }),
    s('Ablations', 'Which components will be removed to see what matters.'),
    s('Stopping Rule', 'When the experiment ends — decided before looking at results.'),
    s('Threats to Validity', 'Leakage, confounders, overfitting to the benchmark.', { aliases: ['Threats'] }),
  ] },
  { kind: 'experiment-results', title: 'Experiment Results', owner: 'research-scientist', area: 'research', purpose: 'What happened, compared honestly with the baseline — failure is a result.', sections: [
    s('Setup', 'What actually ran (commit, config, seeds, hardware).'),
    s('Results', 'The numbers.'),
    s('Baseline Comparison', 'Against the baseline, on the same data.', { aliases: ['Comparison'] }),
    s('Statistical Significance', 'Uncertainty: intervals, tests, variance across seeds.', { aliases: ['Significance', 'Uncertainty'] }),
    s('Ablations', 'What each component contributed — or why none were run.'),
    s('Failure Cases', 'Where it does not work.', { aliases: ['Limitations', 'Failures'] }),
    s('Conclusion', 'Supported, refuted, or inconclusive — and what follows.', { mustMatch: { pattern: /\b(supported|refuted|inconclusive|confirmed|rejected)\b/i, message: 'the conclusion must say whether the hypothesis was supported, refuted, or inconclusive' } }),
    s('Reproduction', 'The exact command(s) that reproduce these numbers.', { aliases: ['Reproducibility', 'How to Reproduce'] }),
  ] },
  { kind: 'benchmark-report', title: 'Benchmark Report', owner: 'research-engineer', area: 'research', purpose: 'A measured comparison anyone can re-run.', sections: [
    s('Benchmark', 'What is measured and why it is representative.'),
    s('Systems Compared', 'Each system and version.', LIST),
    s('Method', 'Hardware, settings, repetitions.'),
    s('Results', 'The numbers, with variance.'),
    s('Reproduction', 'The command(s) that re-run it.', { aliases: ['How to Reproduce'] }),
  ] },
  { kind: 'paper', title: 'Research Paper', owner: 'research-scientist', area: 'research', purpose: 'A finding written up so others can check, reproduce, and build on it — including negative results.', sections: [
    s('Abstract', 'The question, the method, the result, and what it means, in one paragraph.'),
    s('Introduction', 'Why the problem matters and what this work contributes.'),
    s('Related Work', 'What is already known and how this differs.', { aliases: ['Prior Work', 'Background'] }),
    s('Method', 'What was done, precisely enough to reproduce.', { aliases: ['Methods', 'Approach'] }),
    s('Experiments', 'Setup, baselines, datasets or benchmarks, metrics, seeds.', { aliases: ['Experimental Setup', 'Setup'] }),
    s('Results', 'The numbers against the baselines, with uncertainty and ablations.'),
    s('Limitations', 'Where it does not hold, threats to validity, what was not tested.', { aliases: ['Discussion', 'Threats to Validity'] }),
    s('Conclusion', 'What the evidence supports — and what it does not.', { aliases: ['Conclusions'] }),
    s('References', 'Cited work.', { minItems: 1, aliases: ['Bibliography'] }),
  ] },
  { kind: 'feasibility', title: 'Research-to-Production Feasibility', owner: 'applied-researcher', area: 'research', purpose: 'Whether a research result can actually be deployed.', sections: [
    s('Research Result', 'The validated result being productionized.'),
    s('Inference Cost', 'Cost per request / per day at expected volume.', { aliases: ['Cost'] }),
    s('Latency', 'Expected latency against the product budget.'),
    s('Memory', 'Memory and hardware footprint.'),
    s('Reliability', 'Failure behaviour and variance.'),
    s('Scalability', 'Behaviour at 10× and 100× load.'),
    s('Security', 'New attack surface or data exposure.'),
    s('Maintainability', 'Who can maintain it and at what ongoing cost.'),
    s('Licensing', 'Model, data, and code licences.'),
    s('Data Requirements', 'What data it needs and whether we have it.', { aliases: ['Data'] }),
    s('Verdict', 'go | no-go | conditional — and the conditions.', { mustMatch: { pattern: /\b(go|no-go|no go|conditional)\b/i, message: 'the verdict must be go, no-go, or conditional' } }),
  ] },
  // Operations
  { kind: 'slo', title: 'Service Level Objectives', owner: 'sre', area: 'operations', purpose: 'What "reliable enough" means, measurably.', sections: [
    s('Service', 'The service and its users.'),
    s('SLIs', 'The measurements (e.g. successful request percentage, p99 latency).', LIST),
    s('SLOs', 'Targets per SLI over a window, e.g. 99.95% availability over 28 days.', { mustMatch: { pattern: /\d+(?:\.\d+)?\s*%/, message: 'state each SLO target as a percentage' } }),
    s('Error Budget', 'What happens when the budget is spent.'),
    s('Alerting', 'Which burn rates page someone.'),
    s('SLA', 'Contractual commitments, if any — or "No contractual SLA".', { minChars: 4 }),
  ] },
  { kind: 'runbook', title: 'Runbook', owner: 'sre', area: 'operations', purpose: 'What the on-call engineer does at 3am without having to ask.', sections: [
    s('Service', 'What this covers and who owns it.'),
    s('Alerts', 'Each alert this runbook answers.', LIST),
    s('Diagnosis', 'How to find the cause — commands, dashboards, queries.'),
    s('Mitigation', 'How to stop the bleeding.'),
    s('Escalation', 'Who to call and when.'),
    s('Rollback', 'How to revert the last change.'),
  ] },
  { kind: 'incident-report', title: 'Incident Report', owner: 'sre', area: 'operations', purpose: 'The live record of an incident while it is being handled.', sections: [
    s('Summary', 'What is happening.'),
    s('Severity', 'SEV1–SEV4 and why.', { minChars: 4, mustMatch: { pattern: /\bsev\s*-?\s*[1-5]\b|\b(critical|high|medium|low)\b/i, message: 'state the severity (SEV1–SEV4 or critical/high/medium/low)' } }),
    s('Impact', 'Who and what is affected, how badly.'),
    s('Timeline', 'Timestamped events so far.', LIST),
    s('Detection', 'How it was noticed.'),
    s('Current Status', 'Investigating | mitigated | resolved — and the next step.', { aliases: ['Status'] }),
  ] },
  { kind: 'postmortem', title: 'Postmortem', owner: 'sre', area: 'operations', purpose: 'A blameless account of why the system allowed the failure, and what changes so it cannot recur.', sections: [
    s('Summary', 'What happened.'),
    s('Impact', 'Users, duration, data, money.'),
    s('Timeline', 'Detection → mitigation → recovery, timestamped.', LIST),
    s('Root Cause', 'The technical cause.'),
    s('Why It Was Possible', 'The systemic question: why could the system fail this way at all? (e.g. why could the database become a single point of failure?)', { aliases: ['Systemic Cause', 'Contributing Factors', 'Why the System Allowed It'] }),
    s('What Went Well', 'What worked in detection and response.'),
    s('What Went Wrong', 'What made it worse or slower.'),
    s('Action Items', 'Changes to the system, each with an owner — these become follow-up initiatives.', LIST),
  ], warnOn: [{ pattern: /\b(?:fault of|\w+'s fault|(?:his|her|their|my|your) fault|careless|negligen|incompeten|blame[ds]?\b|should have known)/i, message: 'postmortems are blameless — describe what the system allowed, not who erred' }] },
  // Security
  { kind: 'threat-model', title: 'Threat Model', owner: 'security-engineer', area: 'security', purpose: 'What an attacker could do to this design, before it is built.', sections: [
    s('Assets', 'What is worth protecting.'),
    s('Trust Boundaries', 'Where data crosses from less to more trusted.', { aliases: ['Boundaries'] }),
    s('Entry Points', 'Every way input reaches the system.'),
    s('Threats', 'Concrete threats (STRIDE works: spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege).', LIST),
    s('Mitigations', 'The control for each threat.'),
    s('Residual Risk', 'What remains, and who accepts it.'),
  ] },
  { kind: 'security-review', title: 'Security Review', owner: 'security-engineer', area: 'security', purpose: 'Findings from reviewing a change or system for exploitable weaknesses.', sections: [
    s('Scope', 'What was reviewed (commit, paths, design).'),
    s('Method', 'How — code reading, tests, tools.'),
    s('Findings', 'Each finding with severity and a concrete exploit scenario — or "no findings" with what was checked.'),
    s('Verdict', 'approve | changes required', { mustMatch: { pattern: /\b(approve[ds]?|changes required|changes requested|reject(?:ed)?)\b/i, message: 'the verdict must be approve, changes required, or reject' } }),
  ] },
  { kind: 'vulnerability-report', title: 'Vulnerability Report', owner: 'security-engineer', area: 'security', purpose: 'A vulnerability, precisely enough to fix and verify.', sections: [
    s('Summary', 'What is vulnerable.'),
    s('Severity', 'Critical/high/medium/low (CVSS if known) and why.', { mustMatch: { pattern: /\b(critical|high|medium|low)\b|cvss/i, message: 'state the severity' } }),
    s('Affected', 'Components, versions, paths.', { aliases: ['Affected Components'] }),
    s('Reproduction', 'How to demonstrate it, safely.', { aliases: ['Steps to Reproduce'] }),
    s('Impact', 'What an attacker gains.'),
    s('Remediation', 'The fix and how it will be verified.', { aliases: ['Fix'] }),
  ] },
  // Data
  { kind: 'data-contract', title: 'Data Contract', owner: 'data-engineer', area: 'data', purpose: 'What producers promise consumers about a dataset.', sections: [
    s('Producer', 'Who writes the data.'),
    s('Consumers', 'Who depends on it.', { aliases: ['Consumer'] }),
    s('Schema', 'Fields, types, nullability, keys, grain.'),
    s('Semantics', 'What each field means; units; time zones.'),
    s('Quality', 'Checks that must pass (completeness, uniqueness, ranges).', { aliases: ['Quality SLAs', 'Quality Checks'] }),
    s('Freshness', 'How late the data may be.'),
    s('Change Policy', 'How breaking changes are announced and versioned.', { aliases: ['Versioning'] }),
  ] },
  { kind: 'lineage', title: 'Schema and Lineage', owner: 'data-engineer', area: 'data', purpose: 'Where data comes from and where it flows.', sections: [
    s('Sources', 'Upstream systems.', LIST),
    s('Transformations', 'Each step and what it changes.'),
    s('Outputs', 'Tables, features, reports produced.', LIST),
    s('Ownership', 'Who owns each hop.'),
  ] },
  { kind: 'analysis-report', title: 'Analysis Report', owner: 'data-scientist', area: 'data', purpose: 'An answer from data, with its uncertainty.', sections: [
    s('Question', 'The decision this informs.'),
    s('Data', 'Sources, grain, time window, known gaps.'),
    s('Method', 'What was done and why that method.'),
    s('Results', 'Findings with effect sizes and intervals.'),
    s('Limitations', 'What the analysis cannot say — correlation is not causation.'),
    s('Recommendation', 'What to do.'),
  ] },
  // ML / AI
  { kind: 'model-card', title: 'Model Card', owner: 'ml-engineer', area: 'ml', purpose: 'What a model is for, how it was built, and where it fails.', sections: [
    s('Intended Use', 'What it is for and not for.'),
    s('Training Data', 'Dataset versions and known biases.', { aliases: ['Data'] }),
    s('Evaluation', 'Metrics on held-out data, against a baseline.'),
    s('Limitations', 'Known failure modes; performance by group where people are affected.'),
    s('Versioning', 'Model version, registry location, how to roll back.', { aliases: ['Version'] }),
    s('Monitoring', 'Drift and quality signals watched in production.'),
  ] },
  { kind: 'eval-report', title: 'Evaluation Report', owner: 'ai-engineer', area: 'ml', purpose: 'How well an ML/LLM system performs, measured — not demoed.', sections: [
    s('System', 'Model(s), prompts, tools, retrieval — with versions.'),
    s('Eval Set', 'What was evaluated on and why it is representative.', { aliases: ['Dataset', 'Evaluation Set'] }),
    s('Metrics', 'Quality, hallucination, tool errors, latency, tokens, cost.'),
    s('Baseline', 'What it is compared against.'),
    s('Results', 'The numbers, with variance.'),
    s('Failure Analysis', 'Categories of failure with examples.', { aliases: ['Failures', 'Error Analysis'] }),
    s('Decision', 'Ship, iterate, or stop — and why.'),
  ] },
  // UX
  { kind: 'ux-spec', title: 'UX Specification', owner: 'product-designer', area: 'product', purpose: 'How the user interacts with the system, ready to build.', sections: [
    s('User Research', 'What was learned about users and how.', { aliases: ['Research'] }),
    s('Problem Definition', 'The user problem in one statement.', { aliases: ['Problem'] }),
    s('User Flow', 'Steps the user takes.', LIST),
    s('States', 'Loading, empty, error, success for each screen.'),
    s('Accessibility', 'Keyboard, screen reader, contrast, motion requirements.'),
    s('Usability Testing', 'What was tested and what changed — or the plan.', { aliases: ['Usability'] }),
  ] },
  // Planning
  { kind: 'strategy', title: 'Technical Strategy', owner: 'cto', area: 'planning', purpose: 'Where technology is going and what we will not do.', sections: [
    s('Context', 'Company strategy and the current technical position.'),
    s('Direction', 'Where the technology should be in 1–3 years.'),
    s('Bets', 'The investments, with expected payoff.', LIST),
    s('Not Doing', 'What we deliberately will not build or adopt.', { aliases: ['Non-goals'] }),
    s('Risks', 'Technical risks to the strategy.', LIST),
  ] },
  { kind: 'okrs', title: 'Objectives and Key Results', owner: 'cto', area: 'planning', purpose: 'Quarterly objectives with measurable results.', sections: [
    s('Objectives', 'Qualitative goals.', LIST),
    s('Key Results', 'Measurable results with numbers.', { minItems: 1, mustMatch: { pattern: /\d/, message: 'key results must be measurable — include numbers' } }),
    s('Projects', 'Initiatives that move the key results.', LIST),
  ] },
  { kind: 'program-plan', title: 'Program Plan', owner: 'tpm', area: 'planning', purpose: 'How a large cross-team initiative connects.', sections: [
    s('Scope', 'What the program delivers.'),
    s('Workstreams', 'Teams / owners and what each delivers.', LIST),
    s('Milestones', 'Dated milestones.', LIST),
    s('Dependencies', 'Cross-team and external dependencies.', LIST),
    s('Risks', 'Program risks with owners and mitigations.', LIST),
    s('Communication', 'How status moves between teams.'),
  ] },
  // Knowledge
  { kind: 'developer-guide', title: 'Developer Guide', owner: 'technical-writer', area: 'knowledge', purpose: 'Enough for a new engineer to be productive without asking.', sections: [
    s('Overview', 'What the system is.'),
    s('Setup', 'How to get it running locally.'),
    s('Architecture', 'The main components and where they live.'),
    s('Common Tasks', 'How to do the frequent things.', LIST),
    s('Troubleshooting', 'Known problems and fixes.'),
  ] },
]

const BY_KIND = new Map(ARTIFACT_TEMPLATES.map((template) => [template.kind, template]))
export const ARTIFACT_KINDS = ARTIFACT_TEMPLATES.map((template) => template.kind)

export function artifactTemplate(kind: string): ArtifactTemplate {
  const template = BY_KIND.get(kind)
  if (!template) throw new Error(`unknown artifact kind "${kind}" — use one of: ${ARTIFACT_KINDS.join(', ')}`)
  return template
}

export function isArtifactKind(value: unknown): value is string {
  return typeof value === 'string' && BY_KIND.has(value)
}

/** A Markdown skeleton with every required section and its guidance. */
export function renderTemplate(kind: string, title?: string): string {
  const template = artifactTemplate(kind)
  const lines = [`# ${title ?? template.title}`, '', `> ${template.purpose}`, '']
  for (const section of template.sections) lines.push(`## ${section.name}`, '', `<!-- ${section.guidance}${section.minItems ? ' (list at least one item)' : ''} -->`, '')
  return lines.join('\n')
}

export interface ArtifactValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

const PLACEHOLDER = /^(?:tbd|tbc|todo|n\/?a|none|pending|\?+|-+|\.{2,}|…|fill (?:this )?in.*|coming soon|to be (?:decided|determined|written|filled)|lorem ipsum.*)$/i

function normalizeHeading(text: string): string {
  return text.toLowerCase().replace(/[`*_]/g, '').replace(/^\d+(?:\.\d+)*[.)]?\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Splits Markdown into heading → body, ignoring headings inside fenced code. */
export function markdownSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current: string | undefined
  let buffer: string[] = []
  let fenced = false
  const flush = (): void => {
    if (current !== undefined && !sections.has(current)) sections.set(current, buffer.join('\n'))
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? null : /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      current = normalizeHeading(heading[1]!)
      buffer = []
    } else if (current !== undefined) {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

function substantive(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s*/, '').replace(/^\|?[\s:|-]*\|?$/, '').trim())
    .filter((line) => line.length > 0 && !PLACEHOLDER.test(line))
    .join('\n')
}

function listItems(body: string): number {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  const bullets = lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line) && !PLACEHOLDER.test(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())).length
  const tableRows = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|?[\s:|-]+\|?\s*$/.test(line)).length
  return bullets + Math.max(0, tableRows - 1)
}

export function validateArtifact(kind: string, markdown: string): ArtifactValidation {
  const template = artifactTemplate(kind)
  const errors: string[] = []
  const warnings: string[] = []
  if (markdown.trim().length === 0) return { valid: false, errors: ['the artifact is empty'], warnings }
  const sections = markdownSections(markdown)
  for (const spec of template.sections) {
    const names = [spec.name, ...(spec.aliases ?? [])].map(normalizeHeading)
    const key = names.find((name) => sections.has(name))
    if (key === undefined) {
      errors.push(`missing section "${spec.name}" — ${spec.guidance}`)
      continue
    }
    const body = sections.get(key) ?? ''
    const content = substantive(body)
    const minChars = spec.minChars ?? 20
    if (content.length < minChars) {
      errors.push(`section "${spec.name}" is empty or a placeholder (needs at least ${minChars} characters of real content) — ${spec.guidance}`)
      continue
    }
    if (spec.minItems && listItems(body) < spec.minItems) errors.push(`section "${spec.name}" needs at least ${spec.minItems} list item(s) — ${spec.guidance}`)
    if (spec.mustMatch && !spec.mustMatch.pattern.test(content)) errors.push(`section "${spec.name}": ${spec.mustMatch.message}`)
  }
  for (const rule of template.warnOn ?? []) if (rule.pattern.test(markdown)) warnings.push(rule.message)
  return { valid: errors.length === 0, errors, warnings }
}
