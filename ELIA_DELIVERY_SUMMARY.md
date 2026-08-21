# Elia Autonomy Upgrade — Delivery Report

## Result

Elia’s existing `manus` branch has been upgraded toward a **local-first, accountable autonomy platform** rather than a generic browser or coding agent. The implementation is committed and pushed to GitHub on branch `manus` at commit `a57a76d` (`Add governed autonomous execution and run receipts`).

The strategic decision was deliberate. Browser control, parallel coding workers, and always-on agent dashboards are already public capabilities across Manus, OpenHands, and Browser Use [1] [2] [3] [4]. Elia’s strongest opportunity is to make autonomy **inspectable, policy-governed, resumable, and self-improving** at the execution layer.

> **North star:** Elia is a personal autonomy control plane that turns an outcome into a governed, evidence-backed, resumable execution graph.

## What was implemented

| Area | Delivered behavior | Main files |
| --- | --- | --- |
| Central autonomy governor | Every tool call is assessed before execution as `safe`, `review`, or `critical`; safe work flows automatically, reversible review work can flow in unattended runs, and irreversible shell/browser actions are blocked or require exact approval. Unknown capabilities fail closed. | `src/autonomy/governor.ts`, `src/agentLoop.ts` |
| Serialized approvals | Concurrent workers cannot interleave terminal approval prompts. Supervised CLI turns and interactive `elia auto` runs can approve the exact action while unattended runs remain safe-only for critical side effects. | `src/autonomy/governor.ts`, `src/index.ts`, `src/agent.ts` |
| Redacted action ledger | Tool events record actor, role, tool, normalized input, result, risk, decision, intent, reversibility, and duration. Credential-like keys and browser text input are redacted. | `src/autonomy/audit.ts`, `src/subagent.ts` |
| Run receipts | Autonomous runs now write `receipt.json` and `receipt.md` alongside their run data, summarizing the goal, proposal, verification evidence, review uncertainty, action counts, blocked actions, and replay pointers. | `src/autonomy/audit.ts`, `src/autonomy/loop.ts` |
| Worker browser observation | Browser access is available to specialist roles for delegated navigation and page inspection. Unattended workers cannot click, type, press keys, submit, publish, purchase, or otherwise mutate browser state. | `src/tools/registry.ts`, `src/autonomy/roles.ts`, `src/autonomy/governor.ts` |
| Context propagation | Parent run IDs and governor policy flow through planners, fleet workers, variants, reviewers, repair passes, and lesson capture, including nested `task` dispatch. | `src/autonomy/loop.ts`, `src/autonomy/fleet.ts`, `src/autonomy/variants.ts`, `src/subagent.ts` |
| Baseline reliability | Fixed pre-existing strict TypeScript errors in the bundled chess workspace so the repository-level typecheck is clean. | `workspace/chess/cli.ts`, `workspace/chess/game.ts`, `workspace/chess/game.test.ts` |
| Product direction | Added a detailed autonomy strategy, differentiated product thesis, implementation priorities, architecture principles, and external capability research notes. | `ELIA_AUTONOMY_ROADMAP.md`, `research/manus-browser-findings.md` |

## Why this is differentiated

Manus publicly describes an action engine with browser operation inside active authenticated sessions and multi-step delegation [1] [2]. OpenHands publicly emphasizes autonomous engineering, dependency-aware orchestration, secure isolation, and auditability [3]. Browser Use publicly offers browser agents, managed browsers, extraction, checkout, research, and workflow templates [4]. These signals suggest that “Elia can browse” or “Elia can parallelize” is not enough to create a defensible product position.

Elia’s differentiating wedge is the **action passport and receipt model**. Before a tool runs, Elia has an explicit assessment of risk, intent, affected resources, reversibility, and authorization. Afterward, the run has a redacted record that can answer who acted, what happened, why it was allowed, what evidence supports completion, and what replay artifacts exist. That design creates a foundation for durable goals, user-owned fitness functions, provenance-aware memory, governed connectors, and event-triggered workflows.

## Validation

The final branch passed all local verification gates:

| Check | Result |
| --- | --- |
| `bun test` | **342 passed, 0 failed** across 44 files and 585 assertions |
| `bun run typecheck` | **Passed** with `tsc --noEmit` |
| `git diff --check` | **Passed** |
| Git branch | `manus` tracking `origin/manus` |
| Git commit | `a57a76d` |

The new tests explicitly cover risk classification, unattended blocking, serialized approvals, browser read-versus-mutation policy, credential redaction, action-ledger persistence, and receipt generation.

## Recommended next stages

The next high-value step is a **durable goal graph**. It should model intent, action, observation, decision, and evidence as typed nodes, attach idempotency keys to side effects, and resume only from committed nodes after process restarts. This would make Elia suitable for long-running work rather than merely long conversations.

After that, build **provenance-aware memory** with source, timestamp, confidence, expiry, and conflict status; then add a governed **MCP connector registry** where each connector publishes its capability and risk manifest before it becomes available to the agent. Finally, let projects define their own evolution fitness profiles, such as repair-loop reduction, lower cost, stronger verification, fewer unnecessary prompts, or better security outcomes.

These stages preserve Elia’s strongest existing advantages—benchmark-gated self-evolution, run forking, multi-model fleets, and learned tools—while extending them into a coherent autonomy control plane.

## Durable execution upgrade

The follow-up implementation adds the next autonomy foundation: a **persistent goal graph** stored at `.elia/runs/<run-id>/goal-graph.json`. The validated proposal becomes a graph with a root goal and dependency-linked step nodes. Each node records status, attempts, files, role, evidence IDs, and a stable node idempotency namespace.

| Durable capability | Behavior |
| --- | --- |
| Persistent graph | Atomic JSON snapshots survive process restarts and preserve proposal nodes, dependencies, actions, evidence, approvals, and failure state. |
| Checkpointed continuation | `elia resume <run-id>` reopens the existing graph, skips completed nodes, and reruns only nodes with unresolved actions or failed verification. Existing journal sequence and checkpoint numbering remain append-only when resumed. |
| Idempotent actions | Tool calls receive stable action identity derived from run, node, tool, and canonical input. Completed actions replay their stored result rather than executing twice. An interrupted in-flight side effect becomes human-review work instead of an automatic duplicate. |
| Resumable approvals | Critical actions create durable redacted approval records. Operators can reconcile pending approvals before continuing, while unattended mode keeps them blocked. |
| Evidence-gated completion | A goal cannot become `completed` until every proposal step is complete, plan approval exists, verification evidence passes, and structured review evidence passes. |
| Failure classification | Failures are categorized as retryable, authorization, environment, human-review, or fatal, allowing the next run to distinguish safe retry from unsafe repetition. |
| Run inspection | `elia runs <run-id>` now shows durable node statuses, attempt counts, and pending approval count in addition to the existing journal timeline. |

The final verification for this pass is **345 tests passing across 45 files**, `bun run typecheck` passing, and `git diff --check` passing. The implementation adds focused tests for dependency readiness, evidence requirements, stable action replay, approval continuation, and failure classification.

## References

[1]: https://manus.im/ "Manus official homepage"

[2]: https://manus.im/features/manus-browser-operator "Manus Browser Operator"

[3]: https://www.openhands.dev/ "OpenHands official platform page"

[4]: https://browser-use.com/ "Browser Use official platform page"
