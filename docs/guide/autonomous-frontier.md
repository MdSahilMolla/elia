# Autonomous-AI frontier for Elia

This is a repository-grounded audit of what would make Elia more distinctive as an autonomous system. It separates **implemented**, **partial**, and **not yet proven** capabilities. It does not claim that no other company or research group is working on these ideas.

## The differentiator to build around

Elia should own the full loop:

> **predict → act → verify now → observe later → resolve the outcome → learn causally → change behavior only when the change survives independent evaluation**

Most agent products stop at tool success, a passing test, or a plausible final answer. Elia already has unusually strong pieces for the last part of this loop: governed actions, durable runs, evidence-gated completion, world-model predictions, benchmarks, lessons, and self-improvement gates. The missing product-level capability is to join them into a **closed-loop outcome system**.

The first two slices are now implemented through `elia outcomes` and autonomous proposals: durable local contracts, delayed checks, evidence, `verified`/`failed`/`inconclusive` states, typed proposal contracts, acceptance-criteria extraction, automatic registration at run completion, and redacted failure artifacts for repeated repair failures. They intentionally support only workspace-local deterministic probes until governed service and external probes are designed.

The repository also now includes a deterministic held-out evaluator (`src/autonomy/evaluation.ts`) that reports Brier score, baseline Brier score, and calibration buckets without allowing development rows to contaminate the held-out result. It is an evaluation primitive, not evidence that Elia has already beaten a baseline; the data collection and independent benchmark remain to be built.

## Battmann mode: current strengths

Battmann is ahead of a typical LLM research mode in several important ways:

- code-fetched feeds and hashed provenance;
- machine-checkable forecast resolution rather than model self-grading;
- statistical baselines and a certified track record;
- evidence-linked claims with figure checks;
- deterministic risk, exposure, alternatives, and consequence calculations;
- append-only audit records and classification controls;
- action proposals that record intent but do not execute external decisions silently.

These are real foundations, not just prompt instructions.

## Battmann flaws and limits

### 1. It measures forecast skill, but does not yet close the decision loop

Battmann can resolve certified questions from feeds, but an analysis does not automatically become a tracked decision with an owner, time horizon, action, outcome, and post-decision impact. The outcome-closure layer should connect:

`forecast → decision → action proposal → human decision → monitored indicator → realized impact → calibration`

Without this, Battmann can be accurate about a question while still being unhelpful or harmful as a decision system.

### 2. The evidence boundary is not global

The Battmann SQLite store has a strong classification boundary, but the repository documentation explicitly notes that other tools can read confidential spreadsheets or data in a cloud-model session. A future secure mode needs a **session-wide information-flow label**, not only a Battmann-store label:

- every input carries a classification;
- every model route has a clearance;
- transformations cannot silently lower classification;
- exported reports inherit the highest relevant classification;
- tool results are checked before they enter the prompt.

### 3. The track record still needs scale and independent comparison

The system has the machinery for Brier scoring and baselines, but a small or self-selected resolved sample cannot establish that Battmann forecasts better than a human, a simple statistical model, or a public forecasting benchmark. The next milestone should be a pre-registered evaluation set with:

- questions opened before the outcome is observable;
- fixed resolution rules;
- public or independently reviewed evidence;
- multiple baselines;
- calibration, sharpness, coverage, and decision-utility metrics;
- a held-out period and a report that Elia cannot edit.

### 4. Causal analysis is mostly structural, not dynamic

The current causality explanation traces evidence-linked ontology paths and applies confidence decay. That is useful provenance, but it is not a validated dynamical causal model. Battmann should label the distinction clearly and add intervention or quasi-experimental analysis where data supports it.

### 5. It is a local analyst, not an always-on intelligence service

The current watcher, scheduler, and autorun are local processes. They are not hosted 24/7 monitoring, do not provide cross-machine leases, and cannot guarantee operation across sleep, reboot, credential expiry, or network partitions. A hosted worker needs durable leases, remote approvals, secret storage, alert delivery, replay, and an operator stop control.

### 6. Forecast ensembles and disagreement are underused

A forecast should expose disagreement between model routes, statistical baselines, prior revisions, and independent analysts. A single synthesized probability can hide fragile assumptions. Add an explicit disagreement report and require the system to identify which evidence would most change the conclusion.

## Elia-wide autonomy flaws

### P0 — completion can still be false after the run ends

Immediate verification does not prove long-horizon correctness. The new outcome-closure foundation addresses this locally, but it is not yet automatically created from every autonomous run and cannot yet inspect services or external systems. Build next:

1. ~~typed outcome contracts in proposals~~ — implemented;
2. ~~automatic contract extraction from declared acceptance criteria~~ — implemented for explicit safe file syntax;
3. governed service-health and deployment probes;
4. delayed probes at multiple horizons;
5. ~~failure records that are retrievable by task signature~~ — redacted recurring-failure artifacts now persist under `.elia/failures/`;
6. replan/escalation policies instead of merely printing a failure.

### P0 — recursive self-improvement is not proven

The repository records that no generation has yet been promoted and that lesson benefit is statistically indistinguishable from zero in the current evidence. Until a generation repeatedly improves an independent held-out benchmark, “recursive intelligence compounding” is a hypothesis, not a demonstrated property.

### P1 — recovery is still too shallow in novel failure states

The open-work tracker identifies regex-only stuck recovery. Novel failures need a bounded model-assisted diagnosis path with a strict cost budget, structured failure taxonomy, and a deterministic fallback. The model must propose recovery; the governor and postconditions must decide whether it is safe.

### P1 — the service lifecycle gap blocks real application autonomy

Elia can run commands and verify exit codes, but it lacks a first-class managed-service primitive that starts a process, waits for readiness, captures logs, scopes network access, and guarantees teardown. This is the bridge from repository automation to autonomous software operation.

### P1 — the autonomy control plane is local

There is no hosted always-on worker, remote approval dashboard, or cross-machine lease model. PID-based ownership is not enough across containers or machines. This limits Elia’s usefulness for production operations and long-running research.

### P1 — memory is not yet causal enough

Lessons and playbooks are useful, but a lesson should be promoted only when an intervention or randomized holdout shows it caused improvement. Failure artifacts, counterfactual alternatives, and environment-specific validity windows should be first-class memory, not only text retrieval.

### P1 — the benchmark does not cover enough real-world outcomes

Repository tasks and synthetic tasks measure coding behavior well, but they do not fully measure browser reliability, service uptime, data quality, decision utility, delayed regressions, or safe refusal under ambiguous authority. Build a multi-domain benchmark with delayed and adversarial scoring.

### P2 — trust evidence is not fully tamper-evident across the whole system

The repository has hash chains and protected stores, but the research notes still identify missing signed tool-call logs. Add signed, replayable action receipts with key rotation and a clear distinction between:

- model-reported claims;
- engine-observed facts;
- externally attested facts;
- human approvals.

### P2 — governance is application-level, not equivalent to a hardened execution boundary

The architecture documentation correctly notes missing kernel-level sandboxing, managed network policy, OS-keyring credential storage, enterprise telemetry, and hosted 24/7 execution. These should be explicit deployment profiles rather than implied safety guarantees.

## What would make Elia genuinely unique

### 1. Outcome-native autonomy

Every meaningful goal gets a lifecycle and an expiry:

`proposed → executing → verified-now → observing → verified-later | contradicted | inconclusive`

The agent cannot claim completion while required observations remain unresolved.

### 2. A causal memory, not a transcript database

Store the intervention, context, alternative considered, action, evidence, delayed outcome, and confidence update. Retrieve “what worked in this environment under these conditions,” not merely similar wording.

### 3. Calibrated autonomy budgets

Spend action, money, time, risk, and attention budgets according to predicted value and uncertainty. Escalate when uncertainty is high, when a probe cannot resolve, or when an action crosses an authority boundary.

### 4. Independent evaluator separation

Keep the generator, verifier, world model, benchmark, and policy core on separate trust boundaries. A candidate must not be able to modify the evidence that judges it. Extend this separation to delayed outcomes and external attestations.

### 5. Safe capability acquisition

When Elia sees a repeated failure or repeated manual sequence, it should propose a new capability, test it in isolation, measure its benefit, and only then promote it. The current manual skill synthesis path should become a governed autonomous pipeline.

### 6. Decision intelligence with accountability

Battmann should not stop at “here is a forecast.” It should show what decision the forecast changes, who owns it, what would falsify it, what is reversible, and when the system will check whether the decision helped.

## Prioritized execution roadmap

| Priority | Work | Why now | Exit evidence |
|---|---|---|---|
| P0 | Typed outcome contracts in autonomous proposals | Makes delayed closure part of normal autonomy, not a manual CLI add-on | Runs with pending/verified-later states; false-completion metric falls |
| P0 | Managed local service probes | Tests real applications without arbitrary shell in the daemon | Start/readiness/teardown tests and bounded health evidence |
| P0 | Failure artifacts and model-assisted stuck recovery | Converts repeated failures into actionable learning | Novel injected failures repaired within budget; no blind retry loops |
| P0 | Held-out recursive-improvement evaluation | Proves or falsifies the core thesis | At least one independently reproduced promoted generation |
| P1 | Session-wide information-flow labels | Prevents Battmann’s strongest boundary from being bypassed by another tool | Cloud route rejects content above clearance across all data tools |
| P1 | Hosted worker, remote approvals, cross-machine leases | Enables durable autonomy beyond one laptop | Restart/network-partition/duplicate-lease test suite |
| P1 | Delayed multi-domain benchmark | Measures outcomes rather than only immediate coding success | External or replayable benchmark with delayed scoring |
| P1 | Automatic governed skill promotion | Lets successful behavior compound safely | Repeated habit → candidate → isolated test → certified tool |
| P2 | Signed, replayable receipts | Establishes durable trust for teams and regulated use | Tamper, key-rotation, and independent verification tests |
| P2 | Battmann decision-utility evaluation | Distinguishes forecast accuracy from useful decisions | Pre-registered utility and calibration report against baselines |

## Bottom line

The most defensible unique position is not “the agent with the most tools.” It is:

> **An autonomous system that knows when its work is still unresolved, keeps observing until the world confirms or contradicts it, learns only from causal evidence, and can prove every important claim independently.**

That is the direction in which the current architecture has the most leverage and the clearest unsolved product gap.
