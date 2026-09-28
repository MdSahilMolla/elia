# Changelog

All notable changes to `elia-ai` are recorded here. Dates are release dates.

## 0.1.7 — unreleased

68 commits since 0.1.6. Two new subsystems (native stack, collaborative
workspace), a REPL redesign, and a broad reliability/perf pass.

### Added

- **`elia autopilot`: goal-free, unsupervised development.** No task given: it
  surveys the repository, measures its own checks, forms an evidence-cited
  understanding (purpose, current state, direction; ungrounded claims are
  dropped), builds a backlog ranked in code (failing checks first), and works
  it with governed unattended `auto` runs on an `elia/autopilot-*` branch. A
  health ratchet rolls back any goal that turns a passing check red and keeps
  the attempt at `refs/elia/autopilot/…`. Durable and resumable
  (`.elia/autopilot/`), with `--plan-only`, `--resume`, `status`, `report`, and
  `/autopilot` inside a session.
- **Working is the default.** A bare `elia` in a clean git repository starts
  the autopilot as the session's first turn (or resumes it, when you are still
  on its branch with goals queued); it waits for you instead outside a repo,
  with uncommitted changes, in elia's own checkout, with a prompt or
  `--continue`/`--resume`, or with `--chat` / `ELIA_AUTOPILOT=off`. `elia auto`
  runs unattended by default; `--supervised` restores the plan approval.
- **One way of working: autonomous.** There is no approval mode to pick any
  more. Removed: the "Risk checks (auto/manual)" / "Approvals" setting and its
  shift+tab posture cycle (shift+tab now only toggles plan mode), the
  per-request risk pre-check (in sessions and in `elia "<task>"`), `/auto on|off`
  and `--no-escalate` (big builds always take the full pipeline), and
  `elia auto --supervised` / `ELIA_SUPERVISION` (accepted, ignored, and said
  so). Local reversible work — edits, commits, staging, setup — runs without
  asking everywhere; the one gate left is for irreversible or outside-world
  actions, asked once in a session (with "always allow") and skipped-and-listed
  in unattended runs. The status row's "auto · model" (model fallback) now
  reads "model + fallback", so no on-screen "auto" means anything but elia.
- **Live replies.** A message sent while elia works is answered at once by a
  read-only lane that sees the conversation, plan, running tools, progress and
  the autopilot's state, and can open files. A direction comes back with a
  `STEER:` line that reaches the running work. `/quickchat` and its overlay are
  retired; this is the default behaviour.
- **`database` tool** for development: detect the project's database setup,
  start/stop a project-local PostgreSQL (`.elia/devdb/`, loopback only, no
  Docker), query, schema, and apply/create migrations. Governed by locality:
  local work runs unattended (destructive SQL is `pg_dump`ed first); any
  remote database is `critical` and never auto-approved.
- **Native stack.** `eliad` daemon with a per-directory persistent shell pool
  and a resident MCP supervisor (behind `ELIA_DAEMON`); `elia-parse` C++
  structural edit-check and `elia-jvm-bridge` Java type-check services routed
  through the daemon. The structural pre-flight also runs in-process for every
  `edit_file` / `write_file` via `bun:ffi` against the `elia-native` cdylib, so
  it applies even with `ELIA_DAEMON=off`. `.java` edits are pre-flighted through
  the JDK compiler.
- **Collaborative workspace** (`src/workspace/`, M1–M6): event-sourced domain
  store with identity and admin, coordination server with RPC client/CLI and a
  live feed, objective decomposition into a task graph behind an approval gate,
  reservation ledger + orchestrator reactor + agent runtimes, and a review /
  recovery / watch loop. `/eliaspace` gives read-only workspace access from the
  REPL. Composite indexes on the message/task hot paths.
- **Image input in the terminal** — paste or drag a path, or `/attach`.
- **Mercury 2.5** provider; it is the new `mercury` default.
- **`/eliabook`** — save, browse, and replay verified session playbooks.
- **`/betamode`** and `--beta <mode>` split experimental modes out from the
  default surface.
- **`provision_environment`** tool; orient now assesses declared vs. available
  environment and past runs' honesty feeds the next run's orient.
- **Battmann mode** — every turn anchored to the wall-clock date, with a
  dashboard. **Real data feeds** (ECB rates, World Bank, IMF WEO, UN Comtrade,
  GDELT) are fetched by code with the raw response hashed, recorded
  append-only, and refreshed by `elia battmann refresh`. The **certified track
  record** covers questions with a `resolutionRule`: they are resolved by code
  from a feed, timestamped by the clock, and scored against an automatic
  statistical baseline. The **classification boundary** is now enforced in
  code: while any model route is a cloud model, the tool withholds records
  above the cloud ceiling and refuses to write them, and the store file is a
  protected path. `elia battmann seed|brief india-semiconductors` is the first
  playbook. Commodity prices (IMF PCPS) and applied tariffs (WITS) followed,
  along with `supplier_concentration`. A live agent run showed the tool had
  to be easier for models to use, so `feed_query` now returns a citable
  evidence id, nested fields are lifted, a failed call returns the fields
  that action takes, and certified forecasts are stamped by the clock with
  their feed evidence attached. Every figure in a claim is now checked against the
  stored text of the evidence it cites, at write time and in the report, after
  a live brief cited HS 8541 shares against the HS 8542 record. Evidence is
  graded feed, fetched (checked against the page web_fetch retrieved) or
  unverified, and an observed fact whose figures are not in its evidence is
  refused. `elia battmann cycle` and `autorun` keep the forecasting loop running
  daily on macOS (launchd), Linux (crontab) and Windows (Task Scheduler). The defence primitives (`posture_assessment`, `effector_pairing`)
  and the Palantir-pillar naming were removed.
- **cyber mode** — evidence-gated findings, scoped `http_probe`, and a
  `.elia/policy.json` governor policy.
- A repo-history benchmark that can actually be failed, plus a latency benchmark.

### Changed

- **REPL redesign** — minimal monochrome Devin-style banner, input rules, and
  status bar. Input caret is drawn at the cursor position instead of pinned to
  the end (#11).
- **Latency** — non-blocking startup, mid-stream tool dispatch, tighter
  round-trip discipline. Context budget is sized to the model so the review gate
  no longer goes blind.
- **Autonomy** — no-progress circuit breaker in the agent loop; large build
  requests auto-escalate into the pipeline; default loop hardened against
  scroll / tool-hallucination / workspace-isolation failures; worker prose
  reports are no longer misclassified as fatal gates.
- **improverepo v3** (all 8 items shipped): bounded cache registry, cross-turn
  memoization of deterministic reads, CPU-derived default tool concurrency,
  windowed reads for over-limit files, wider prefetch heuristics, per-tool
  timing in the profiler, and auto-captured lessons on repeated repair failure.
- Planner gets the speculative cache + heuristic prefetch and deterministically
  finishes reading a just-searched worklist.
- **Compounding is faster.** The evolve promotion path runs its independent
  phases concurrently — the two-tree verifier-gap and value-probe checks, and
  the sandbox typecheck/tests. Same verdicts, less wall clock. Benchmark sweeps
  still keep to `ELIA_BENCH_CONCURRENCY` (default 2).
  `ELIA_HARVEST_SCAN`/`ELIA_HARVEST_LIMIT` now bound a harvest round.
- `evolve` scores candidates on the long-horizon hard suite too.
- `edit_file` / `write_file` diffs render inline with workspace-relative paths.
- ChatGPT/Codex-subscription path: lower latency, compact terminal
  representation, once-per-session approval, steering to subagents, auto-preview,
  `/usage`, and an approval menu.
- OpenAI-compatible responses are capped at `max_tokens`.
- Integration branch renamed `manus` → `production`.

### Fixed

- Agent was un-interruptible on Windows; assorted shell-friction fixes.
- `run_command` rejects `cmd.exe`-hostile one-liners before spawning.
- Cross-process locking, provider config, workspace fan-out, and Windows shell
  handling (#26, closing #12–#25).
- LSP: async stdin flush rejection on a dead pipe is swallowed (#27).
- Preview resolves symlinks before serving; `editMatch` scores only full
  windows.
- CI: daemon dial crash on Linux, secret-scan false positives (#10), flaky
  timing tests retried, Ink render tests wait on frame content, TypeScript suite
  now runs on Windows too.

## 0.1.6 — 2026-09-02

Baseline for this changelog. See the git history before `v0.1.6` for earlier
releases.
