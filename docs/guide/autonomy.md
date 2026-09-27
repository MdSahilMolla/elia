# Autonomous work

[← Back to the README](../../README.md)

## Autonomous work: `elia auto`

For plan-first work inside a session, `/plan <goal>` (or shift+tab into plan mode) has elia research the task read-only and propose a plan without changing anything; Enter runs it, Esc keeps planning. `elia auto "<goal>"` is the full structured workflow: orient, submit a validated proposal, persist it to `.elia/artifacts/plan.md` and `.elia/runs/<run-id>/plan.md`, request approval, execute dependency waves, verify, and review. `/artifact [name]` displays a saved plan artifact under `.elia`.

```bash
elia auto "add rate limiting to the API client"
elia auto "migrate the config loader to zod" --yolo   # skip the approval gate
elia auto "fix the race condition in the queue" --variants 3   # best-of-3, see below
```

This runs a full work cycle instead of a single conversation turn. Each phase has its own tool set and its own prompt, so elia is never simultaneously exploring and committing:

1. **Orient** — reads the project, then sends several read-only *scouts* out in parallel on the fast tier to answer specific questions. Recon is the part of a task that parallelises best and matters least which model does it.
2. **Propose** — submits a structured plan: what it found (with real file paths), what it's assuming, the steps decomposed into dependency waves, the risks, and the exact commands that will prove the work is correct. **Nothing has been changed at this point.** You approve it, reject it, or type what to change and it re-plans. A plan with no verification command is rejected before you ever see it.
3. **Execute** — runs the steps in dependency waves: everything in a wave goes at once, each wave waits for the last. Steps that claim the same file are automatically split into separate waves, even if the planner forgot to declare a dependency. The planner assigns *frontend* and *backend* specialists to their respective steps so UI work and server work genuinely run side by side instead of one generalist doing both serially. A live status board shows every worker, its role, and what it's doing. Workers publish findings to a shared blackboard as they go, so the second wave inherits what the first learned. Every tool call is checked by the autonomy governor before it runs: safe work flows, reversible review work can flow in unattended mode, and irreversible shell/browser actions are blocked or require exact approval.
4. **Verify** — runs your verification commands, fail-fast. If they pass, three specialist reviewers run concurrently against the same diff: a *critic* (was what was promised actually done), a *security* reviewer (exploitable weaknesses), and a *bughunter* (functional/logic defects). Their verdicts are merged — any one voting "revise" blocks — so review runs at the speed of the slowest single reviewer instead of three run one after another.
5. **Reflect** — on failure, feeds the actual error back into a repair pass and re-verifies. Bounded retries, then it stops and says a human is needed rather than thrashing.
6. **Learn** — appends durable, project-specific lessons to `.elia/lessons.md`, which is injected into the *next* run's planning. Elia gets better at your project over time instead of rediscovering it every session.

### Roles

The `task` tool takes a `role`, and the role decides three things before a token is generated: which model tier runs it, which tools exist at all, and what the worker optimises for.

| Role | Tier | Can write? | For |
|---|---|---|---|
| `scout` | fast | no | read-only investigation; run several in parallel |
| `builder` | deep | yes | making the actual changes |
| `frontend` | deep | yes | UI/component/styling/client-side changes; may coordinate a bounded child fleet |
| `backend` | deep | yes | API/business-logic/data changes; may coordinate a bounded child fleet |
| `designer` | fast | no | page structure, visual direction, responsive behavior, and interaction specifications |
| `accessibility` | fast | no | semantics, keyboard flow, contrast, focus, responsive behavior, and assistive-technology review |
| `critic` | deep | no | adversarial review of work already done — was it actually done as promised |
| `security` | deep | no | adversarial review for exploitable security weaknesses, run alongside `critic` and `bughunter` |
| `bughunter` | deep | no | adversarial review for functional/logic bugs, run alongside `critic` and `security` |
| `tester` | deep | yes | writing and running tests, diagnosing failures |
| `scribe` | fast | yes | docs and comments only |

A scout physically cannot damage your tree — `write_file` and `edit_file` aren't in its tool set — so aggressive parallel recon carries no risk.

### Hierarchical coding delegation

Coding leads use a bounded `delegate_tasks` capability when a task is large enough to benefit from specialist decomposition. A frontend lead developing an initial landing page can delegate a design brief, frontend implementation, accessibility review, and test/documentation work as separate child assignments. The scheduler runs independent assignments in parallel, serializes declared dependencies and file collisions, passes completed-wave reports into later waves, and keeps every worker in the same governed working directory.

The hierarchy is deliberately bounded rather than recursively open-ended. A lead can create at most four child assignments in one delegation call, and child workers run at depth one without any further delegation capability. Child workers inherit the parent run’s cancellation signal, autonomy governor, provider fallback behavior, shared blackboard, durable goal graph, and working directory. Their reports and progress appear in the task dashboard with role, depth, and parent lineage, while the durable graph records child nodes and action idempotency keys.

Delegation is not a substitute for verification. The lead remains responsible for integrating reports, resolving conflicts, running the project’s tests and type checks, and satisfying the autonomous run’s final critic, security, bughunter, verification, and approval gates. If a child fails, the failure is returned explicitly to the lead instead of being silently treated as success.

### Best-of-N: `--variants N`

`--variants N` runs the *execute* phase N times in parallel, each in its own isolated git worktree — genuinely independent implementation attempts of the same approved plan, not N copies hoping for different random output. Verification (typecheck/tests/build — an objective, cheap, non-LLM oracle) picks the winner: an attempt that fails verification can never win over one that passes, no matter how confident its own report sounds. Only the winning worktree's files are copied into your real working tree; every worktree, winner included, is discarded afterward, so you're never left with stray branches or directories. If every attempt fails verification, it falls back to the first one and hands off to the normal reflect/repair loop exactly as a single-attempt run would.

It deliberately skips the critic/security/bughunter panel per variant — paying for three reviewers on N-1 attempts that get thrown away regardless would be pure waste. That panel still runs once, on the merged winner, exactly as it does without `--variants`.

Cost is roughly Nx the execute phase (N parallel builder fleets instead of one) for the same wall-clock time, so it's opt-in — default is 1, today's behavior, unchanged. Worth it when an implementation approach is genuinely uncertain and you'd rather spend tokens than guess wrong; not worth it for a change whose shape is already obvious.

## Time travel: `elia runs` / `elia fork`

Every autonomous run journals its phases, checkpoints the exact message history each one started from, and persists `.elia/runs/<id>/goal-graph.json` with the proposal nodes, dependencies, action reservations, approvals, and evidence required for completion.

```bash
elia runs                 # list runs
elia runs <id>            # timeline + forkable decision points
elia fork <id> --at 1 --with "use a token bucket instead of a fixed window"
```

A fork replays the investigation that was already correct — for free — and only re-takes the decision. Normally exploring "what if the plan had been different" means paying for the whole run again. The original run is untouched; the fork gets its own id, so you can compare them. `elia resume <id>` is different: it continues the same durable graph, skips completed nodes, reopens only nodes with unresolved actions, and reconciles stale execution leases plus pending plan or side-effect approvals before continuing. `elia runs` includes a recovered-node count, while `elia runs <id>` shows the graph, timeline, verification evidence, and receipt-oriented diagnostics.

## Self-supervised execution and polish

For a fully autonomous run, use `--autonomous` (an alias for `--yolo`):

```bash
elia auto "improve the authentication flow and make the tests pass" --autonomous
```

Elia will orient itself, run a read-only environment preflight, propose a plan internally, delegate independent work, execute the plan, run verification commands, repair failures, and perform a bounded final quality pass before reporting completion. The polish pass is conservative: it can improve concrete rough edges, tests, documentation, and error handling, but it may leave the tree unchanged when no safe improvement is justified. Use `--no-polish` only when a task explicitly requires the older execution path. External side effects such as purchases, publishing, deletion, sending messages, or subscription changes still require explicit confirmation.

## Production hardening and supervised operation

Autonomous runs are durable rather than process-local. Elia persists a versioned goal graph, append-only journal, action ledger, checkpoints, proposal contracts, verification evidence, and a redacted receipt under `.elia/runs/<run-id>/`. Node and action execution uses expiring leases with heartbeat renewal; when a process is interrupted, opening the run reconciles stale leases into retryable or human-review states instead of silently duplicating work. `elia resume <run-id>` reports any recovered stale nodes or actions before continuing.

The completion assessor records whether a run is `verified`, `partial`, `blocked`, `failed`, or `aborted`, with confidence, evidence, blockers, and next actions. A model saying “done” is not treated as proof, and a run requested as completed is downgraded to `needs-attention` if the durable graph cannot prove completion. Every autonomous run now has a parent task session linked from its receipt and journal; child workers preserve acceptance criteria, verification commands, evidence, blocker reasons, and retry/takeover guidance in the live dashboard.

Tool execution is bounded and cancellable end to end. Shell commands run in process groups, terminate descendants on timeout or operator cancellation, and cap captured output. Browser bridge, CDP, and provider requests have deadlines; provider retries are disabled at the transport boundary so the agent-level fallback policy remains visible and bounded. Set a default wall-clock budget with `ELIA_MAX_RUN_MS`, or override it per invocation with `elia auto "<goal>" --max-run-ms 900000`. Autonomous profiles also impose finite governed-tool budgets (fast 120, balanced 300, thorough 600 by default); override a direct run with `--max-actions N`. When a tool request would exceed the budget, Elia records the blocked request, stops claiming success, and leaves an actionable `needs-attention` recovery state rather than retrying indefinitely. Budget use, token usage, recovery counts, verification results, and action failure classes are included in the run receipt.

Every delegated plan and proposal may declare `acceptanceCriteria`, `verificationCommands`, `sideEffects`, and `recovery`. These fields are persisted and shown for approval. Plans are bounded to 32 work steps and 16 verification commands; oversized goals receive split-and-resume guidance instead of creating an unmanageable unattended run. Verification commands are checked by the same autonomy governor as ordinary shell actions; credential reads and outbound data writes are critical and fail closed when unattended. Structured JSONL events, `--plain`, `--quiet`, `--verbose`, and `--json` modes make long-running and CI execution observable without changing the underlying model prompt or its raw generation behavior.

For specialist work, `elia agent "<request>" --dry-run` performs routing only and prints the selected persona chain and rationale without running specialist tools or side effects. Use this to inspect an execution plan before allowing a full specialist turn.

## Background autonomy and safe unattended actions

Elia now has a local, durable background control plane for recurring AI goals. **Autonomous work is supervised by default**: the plan requires an operator decision, and review or critical tool actions require an approval boundary. Use `--supervised` or `ELIA_SUPERVISION=supervised` to make that intent explicit. `--unattended`, `--yolo`, and `--autonomous` are opt-in exceptions; unattended mode still blocks critical actions and never treats the absence of a prompt as permission for publishing, sending, purchasing, authentication, destructive changes, or other irreversible effects.

Operators can inspect or stop a durable run from another terminal without touching its process directly:

```bash
elia control status
elia control pause <run-id>
elia control stop <run-id>
elia resume <run-id>             # only after reviewing the receipt and blockers
```

Pause and stop requests are written atomically under the run directory, validated against a safe run-ID format, picked up by the owning process at a bounded polling interval, recorded in the run journal, and propagated to the internal abort signal. `Ctrl+C`, the `/task` dashboard’s `c` control, wall-clock budgets, and governed action budgets remain additional stop boundaries. A stopped run is reported as paused/aborted rather than falsely completed.

For one-off safe work, `elia auto "<goal>" --unattended` runs the plan without routine interactive prompts; it still uses the autonomy governor and stops at consequential actions. Create a schedule, inspect it, pause or resume it, and run due work through the daemon, which runs up to `ELIA_MAX_CONCURRENT_SCHEDULES` (default 4) concurrently-due schedules per poll rather than waiting for each in turn:

```bash
elia schedule add --every 1h --max-actions 300 --title "Repository health" "Inspect the repository, run the declared checks, and report only evidence-backed findings"
elia schedule list
elia daemon --once
elia daemon --poll-ms 30000
```

Schedules are stored atomically in `.elia/schedules.json`. Each claimed run has a lease, a bounded wall-clock budget, an optional finite action-count budget (`--max-actions`, capped at 10,000), a persisted outcome, and a recovery path if the worker stops. The daemon invokes `elia auto` with unattended governance, but unattended does **not** mean unrestricted: read-only, reversible, and idempotent work may proceed; non-zero command results, missing browser transports, unmet postconditions, stale leases, exhausted action budgets, and ambiguous outcomes become retryable or human-review states. Concurrent daemons use a reclaimable store lock and skip already-claimed work instead of terminating. Sending messages, publishing, purchasing, deleting, changing account state, production mutations, authentication, CAPTCHA, and payment steps remain blocked or require exact user approval/takeover.

Tool actions now carry an internal contract containing an idempotency key, readiness preconditions, postconditions/evidence, bounded retry behavior, and an escalation disposition. The environment preflight reports `ready`, `missing-config`, or `unavailable` for model, browser, source-control, data-science, and deployment capabilities without returning secrets or claiming that a credential is authorized. A successful model response is never treated as proof that an external-world action succeeded.

This is **Gemini Spark-inspired**, not a claim that Elia is Gemini Spark. Google’s Spark product is a separate consumer agent with its own Google-hosted tasks, connected apps, schedules, and supervision model [gemini-spark]. Google’s support material also describes Spark as experimental and supervised [gemini-spark-support]. Elia’s `google` provider calls Gemini models through the documented OpenAI-compatible Gemini endpoint [gemini-api], while Elia’s scheduler and local browser/communication adapters provide its own control plane. The repository does not claim a direct Spark API or Spark account integration. A local daemon also cannot guarantee 24/7 operation in the ephemeral sandbox: for unattended execution across restarts, run it on an always-on user machine or a properly hosted worker with explicitly configured connectors, credentials, monitoring, and stop controls.

[gemini-spark]: https://gemini.google/overview/agent/spark/ "Gemini Spark overview"
[gemini-spark-support]: https://support.google.com/gemini/answer/17094507?hl=en&co=GENIE.Platform%3DAndroid "Gemini Spark availability and help"
[gemini-api]: https://ai.google.dev/gemini-api/docs "Gemini API documentation"
[gemini-interactions]: https://ai.google.dev/api/interactions-api "Gemini Interactions API reference"

The Gemini Spark discussion above is based on Google’s [Spark overview][gemini-spark], [support documentation][gemini-spark-support], [Gemini API documentation][gemini-api], and [Interactions API reference][gemini-interactions].
