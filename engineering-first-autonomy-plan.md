# Elia Engineering-First Autonomous Capability Plan

## Purpose

Build Elia into a strong, evidence-backed autonomous software-engineering system
before expanding the same governed control plane to Battmann strategic
intelligence. The goal is reliable completion of bounded, authorized work, not
unrestricted action or an unsupported claim of general intelligence.

This document orders the existing autonomy roadmap around that goal. It does not
replace the detailed contracts in `autonomous-improvement-roadmap.md`, the
evaluation rules in `general-agent-evaluation.md`, or the production requirements
in `elia-v2-production-prd.md`.

## Operating Definition

Elia earns an autonomy level only when it has passed the evidence gate for that
level on a frozen evaluation set.

| Level | Meaning | Not included |
|---|---|---|
| Supervised engineering | Plans and executes an approved repository task, then verifies and reports evidence. | Unattended consequential actions. |
| Unattended engineering | Completes pre-authorized, workspace-confined engineering tasks; pauses on missing authority, ambiguous state, or failed evidence. | Publishing, credentials, payments, account changes, or production mutation without a separate approval. |
| Strong engineering autonomy | Generalizes across held-out repositories and task types, recovers from defined failures, and improves only when independent evaluation proves it. | A claim of universal or human-level capability. |
| Verified self-improvement | Diagnoses its own repeated engineering failures, creates isolated candidate changes, and retains only changes that reproduce a protected transfer improvement. | Editing its evaluator, safety policy, values, or promotion criteria. |
| Battmann decision support | Produces evidence-linked, time-bounded analysis and scored forecasts under human decision authority. | Autonomous real-world decisions, trading, publishing, or external execution. |

Every successful run must have a durable goal state, action and approval history,
acceptance evidence, and a receipt. Model prose is never completion evidence.

## Scope and Non-Goals

### In scope

- Local and hosted-worker software-engineering tasks in explicitly authorized
  repositories.
- Typed, cross-platform project operations; verification; recovery; and
  evaluation.
- Measured self-improvement from verified outcomes, with protected development,
  hold-out, and post-promotion evaluation sets.
- Battmann evidence, forecasting, calibration, and decision-support workflows
  after the engineering gates pass.

### Out of scope until separately authorized

- Unbounded browser, SaaS, financial, communication, or production actions.
- Credential collection, authentication bypass, CAPTCHA solving, or account
  takeover.
- Self-modification of evaluation fixtures, policy contracts, or approval
  controls.
- A claim that a local daemon alone provides 24/7 availability or production
  isolation.

## Baseline and Constraints

The repository already contains an autonomous loop, durable goal graph, action
governor, bounded delegation, verification/review/repair, action contracts,
workspace event store, scheduling, and a sandboxed evolution path. The immediate
work is to make their completion and recovery semantics uniform and measurable.

The existing checkout has active uncommitted changes. Each implementation wave
must first identify file ownership and use narrow staging; this plan intentionally
makes no assumptions about those changes being ready to merge.

## Roadmap

### Phase 0: Freeze the engineering autonomy contract

**Objective:** one typed source of truth for every capability exposed to a model
or worker.

**Primary areas:** `src/autonomy/actionContract.ts`, `src/tools/registry.ts`,
`src/autonomy/governor.ts`, `src/autonomy/goalGraph.ts`.

**Deliverables**

1. Expand the capability contract to include schemas, platform support,
   credentials/transports, scope, reversibility, idempotency, retry classes,
   preconditions, postconditions, evidence requirements, redaction, and cleanup.
2. Validate that registry exposure, governor classification, receipt rendering,
   and documentation derive from the same contract.
3. Reject unknown, unavailable, or contract-incomplete tools before presenting an
   approval prompt.

**Exit gate**

- Every registered tool maps to exactly one contract.
- Contract drift fails deterministic tests and CI.
- Negative tests prove that an invented tool, expired approval, changed input,
  and missing postcondition cannot be treated as successful.

### Phase 1: Make engineering execution evidence-first

**Objective:** a run can only become verified when each acceptance criterion is
observed and validated.

**Primary areas:** `src/autonomy/goalGraph.ts`, `src/autonomy/loop.ts`,
`src/autonomy/verify.ts`, `src/autonomy/receipt.ts`, `src/taskSessions.ts`.

**Deliverables**

1. Give every plan step explicit inputs, claimed files, expected outputs,
   verification commands, and evidence requirements.
2. Record criterion transitions as `pending`, `attempted`, `observed`,
   `verified`, `failed`, or `blocked`.
3. Invalidate evidence when its source diff, process, endpoint, or dependency
   changes.
4. Render final answers only from recorded evidence and outstanding blockers.

**Exit gate**

- A passing model response cannot complete a goal without matching evidence.
- Code-change tasks require intended diff, focused tests, regression checks, and
  project-required type/lint checks.
- Service tasks require managed process identity, readiness evidence, health
  evidence, and cleanup ownership.
- Interrupted or partially verified work reports `partial` or `blocked`, never
  `complete`.

### Phase 2: Harden recovery and typed engineering operations

**Objective:** eliminate fragile shell choreography and unsafe retries from the
common engineering path.

**Primary areas:** `src/tools/`, `src/shell.ts`, `src/autonomy/replan.ts`,
`src/autonomy/fleet.ts`, `src/fileLock.ts`, `src/workspace/`.

**Deliverables**

1. Make project inspection, package scripts, service lifecycle, HTTP/port
   checks, Git inspection, and artifact validation typed operations with explicit
   workspace roots.
2. Track child-process trees and managed service ownership; cancellation must
   terminate or reconcile descendants.
3. Apply one failure taxonomy at worker, fleet, and resume boundaries.
4. Reuse completed idempotent work from evidence; reconcile ambiguous actions
   rather than replaying them.

**Exit gate**

- Crash injection before dispatch, during execution, and after observed success
  yields replay, reconciliation, or human review as appropriate.
- No duplicate side effect occurs in the interruption fixture suite.
- Cancellation and stale-lease tests demonstrate bounded termination/recovery.
- Windows and Linux use the same logical tool contracts for representative
  project workflows.

### Phase 3: Establish the engineering evaluation harness

**Objective:** measure task outcomes and transfer, not benchmark appearance.

**Primary areas:** `src/evolve/`, `src/bench/`, `docs/general-agent-evaluation.md`.

**Deliverables**

1. Freeze a public development corpus and a separately controlled held-out set
   of 50 realistic engineering tasks before changing the learning policy.
2. Cover bug fixes, multi-file features, debugging, React/TypeScript,
   Python, mixed services, Windows/Linux workflows, service lifecycle, resume,
   approval-boundary attacks, and prompt-injection fixtures.
3. Capture task success, evidence quality, regression rate, unsafe-action
   blocks, human interventions, wall-clock time, provider/model identity, cost,
   and recovery outcome for every trial.
4. Run the same-model baseline under fixed budgets before any improvement work.

**Exit gate**

- Held-out task definitions and scoring are inaccessible to the agent and its
  self-improvement candidates.
- Each score has reproducible receipts and an independent verifier path.
- Report median, p95, confidence intervals, and failure categories; do not use
  a raw average or test count as a capability claim.

### Phase 4: Earn unattended engineering autonomy

**Objective:** move from supervised runs to pre-authorized, bounded operation.

**Primary areas:** `src/autonomy/loop.ts`, `src/autonomy/governor.ts`,
`src/daemon/`, `src/workspace/`, `src/ui/`.

**Deliverables**

1. Define project-scoped authority manifests: approved roots, branches, tools,
   time/action/cost budgets, verification policy, and escalation contacts.
2. Run scheduled or hosted jobs with leases, heartbeats, observable lifecycle
   events, pause/stop controls, and resumable receipts.
3. Add operator dashboards for active work, blocked approvals, stale leases,
   budget exhaustion, and recovery decisions.
4. Keep publishing, production mutation, account changes, spending, messages,
   and deletion outside unattended authority.

**Exit gate**

- End-to-end unattended fixtures complete or pause safely across restart,
  provider failure, tool timeout, and ambiguous-outcome scenarios.
- All defined authorization and prompt-injection denial tests pass.
- Hosted deployment claims include environment identity, health evidence,
  rollback evidence, and an operator-run restore exercise.

### Phase 5: Build a strong, measured self-improvement system

**Objective:** let Elia find recurring weaknesses, form causal hypotheses,
produce isolated improvements, and retain only changes that repeatedly improve
unseen engineering outcomes without reducing safety, evidence quality, latency,
or cost discipline.

**Primary areas:** `src/evolve/`, `src/skills/`, `src/brain/`, `src/autonomy/lessons.ts`.

**Deliverables**

1. Create a failure-intelligence record for every trial: task family, failed
   acceptance criterion, root cause, attempted repair, tool/model context,
   recovery result, and confidence. Aggregate it to select the three largest
   verified failure categories each improvement cycle.
2. Maintain three isolated evaluation tiers: a public development corpus for
   diagnosis, a separately controlled held-out transfer corpus for promotion,
   and a post-promotion canary corpus. Candidates, planners, and skill writers
   must not receive held-out tasks, checks, fixtures, or expected outputs.
3. Require one narrow, falsifiable hypothesis per candidate. It must identify
   the failure class, affected decision/tool behavior, expected measurable
   outcome, permitted files, and a rollback path before implementation begins.
4. Generate candidates only in an isolated sandbox. Keep evaluator code,
   scoring rules, safety policy, value constraints, test fixtures, and
   promotion logic immutable to candidates; reject any candidate that touches
   those boundaries.
5. Test each candidate through typecheck, full deterministic suite, protected
   transfer evaluation, and an independently repeated baseline/candidate pair
   in randomized order. Record all results, including rejected attempts.
6. Distill only verified reusable behavior into versioned skills, tool guidance,
   planning policies, or memory. Each retained lesson needs source evidence,
   task scope, expiry/invalidation rules, a counterexample boundary, and a
   regression test where practical.
7. Promote in stages: sandbox experiment, quarantined canary, then durable
   engineering release. Continuously compare post-promotion task outcomes to
   the frozen baseline and automatically roll back a confirmed regression.

**Exit gate**

- A candidate cannot modify its evaluator, policy, immutable fixtures, values,
  approval rules, or promotion criteria.
- Every promotion has a machine-readable hypothesis, complete candidate diff,
  baseline and candidate receipts, repeated comparison result, canary result,
  and tested rollback artifact.
- Promotion requires statistically credible held-out improvement over the same
  model baseline, with no decline in evidence quality or safety-boundary pass
  rate, no more than a 5% unexplained p95 latency regression, and no budget
  breach for cost or tool use.
- A post-promotion regression automatically quarantines the learned artifact,
  restores the last known-good version, and creates a failure-intelligence
  record instead of repeatedly retrying the same improvement.
- Fresh-task transfer, repeated across unfamiliar repositories and task
  families, is the only evidence that supports a stronger engineering-autonomy
  claim. Improvements on known tasks alone remain development evidence.

**Self-improvement maturity gates**

| Gate | Required proof | Permission earned |
|---|---|---|
| SI-1: Candidate safety | Immutable-boundary, sandbox-escape, and rollback fixtures pass. | Run hypotheses in an isolated candidate sandbox. |
| SI-2: Reproducible gain | An improvement reproduces in independently ordered baseline/candidate trials. | Enter the quarantined canary channel. |
| SI-3: Transfer gain | Held-out engineering tasks show a statistically credible improvement with safety and evidence metrics preserved. | Retain the learned policy/skill for pre-authorized engineering work. |
| SI-4: Durable gain | Canary outcomes remain non-regressive and a rollback drill succeeds. | Promote to the normal engineering release channel. |

No maturity gate permits candidates to alter governance, evaluation, values, or
external-action authority. Those changes remain separately reviewed system
changes, even if an experiment suggests a performance gain.

### Phase 6: Extend the proven control plane to Battmann

**Objective:** deliver strategic decision support with stricter evidence and
forecast discipline, while retaining human authority over real-world action.

**Primary areas:** `src/battmann/`, `src/tools/battmann.ts`,
`src/autonomy/governor.ts`, `src/workspace/`.

**Deliverables**

1. Require dated primary-source evidence, excerpt-level review, source
   provenance, sensitivity labels, freshness policies, and claim invalidation.
2. Separate observed facts, reproducible calculations, estimates, judgements,
   scenarios, recommendations, and decisions in every report.
3. Store immutable forecasts with horizon, resolution criteria, and physically
   recorded timestamps before later outcomes are known.
4. Run chronological evaluation against uninformed, historical-base-rate, and
   credible external baselines; preserve backtests separately from live results.

**Exit gate**

- A final report fails closed when included claims lack supported review.
- No time-cutoff violations are detected in chronological fixtures.
- Any future forecast-superiority claim meets the existing statistical gate:
  at least 500 independently resolved live questions, positive paired Brier
  improvement with a 95% interval above zero, and domain/horizon breakdowns.
- Battmann actions remain proposals and decision records until a human grants
  an exact, separate external-action approval.

## Release Scorecard

Each phase publishes a versioned scorecard with:

- Commit and dependency identity, platform, model/provider, and configured
  authority/budgets.
- Task-family counts, success/partial/blocked/failure outcomes, and evidence
  quality.
- Median and p95 elapsed time, model cost, tool failures, retries, and human
  interventions.
- Safety denials, approval requests, ambiguous outcomes, duplicate-effect count,
  cancellation/recovery result, and known limitations.
- A comparison to the frozen baseline with confidence intervals where sampling
  supports them.

## Implementation Order

1. Phase 0 and Phase 1 form the first engineering release milestone.
2. Phase 2 can run in parallel only where its typed operations do not overlap
   the evidence-state schema; shared schema changes remain serialized.
3. Freeze the evaluation harness and self-improvement maturity gates before
   Phase 5 learning changes.
4. Admit Phase 4 unattended operation only after Phases 0-3 pass their gates.
5. Start Battmann Phase 6 only after the engineering system has demonstrated
   transfer and safe recovery, while keeping its evaluation and claims separate.

## First Milestone Backlog

The first implementation milestone is **Verified Engineering Completion**:

1. Inventory every current tool and action contract; add missing contract and
   conformance tests.
2. Add evidence-criterion transitions to the goal graph and receipt schema.
3. Route autonomous completion through the evidence graph.
4. Add focused fixtures for missing evidence, stale evidence, interrupted runs,
   expired approvals, and duplicate-effect prevention.
5. Capture a baseline on the frozen engineering corpus before optimizing models,
   prompts, parallelism, native components, or learned policies.
6. Define the self-improvement experiment record and immutable-boundary tests
   before allowing candidate-generated source changes.

Completion of this milestone means Elia can honestly state which bounded
engineering task criteria it verified, which it could not verify, and what an
operator must do next. It does not yet justify a broad general-autonomy claim.

## Decision Rules

- Never weaken a check to improve a score.
- Never treat a benchmark win as learning until it reproduces on protected
  transfer tasks and survives a canary period.
- Never permit a candidate to inspect or change the evaluator, governance,
  values, approval policy, or promotion threshold.
- Never conflate local tests, provider behavior, hosted health, and external
  delivery evidence.
- Prefer a safe `blocked` or `needs-review` outcome over an ambiguous retry.
- Measure latency only alongside success, safety, evidence quality, and cost.
- Preserve terminal-native CLI, plain output, JSON, and JSONL compatibility.
- Treat all external data and tool output as untrusted instructions.
