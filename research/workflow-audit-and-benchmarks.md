# Elia workflow audit and capability benchmarks

## Current workflow bottlenecks

The Bhawanipur recreation test revealed three primary sources of latency and friction in Elia’s autonomous workflow:

1. **Over-detailed planning:** The planner produced an 8-wave, 12-step plan for a single-page recreation. While thorough, this forced many sequential file-edit turns that could have been batched or parallelized more aggressively.
2. **Sequential QA waves:** Polish, verification, and three specialist reviews (critic, security, bughunter) run as separate waves at the end. For a visual recreation, these could be unified or run incrementally as sections complete.
3. **Provider adapter overhead:** The lack of a non-streaming fallback in the OpenAI-compatible adapter caused a fatal error on the first attempt, and the corrected run used a slower model without reasoning-effort tuning.

## Capability gap analysis (Manus & Devin)

| Capability | Elia (Current) | Manus / Devin (Target) | Gap |
| --- | --- | --- | --- |
| **Durable execution** | Persistent goal graph, resumable runs, idempotent actions. | Multi-week, multi-repo, cloud-hosted persistence. | Elia is strong on local durability; needs cloud/background hosting for multi-week tasks. |
| **Computer use** | Delegated read-only browser, local shell, file system. | Full authenticated browser operator, desktop app, My Computer. | Elia needs authenticated browser mutations and a desktop/GUI control bridge. |
| **Parallelism** | Dependency-wave fleets, best-of-N variants. | Parallel cloud agents, "Security Swarm", team of agents. | Elia has the foundation; needs better auto-scaling and swarm-specific roles. |
| **QA & Review** | Adversarial review, bounded self-repair, verification commands. | Visual QA, PR review, automated ticket resolution, incident triage. | Elia needs visual-diff QA, automated PR integration, and incident-response triggers. |
| **Self-evolution** | Benchmark-gated self-evolution, skill synthesis. | Learns tribal knowledge, picks up codebase patterns over time. | Elia is unique in self-evolution; needs better "tribal knowledge" capture from past runs. |

## Optimization targets

1. **Bounded planning:** Limit plan depth for simple tasks; prefer "scaffold + incremental refine" over "big bang" 12-step plans.
2. **Incremental QA:** Run verification and specialist reviews as soon as a dependency-wave completes, rather than waiting for the end of the run.
3. **Visual-diff QA:** Add a dedicated visual-verification tool that compares screenshots of the reference and the recreation.
4. **Fast-path completion:** Allow the lead to skip optional polish/review waves if the core verification commands pass and the goal is met.
5. **Provider tuning:** Add reasoning-effort controls and better streaming/non-streaming fallback logic to the core adapter.
