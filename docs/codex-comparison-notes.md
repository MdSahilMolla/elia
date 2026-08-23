# Codex architecture comparison notes

## Sources inspected

- Official repository snapshot: `openai/codex`, commit `c9b19deb09c1841ce7acc33ddb96276030936a29`.
- OpenAI, “Harness engineering: leveraging Codex in an agent-first world”: https://openai.com/index/harness-engineering/
- OpenAI, “Running Codex safely at OpenAI”: https://openai.com/index/running-codex-safely/

## Observed Codex patterns

1. Codex has an explicit turn loop that separates model sampling, tool-call execution, tool results, interruption, compaction, and finalization. It applies bounded rollout/token accounting and reports explicit timeout/cancellation outcomes.
2. Codex separates sandboxing from approval policy. The sandbox is the technical boundary for writable paths, protected paths, and network access; approval policy determines when an action must pause for authorization. This is stronger than relying on a classifier alone.
3. Codex uses explicit execution-policy rules with fail-closed or heuristic fallback decisions, policy overlays/inheritance, and structured command/network matching.
4. Codex’s reviewer/auto-review path uses a separate read-only reviewer context with downgraded permissions, cleared connectors/hooks/features, and explicit timeout/abort handling. Reviewer state is reused only when parent configuration/history remains compatible.
5. Codex multi-agent spawning persists parent/child relationships, bounds concurrency using spawn slots, inherits execution policy and environment intentionally, and sanitizes forked child history/instructions.
6. OpenAI’s harness-engineering article treats repository knowledge as a versioned system of record. It uses short entry-point instructions, progressive disclosure into deeper docs, first-class execution plans, quality/reliability/security docs, and automated doc-gardening/validation.
7. OpenAI’s safety article emphasizes that unattended autonomy should keep low-risk work moving while requiring explicit authorization for higher-risk actions, restricting outbound network access, storing credentials securely, and exporting agent-native audit events explaining intent and decisions.

## Elia comparison

Elia already has a durable agent loop, wall-clock/step/action budgets, goal graphs, receipts, cancellation propagation, bounded parallel tools, explicit critical-action blocking, worktree variants, verification, repair, polish, lessons, and role-based read-only reviewers. The most compatible Codex-inspired improvement is to make reviewer sessions explicitly read-only at the tool-set level, rather than merely relying on reviewer role intent; this was implemented in `src/autonomy/loop.ts` using a restricted reviewer tool set.

Elia also had a documented one-fleet-per-lead intent but no runtime enforcement. A bounded one-fleet-per-lead guard and child metadata limits were added to `src/tools/delegate.ts`, complementing the existing depth and per-call child limits.

Elia does not yet provide Codex-equivalent OS-level sandboxing, managed network policy, secure OS-keyring credential storage, or enterprise telemetry. These must not be claimed as implemented. Elia’s current governor and contracts are application-level controls, not a substitute for a kernel/OS sandbox. Future work should prioritize an optional host/container sandbox adapter, explicit network policy, and structured OpenTelemetry-compatible action events, while preserving approval barriers for consequential actions.
