# Elia Production-Readiness Audit

## Baseline

Elia is a capable supervised autonomous coding agent with hierarchical lead-to-child delegation, provider failover, specialist roles, durable run journals, a durable goal graph, action approvals, task sessions, verification gates, a hardened native CLI, and 387 passing tests on the current `manus` branch.

The current system is strongest for bounded workspace-scoped coding tasks with executable verification commands. The main production risks are execution durability and operational correctness rather than lack of model capability.

## Highest-risk gaps

| Priority | Gap | Production consequence | First hardening target |
|---|---|---|---|
| P0 | Durable actions and nodes have no lease/heartbeat or stale-running recovery | A killed process can leave work permanently appearing active or prevent safe resume | Add ownership leases, heartbeat, stale-run reconciliation, and explicit recovery states. |
| P0 | Shell timeout kills only the direct child process | A shell command can leave descendants running after timeout or cancellation | Add process-group termination, cancellation-aware kill, bounded output, and timeout evidence. |
| P0 | Task persistence is best-effort direct JSON writing | Concurrent updates or a crash can lose or corrupt operator state | Add atomic task snapshots, versioning, recovery of malformed files, and write serialization. |
| P0 | Browser bridge calls do not have a uniform deadline/cancellation contract | A connector or CDP call can hang an autonomous run indefinitely | Add bounded bridge deadlines, abort propagation, and structured timeout classification. |
| P1 | Retry classification is present but not consistently applied at worker/fleet boundaries | Transient failures may stop a run too early or permanent failures may be retried unsafely | Add explicit retry policy by failure class and idempotency boundary. |
| P1 | Provider health is mostly request-local | A degraded provider can repeatedly incur latency before fallback | Add bounded health state, cooldowns, and route telemetry without changing selected-model semantics. |
| P1 | General external communication actions are not represented by a unified action contract | Email/message-like workflows need consistent recipient, content, approval, and postcondition handling | Add an external-action contract and adapter boundary before adding more connectors. |
| P1 | Evidence and acceptance contracts are not uniformly typed across every tool result | A run can finish with a plausible report but weak proof for subjective or external outcomes | Add typed evidence records for artifact, test, external-state, and human-confirmation outcomes. |
| P2 | Long-running operations lack resource budgets beyond model step counts | Large fleets can consume excessive wall time, child count, output, or provider spend | Add per-run wall-clock, child-count, concurrency, output, and usage budgets. |
| P2 | Production diagnostics are split between terminal output, journal, receipt, task file, and JSONL | Incident reconstruction requires manually correlating multiple artifacts | Add a stable run/event schema and correlation identifiers across all surfaces. |

## Readiness criteria

Elia should not be called production-grade until it can survive process interruption and resume without duplicating completed side effects, terminate timed-out subprocess trees, preserve durable task state atomically, bound every external bridge call, expose machine-readable lifecycle events, distinguish retryable failures from human-review failures, and produce an evidence-backed completion receipt.

The implementation target is not unrestricted autonomy. The target is **bounded, auditable autonomy**: fast execution for reversible work, exact approval for consequential actions, durable recovery after interruption, and a truthful stop when the system cannot prove success.

## Evaluation matrix

| Dimension | Minimum release gate |
|---|---|
| Correctness | Typecheck, unit suite, fixture workflows, and project-specific verification all pass. |
| Durability | Kill/resume tests show completed actions are replayed rather than repeated and incomplete actions are recoverable. |
| Safety | Critical shell/browser/external actions remain blocked or require exact approval; credentials do not enter logs or prompts. |
| Recovery | Timeout, provider outage, child failure, malformed state, and SIGTERM scenarios terminate deterministically and leave resumable state. |
| Observability | JSONL and receipt artifacts correlate run, parent, child, node, action, tool, approval, and evidence identifiers. |
| Performance | Independent work executes in parallel within provider and resource budgets; no unbounded recursive fan-out. |
| Operator control | Pause/cancel/resume/retry states are truthful and do not advertise unsupported controls. |
| Generality | Coding, browser observation, external-action planning, and at least one supervised side-effect workflow have explicit contracts. |
