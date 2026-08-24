# Elia Autonomy Roadmap

## Executive direction

Elia should not try to win by being another agent that can click a browser, edit files, or launch parallel workers. Those capabilities are now visible across Manus, OpenHands, and Browser Use. Manus publicly positions itself as an action engine with browser operation and workflow products [1] [2]. OpenHands emphasizes autonomous end-to-end engineering, dependency-aware parallel work, isolation, and auditability [3]. Browser Use offers browser agents, managed browsers, extraction, checkout, research, and workflow templates [4].

The strongest product direction for Elia is therefore **local-first accountable autonomy**: an agent that can run for a long time, delegate aggressively, recover from interruption, and improve itself, while producing a verifiable action record for every meaningful decision. The differentiator is not merely that Elia finishes a task. It is that Elia can show the user why each action was authorized, what evidence proves completion, what remains uncertain, and how to replay, fork, or undo the work.

> **North star:** Elia is a personal autonomy control plane that turns an outcome into a governed, evidence-backed, resumable execution graph.

## Baseline on the `manus` branch

The branch is already unusually strong for a terminal agent. It has role-typed sub-agents, dependency waves, a shared blackboard, verification and adversarial review, bounded repair, durable lessons, run forking, speculative prefetch, two-tier model routing, benchmark-gated self-evolution, skill synthesis, task sessions, a live task dashboard, and a browser bridge. The baseline test suite passes. The current typecheck is blocked by pre-existing strictness errors in `workspace/chess`, not by the autonomy modules.

The branch still has a structural weakness: safety and execution policy are mostly prompt-level or top-level. The autonomous loop has one proposal approval boundary, but there is no single runtime governor that evaluates every tool call made by the lead, a worker, a repair pass, or a variant. Browser access is top-level only, and the browser tool’s simple keyword guard is not a durable authorization or evidence model. These are the highest-leverage gaps because they limit how unattended the system can safely become.

| Capability | Current state | Strategic assessment |
| --- | --- | --- |
| Planning and delegation | Proposal validation, dependency waves, fleet dispatch | Strong foundation; extend with explicit action budgets and evidence requirements |
| Verification | Commands plus critic, security, and bug-hunt verdicts | Strong; connect verdicts to an auditable run receipt |
| Persistence | Sessions, checkpoints, journals, task sessions | Strong but fragmented; unify into a durable execution graph |
| Browser/computer use | Configurable bridge, CDP, MCP wrapper, task dashboard records | Necessary but crowded; make it policy-governed and evidence-backed |
| Safety | Plan approval and a top-level command risk classifier | Major gap; add a central per-tool action governor |
| Memory | Project/user memory plus lessons and recall | Good start; evolve toward provenance-aware facts with expiry and conflict handling |
| Self-improvement | Benchmark-gated `evolve` and skill synthesis | Rare and valuable; add user-owned success metrics and regression receipts |
| Integrations | Web search/fetch and configurable browser/MCP bridge | Add native connector discovery only after the policy layer exists |

## Differentiated product pillars

### 1. The action passport

Every tool call receives a machine-readable passport containing the actor, role, tool, normalized intent, risk class, authorization source, affected resources, reversibility, and expected evidence. The passport is evaluated before execution, not inferred afterward. Safe actions can flow automatically. Medium-risk actions can be approved in batches. Critical actions are blocked until the exact side effect is approved. This makes unattended mode safer without forcing a confirmation dialog for every file read or test run.

The passport should be deterministic first. An LLM may provide a second opinion for ambiguous commands, but it must never be the only enforcement layer. Unknown tools and malformed inputs fail closed. Approval prompts must be serialized so four concurrent workers cannot create four interleaved terminal questions.

### 2. Evidence-backed completion

A completion claim should be a receipt, not prose. Each autonomous run should end with a compact receipt that records the goal, plan hash, actions taken, verification commands and outputs, review verdicts, changed files, unresolved uncertainty, and a replay/fork pointer. Browser steps should capture a bounded page-state digest or extracted assertion; code steps should capture file hashes and verification output. The receipt should be useful to a human and stable enough for later benchmarking.

### 3. Durable execution graphs

Elia already journals phases and checkpoints. The next layer is a goal graph whose nodes are intent, action, observation, decision, and evidence. A process restart should resume from the last committed node rather than guessing from a transcript. A failed action should be retryable with an idempotency key, and a changed world should invalidate only the affected branch. This is more valuable than simply increasing the step budget.

### 4. Reversible autonomy

Before a write, package install, browser mutation, or external command, Elia should identify an undo route. Code changes should prefer an isolated worktree or checkpoint. Browser mutations should require a clear authorization record and a post-action assertion. If no credible undo route exists, the action is critical by default. The user should be able to ask for “show me what will change,” “pause,” “continue,” or “rewind to before the side effect” without losing the whole run.

### 5. Provenance-aware memory

Lessons are useful, but a future agent also needs to know whether a fact came from a file, a command, a browser page, a user instruction, or a previous model hypothesis; when it was observed; how confident it is; and whether it has expired. The memory roadmap should add provenance, confidence, TTL, and conflict resolution so Elia stops treating old guesses as permanent truth.

### 6. Self-improvement with user-owned fitness

The existing benchmark-gated evolution engine is a major advantage. The next version should let a project define its own fitness signals: fewer repair loops, faster verified completion, lower cost, fewer unnecessary prompts, or stronger security-review scores. A candidate should only be promoted when it improves the selected metric without regressing safety or correctness. This turns Elia from a static agent into an instrumented system that can learn the user’s preferred operating point.

## What to build first

The first implementation slice should be the **Autonomy Governor and Run Receipt**. These two components unlock the rest of the roadmap because they create a trustworthy control plane for browser access, MCP tools, long-running jobs, and future event triggers.

| Priority | Build | Why now | Success criterion |
| --- | --- | --- | --- |
| P0 | Central per-tool action governor | Current safety is split across prompts and special cases | Every tool call is classified and either allowed, approved, or blocked before execution |
| P0 | Redacted action ledger and run receipt | Existing journals are replayable but not yet a concise accountability artifact | A run can answer who acted, what happened, why it was allowed, and what proves success |
| P0 | Autonomous worker browser access with least privilege | Browser is currently top-level only, which prevents true cross-surface delegation | Read-only browser investigation can be delegated; mutations remain governed |
| P1 | Durable goal graph and idempotent retries | Makes restarts and event-triggered work reliable | Restarting a run resumes without duplicating committed side effects |
| P1 | Provenance-aware memory | Prevents stale lessons and guesses from becoming invisible system truth | Recall returns source, timestamp, confidence, and conflict state |
| P1 | MCP connector registry and capability manifests | Expands the tool surface without losing policy control | New connectors declare capabilities and inherit the same governor |
| P2 | User-defined fitness profiles and safe evolution lanes | Compounds Elia’s existing self-improvement advantage | Evolution can optimize a user metric with non-regression gates |
| P2 | Event-driven durable workflows | Turns one-off autonomy into a personal operating layer | A webhook, file change, or schedule can resume a governed goal graph |

## Architecture principles

The governor must sit in the shared agent loop, because that is the only point common to interactive turns, planners, workers, reviewers, repairs, and variants. Tools should remain simple capability implementations. Policy should be orthogonal and composable. The audit layer should record decisions and outcomes without storing raw secrets. The journal remains the source for replay; the receipt is the human-facing summary; the task dashboard is the live view.

The implementation should remain local-first and provider-agnostic. No new hosted control plane is required for the first slice. The same policy interface should work for a shell command, a browser bridge, a synthesized skill, or a future MCP tool. This preserves Elia’s ability to run with different model providers and keeps the most sensitive execution metadata on the user’s machine.

## Immediate implementation scope

This branch will implement the first slice without changing the public model-provider abstraction: a typed action policy, a pre-execution hook in the shared loop, serialized approvals, deterministic risk classification, redacted audit events, and a run receipt generated from autonomous execution. Browser read access will be available to explicitly permitted read-only roles, while side effects remain blocked or approval-gated. The existing plan approval remains, but it will no longer be the only boundary that matters.

## References

[1]: https://manus.im/ "Manus official homepage"

[2]: https://manus.im/features/manus-browser-operator "Manus Browser Operator"

[3]: https://www.openhands.dev/ "OpenHands official platform page"

[4]: https://browser-use.com/ "Browser Use official platform page"
