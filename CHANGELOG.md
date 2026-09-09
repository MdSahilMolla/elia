# Changelog

All notable changes to `elia-ai` are recorded here. Dates are release dates.

## 0.1.7 — unreleased

68 commits since 0.1.6. Two new subsystems (native stack, collaborative
workspace), a REPL redesign, and a broad reliability/perf pass.

### Added

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
- **Battmann mode** — four-pillar build-out with finance/defense primitives and
  a dashboard; every turn anchored to the wall-clock date.
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
