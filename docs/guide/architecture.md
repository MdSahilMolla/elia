# How it works

[← Back to the README](../../README.md)

## How it works

- **`src/agentLoop.ts`** — the shared core loop: send messages to the active provider, stream text, execute tool calls (in parallel — 8 read-only, 4 if any mutate), feed results back, repeat. Runs read-only tools speculatively the moment their block finishes streaming, and folds a background compaction's summary in at a step boundary. Takes an optional provider (for tier routing), a step budget, a tool-event hook, and a speculative cache. Used by the top-level agent, sub-agents, the planner, and the evolution engine.
- **`src/agent.ts`** — the top-level agent: full tool set (including `task` and `preview`), live streaming, thinking animation, prefetch, and usage accounting.
- **`src/subagent.ts`** + **`src/autonomy/roles.ts`** + **`src/tools/task.ts`** — role-typed sub-agents. The role resolves to a model tier, a tool allowlist, a step budget, and a specialised prompt. Sub-agents can't spawn sub-agents (no role's allowlist contains `task`), which caps recursion at one level.
- **`src/world/`** — the world model, on by default in every run. `runtime.ts` is the half that lives in `agentLoop.ts`: the runtime keeps what is true of the tree (files changed, which check ran against which version of the code and how stale it is now), predicts every action before it runs from what has happened in *this* project, scores the prediction against the outcome, and carries what a project's commands do across sessions in `.elia/world/runtime.json`. It is advisory: it never blocks or rewrites a call, adds no tool definition (those are sent on every call), and says nothing unless it has something true the model may not be holding, in two cases: the same failing check re-run against a tree nothing has touched, and a run of failures the project's record did not expect. Its state is handed back after a compaction, when the turns that knew it are gone. `twin.ts` is the other half: the same predict-then-score discipline applied to elia's own source, so `elia evolve` can price a change before paying for it (see the [compounding guide](compounding.md)). `elia world` shows what has been learned and how well it predicts; `ELIA_WORLD=off` removes it. It also feeds the reasoning layer: `src/reason/plan.ts` chooses how a task is searched using what the runtime half has measured about the project, and scores its own plans against the library it sits over (see [Self-improvement](self-improvement.md)).
- **`src/autonomy/loop.ts`** — the orient → propose → execute → verify → reflect → learn cycle, with durable graph resumption across process boundaries.
- **`src/autonomy/goalGraph.ts`** — atomic goal-graph persistence, dependency-aware node states, stable action idempotency keys, failure classes, resumable approvals, and evidence-gated completion.
- **`src/autonomy/actionContract.ts`** — inferred action contracts with readiness preconditions, exit/artifact/UI postconditions, bounded retry dispositions, idempotency metadata, and takeover escalation.
- **`src/autonomy/scheduler.ts`** + **`src/autonomy/daemon.ts`** — atomic recurring-goal storage, reclaimable leases, background execution bounded to `ELIA_MAX_CONCURRENT_SCHEDULES` due schedules at once (default 4), pause/resume controls, and explicit local-daemon lifecycle.

- **`src/autonomy/proposal.ts`** — the `submit_proposal` tool, plan validation (unknown step ids, duplicate ids, dependency cycles, and missing verification are all rejected with a message the model can act on), and terminal rendering that shows the wave structure and warns about two steps in one wave claiming the same file.
- **`src/autonomy/artifacts.ts`** — secure Markdown plan persistence and bounded artifact lookup under `.elia`; arbitrary filesystem reads are rejected.
- **`src/autonomy/fleet.ts`** — dependency-wave planning and parallel dispatch. Reports `savedMs`: the workers' summed time minus the wall clock actually taken, which keeps the parallelism honest — a "parallel" run that saved nothing means the decomposition was wrong.
- **`src/autonomy/blackboard.ts`** + **`src/tools/blackboard.ts`** — the shared whiteboard. Sub-agents are normally hermetic, so two of them investigating the same repo rediscover the same facts twice; `board_post`/`board_read` turns a parallel fleet into one that cooperates.
- **`src/autonomy/context.ts`** — `AsyncLocalStorage` carrying the current worker's identity, so blackboard posts and action receipts are attributed without threading context through every tool signature.
- **`src/autonomy/governor.ts`** + **`src/autonomy/audit.ts`** — the deterministic per-tool action governor, serialized approval queue, redacted action ledger, and human-readable run receipt.
- **`src/autonomy/verify.ts`** — fail-fast verification runner and the critic's `submit_verdict` tool. The verdict is structured because it drives control flow; "did the model mean yes" is not something to infer from prose.
- **`src/autonomy/journal.ts`** + **`src/autonomy/rewind.ts`** — the append-only run log and phase checkpoints that make forking possible.
- **`src/autonomy/lessons.ts`** — durable, deduplicated, cross-run lessons in `.elia/lessons.md`.
- **`src/speculation/`** — predictive prefetch. `prefetch.ts` follows the edges agents actually read along (grep hits → open them; a module → open its imports) and `cache.ts` holds the results. On top of that, a read-only `tool_use` block is run the moment the model finishes *streaming* it (`streamTurn`'s `onToolBlock`, wired through both provider adapters) — so by the time the turn ends and the real dispatch runs, the disk round-trip is already done. Any mutating tool call invalidates the cache, and a batch mixing reads and writes bypasses it entirely, so the model can never be handed a pre-write snapshot; the worst case of a mid-stream guess is one wasted read. Speculative results show a `⚡` in the tool log.
- **`src/evolve/`** — `suite.ts` (the fitness function), `benchTask.ts` (one task, one child process, cwd already set), `fitness.ts` (scoring and the promotion rules), `sandbox.ts` (isolated copies, the immutable-file guard, transactional promote/rollback), `candidateTools.ts` (sandbox-confined mutation tools), `ledger.ts` (the generation record), `engine.ts` (the loop).
- **`src/bench/latency/`** — the model-free latency benchmark. `scriptedProvider.ts` (a deterministic provider with simulated pacing), `scenarios.ts` (the corpus + its structural invariants), `harness.ts` (runs each scenario through the real loop, medians the runs, measures cold start), `report.ts` (render + baseline comparison), `baseline.json` (committed numbers). `bun test` gates on the structural metrics; `elia bench-latency` is the local tool for wall-clock work.
- **`src/skills/`** — `detector.ts` (free repetition counting), `synthesize.ts` (write + gate a new tool), `loader.ts` (hot-load and quarantine).
- **`src/providers/`** — a small provider abstraction with two adapters: `anthropic.ts` (native Messages API; `buildAnthropicRequest` lays out the four cache breakpoints — stable system + tools on the 1-hour TTL, dynamic system suffix + history tail on the 5-minute default) and `openaiCompatible.ts` (Groq, OpenAI, OpenRouter, Google Gemini, NVIDIA NIM, Mercury, and anything else via `baseURL`). `registry.ts` resolves env vars into a concrete provider; `tryResolveProvider` returns an error instead of exiting so the optional fast tier can degrade silently. `prewarm.ts` opens a pooled connection to every configured model host (deep tier, a distinct fast tier, role overrides) at startup and after a `/model` switch — one unauthenticated `HEAD`, result ignored, deduped per origin — so the first request on each skips DNS, the TLS handshake, and HTTP/2 setup on the path you're waiting on.
- **`src/tools/`** — `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `run_command`, `browser`, `board_post`, `board_read`, `task`, `preview`, plus any synthesized skills.
- **`src/shell.ts`** — one shell implementation shared by the `run_command` tool, verification, and the evolution gate, so all three behave identically.
- **`src/memory.ts`** — loads `ELIA.md` (project, in the cwd) and `~/.elia/ELIA.md` (user, global) into the system prompt at startup.
- **`src/session.ts`** — sessions auto-saved to `.elia/sessions/<id>.json` for `--continue`/`--resume`.
- **`src/ui/`** — `stream.ts` (unbuffered streaming and tool notices), `character.ts` + `animator.ts` (the ASCII character and in-place animator), `streamCursor.ts` (mid-stream blink), `fleetBoard.ts` (the live parallel-worker board), `report.ts` (phase headings and summaries).
- **`src/usage.ts`** — token/time/cost accounting and formatting.
- **`src/preview/`** — localhost-only static server over `workspace/` with WebSocket live-reload, and cross-platform Chrome launching.

Every animated or in-place UI element disables itself when stdout isn't a real terminal, so piped and scripted usage is never polluted with escape codes — the fleet board degrades to one plain line per state change.

## Codex-inspired architecture

Elia adopts several compatible Codex architecture patterns: an explicit bounded turn loop, durable parent/child task state, policy inheritance through the action governor, one-fleet-per-lead delegation limits, structured verification and postconditions, and a separate read-only reviewer context. Repository guidance is loaded from a bounded `AGENTS.md` or higher-priority `AGENTS.override.md` file as project guidance only; it cannot override the user request, system policy, or Elia’s safety gates.

This improves reliability by keeping planning, execution, verification, review, repair, and delivery distinct and observable. It does **not** make Elia identical to Codex: Elia currently has application-level governance rather than Codex-equivalent OS/kernel sandboxing, managed network policy, secure OS-keyring credential storage, enterprise compliance telemetry, or hosted 24/7 execution.

## Testing

```bash
bun test
bun run typecheck
```

The suite covers the tools, session persistence, memory loading, usage accounting, wave planning, proposal validation, the speculative cache, path/import prediction, the promotion rules, habit detection, the blackboard, lessons, provider response parsing, action contracts, scheduler persistence/lease recovery, and environment readiness — all without an API key.

What can't be covered that way is the model loop itself. `elia bench` is the real test for that: it runs actual agent loops against checkable tasks, and it's also what `elia evolve` uses to decide whether a change to elia was an improvement.
