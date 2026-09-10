# Elia autonomy, Grok-Build comparison, and native-language optimization plan

Branch: `opencode-optimization`. Evidence sources are Elia's own tree
(`src/autonomy/governor.ts`, `src/native/ffi.ts`, `native/elia-parse/src/validator.cpp`,
`crates/eliad/README.md`, `docs/agent-capability-audit.md`,
`docs/autonomy-roadmap.md`, `docs/production-readiness-audit.md`,
`lacking/gap.md`, `lacking/devlack.md`) plus xAI's public Grok Build material (2026).

## 1. How autonomous is Elia today?

**Supervised by default, opt-in unattended — governed at the tool boundary, not by prompt.**

- Deterministic per-tool governor (`src/autonomy/governor.ts`): every lead, worker,
  repair-pass, and variant tool call is classified `safe` / `review` / `critical` and
  resolved to `allow` / `approve` / `block` before execution. Repo policy
  (`.elia/policy.json`) can only tighten, never loosen.
- Finite budgets: governed-tool budgets per profile (fast 120 / balanced 300 /
  thorough 600, cap 10,000) plus wall-clock budget (`ELIA_MAX_RUN_MS` / `--max-run-ms`).
  Exhaustion records a blocked request and a `needs-attention` state — never silent retry.
- Durable execution: versioned goal graph, append-only journal, action ledger with
  idempotency keys, leases with heartbeat renewal, checkpoints, pause/stop/resume
  (`elia control`, `elia resume`), and a redacted run receipt. A model saying "done"
  is not proof; completion must be `verified` against the graph.
- Scheduling: local single-flight daemon, `.elia/schedules.json`, lease-claimed runs
  with bounded budgets and recovery paths.
- Standing refusals: send/publish/purchase/delete/production-mutation/auth/CAPTCHA stay
  blocked or exact-approval-gated even in `--unattended` / `--yolo` / `--autonomous`.

**Honest ceiling:** local-only daemon (no 24/7 hosting), application-level governance
(no kernel sandbox, managed network policy, or OS-keyring secrets), and no proof of
external-world outcomes. That matches the repo's own audits and must stay in every
delivery claim.

## 2. Grok Build (xAI, 2026) — what we are up against

From xAI's public pages and the open-source harness (`xai-org/grok-build`):

- Model built for long agents: Grok 4.6 targets multi-step coding/knowledge work and
  claims frontier agentic-coding scores; `/goal` mode plans, checklists, executes to
  verified completion with `status` / `pause` / `resume` / `clear`.
- Harness is **Rust** (TUI + agent runtime + tools + workspace crates), with plan mode
  (approve/comment/rewrite, clean diffs), parallel subagents with own context windows
  and worktree support, auto-invoked skills + `/skillify`, skill/marketplace sharing,
  MCP servers, hooks, Q&A disambiguation, headless `-p` mode, ACP support, and
  sandboxed execution.
- Distribution moat: ships to SuperGrok / X Premium Plus subscribers, Cursor, API,
  OpenRouter/Vercel/Cloudflare.

## 3. Can we beat them?

Not head-on in foundation-model strength or subscriber distribution — claiming that
without a frozen eval protocol and independent baselines would repeat exactly the
hype the capability audit warns against. The winnable fight is **accountable,
local-first autonomy**, where Elia already has rare assets Grok Build does not centre:

1. Deterministic action governor + redacted ledger + run receipt (authorization evidence
   per action, not just a transcript).
2. Durable goal graph with leases, idempotent retries, rewind/fork, truthful
   pause/resume — restart-safe autonomy.
3. Benchmark-gated self-evolution (`elia evolve`) and repeated-routine skill synthesis.
4. Multi-provider routing with fallback (incl. cheap Groq/NVIDIA/Mercury paths) instead
   of single-vendor lock-in.
5. Specialist depth with output contracts (Battmann evidence/forecast store, cyber
   engagement with evidence-backed findings, finance/data deterministic tools).

Strategy: out-govern, out-last, out-prove — longest safe unattended runs, cheapest
verified completions, strongest receipts — not out-model.

## 4. Features to optimize (performance first)

Ordered by leverage. Note the dominant cost is model round-trip latency, so native
work should kill round trips and cold starts, not rewrite orchestration.

1. **Resident warm state (Rust `eliad`):** shell pool exists; still missing are the
   warm provider-connection pool, MCP client supervisor, and workspace index named in
   `crates/eliad/README.md`. Each cold spawn/handshake/list round-trip removed is a
   first-turn latency win on every invocation.
2. **In-process FFI fast path adoption:** `elia-native` cdylib via `bun:ffi` makes the
   C++ structural check sub-millisecond with no daemon hop (`src/native/ffi.ts`).
   Ensure every `edit_file`/`write_file` actually hits it; treat ABI mismatch as a
   metric, not silent fallback.
3. **Context economics:** compaction, recall ranking (BM25), read-ahead/prefetch
   (`src/compaction.ts`, `src/recall.ts`, `src/bm25.ts`, `src/autonomy/readAhead.ts`,
   `src/speculation/`) — fewer tokens per verified task is the cheapest speedup available.
4. **Verification-loop cost:** two-tier model cascade discipline (fast vs deep),
   one-fleet-per-lead limits, reviewer read-only context — measure repair-loop count,
   cost per verified completion, prompts per task; promote only what moves those.
5. **Provider health:** request-local health today (see production-readiness audit) —
   add bounded health state, cooldowns, route telemetry without changing model semantics.
6. **Bounded everything:** bridge/CDP/provider deadlines, process-group kill on shell
   timeout, output caps, per-run wall-clock/child/output/spend budgets — hangs are the
   worst "performance" bug in an agent.
7. **Receipt/event correlation:** one stable run/event schema across terminal, JSONL,
   receipt, and dashboard so incidents stop needing manual correlation.

## 5. Features we are lacking (from the repo's own gap analyses)

- Hosted 24/7 execution that survives restarts/sleep; external event ingress
  (webhooks, GitHub events) beyond the local poll daemon.
- OS/kernel sandboxing, managed network policy, secure OS-keyring credentials
  (today: `.env`/user config files with filesystem permissions only).
- Native first-party integrations (Gmail/Calendar/Slack/SMS/payments); today everything
  external needs a user-configured bridge/MCP plus exact approval.
- Unattended real-world completion: critical external effects always approval-gated —
  correct for safety, but it caps "fully autonomous errands" vs. the marketed competition.
- Advanced domain playbooks: 3-statement/LBO finance, causal inference/experiment
  design/leakage detection, source-registry + citation contracts for research,
  defensive-cyber evidence normalization, reusable comms/automation schemas.
- Verified external outcomes: deployment/production health proof, delivery confirmation
  adapters, enterprise compliance telemetry and audit export.
- Provenance-aware memory (source/timestamp/confidence/TTL/conflict handling) and
  cross-session learning beyond `.elia/` files.

## 6. C++ / Go / Rust verdict

**Current reality:** TypeScript is the conductor; Rust owns the resident daemon
(`eliad`), the `elia-native` cdylib, and the `elia-parse` bindings; C++ owns one tiny
hot kernel — the linear-scan structural validator (`validator.cpp`, ~386 lines,
bracket/quote/comment balance for Generic/JsTs/Python/Rust/Go lexers); there is
**zero Go code** in the repo and no Go toolchain wiring.

**Recommendation:**

- **Rust — expand (resident + hot paths).** It already pays rent: shell pool, JSON-line
  protocol, FFI cdylib, daemon lifecycle with soft fallback. Next: provider-connection
  pool, MCP supervisor, file watcher/indexer, lease/receipt store helpers. Keep the
  TS-fallback contract — a missing/stale binary must never be fatal.
- **C++ — keep narrow (scan kernel only), but invest heavily inside it.**
  `validator.cpp` is exactly the right shape: dependency-free, linear,
  sub-millisecond, FFI-callable. "Heavy C++ use" should mean depth in this
  kernel, not breadth into services (services belong in Rust where Cargo manages
  the build). Approved growth areas: more lexers, optional SIMD row-scan, a fuzz
  corpus, and at most one additional kernel of the same shape (e.g. fast
  diff/matcher) — each callable through the existing `elia-native` cdylib and
  covered by `src/native/ffi.test.ts`.
- **Go — additive pilot, no rewrite, gated on metrics.** Reconsidered: Go earns a
  place for sidecar services, not hot paths (the sub-millisecond in-process check
  stays Rust via `bun:ffi` — Go's cgo shared-library story is strictly worse there —
  and replacing `eliad` would be the rewrite we ruled out). Where Go genuinely wins:
  filesystem-heavy services (workspace index/search, file watcher), concurrent
  fan-out helpers, HTTP/proxy utilities, and command-style stdio MCP servers, which
  `src/mcp/registry.ts` + `daemonBridge.ts` already support with zero harness changes.
  Bonus: Go's Windows toolchain is trivial — no LLVM-MinGW dance like
  `.cargo/config.toml` demands. The seam already exists: copy the
  `src/daemon/types.ts` ↔ `crates/eliad/src/protocol.rs` contract (NDJSON-RPC, mirrored
  types, protocol-version check, soft fallback to the pure-TS path), add one
  `ELIA_GO_*` env gate defaulting to off, and a `build-go` recipe in the `justfile`.
  Cost is real — a fifth toolchain (Bun + Cargo + C++ + javac + Go), more CI minutes,
  per-platform binaries, another wire protocol to version — so the pilot is one
  service (`index.query` sidecar), and it expands only if it moves numbers (p50/p95
  search latency, cold-start ms, binary MB, CI minutes) without regressing
  tokens-per-verified-task or repair-loop count.
- **Performance honesty:** agent wall-clock is dominated by model RTT and verification
  loops, not local compute. Native code wins by avoiding round trips (FFI vs daemon hop,
  warm pools vs cold handshakes) and by shrinking token spend (index/prefetch/compaction).
  Instrument first: cold-start ms, FFI hit rate, tokens/verified-task, repair loops,
  $/verified-task — then let `elia evolve` promote only measured wins.
- **Language assignment (final):** TypeScript stays the conductor; Rust owns resident
  services and in-process hot paths; C++ owns scan kernels with heavy investment
  inside that boundary; Go owns opt-in sidecar services behind env gates and TS
  fallbacks. No language replaces another — each new binary must justify itself with
  metrics or stay local-build only.

## 7. Proposed next actions

1. Implement `eliad` provider-connection pool + MCP supervisor; metric: p50 first-token
   latency on repeat invocations.
2. Audit FFI hit rate across edits; fix stale-ABI fallbacks; metric: % edits checked
   in-process.
3. Add provider health/cooldown telemetry; metric: degraded-provider wasted latency.
4. Run the Go pilot: scaffold `go/` with the single `index.query` sidecar service,
   `ELIA_GO_INDEX` gate defaulting to off, TS client with fallback, `build-go` recipe,
   dedicated CI lane (ubuntu + windows); metric: p95 search latency vs ripgrep and
   pure-TS baselines on a large-repo fixture. Expand only on a ≥2× win with no
   token-cost or suite regressions.
5. Deepen the C++ kernel: more lexers, SIMD row-scan prototype, fuzz corpus, plus at
   most one additional same-shape kernel (fast diff/matcher) through `elia-native`;
   no C++ services.
6. Document the toolchain decision (five toolchains, promotion gate) in the toolchain ADR
   so "add a language" stays a measured proposal, not precedent for sprawl.

## 8. Go pilot result (2026-09-10, branch `opencode-optimization`)

Built as specified: `go/elia-index` (stdlib-only, parallel worker pool with
deterministic walk-order merge), `src/goindex/` TS client
(`ELIA_GO_INDEX=off/auto/require`, soft fallback), `grep`-tool preferred tier,
`just build-go`/`test-go`, dedicated CI lane (ubuntu + windows), and
`scripts/bench-go-index.ts`. Parity with the pure-JS backend is proven by
`src/goindex/client.test.ts` (same matches/lines/grouping; known separator and
RE2-grammar divergences documented in `go/README.md`).

**Gate outcome: NOT MET on latency — pilot stays local-build, no promotion.**

- `src/` tree, pattern `function`: JS 11.7 ms, ripgrep 24.3 ms, go-index 23.7 ms.
- Synthetic 3,000 files × 200 lines, early-cap pattern: JS ~6 ms, ripgrep
  ~53–80 ms, go-index ~16–32 ms (parallel pool; race-clean).
- Cause: per-call spawn cost (~tens of ms on this box) floors every
  out-of-process backend above in-process JS on early-cap workloads. The
  sidecar matches ripgrep but cannot beat JS by the required ≥2×.

**Recommended follow-up, not this pilot:** resident mode — spawn once, amortize
startup, keep a warm file index — which attacks the actual dominant cost. That
is a separate gated proposal; until then, no second Go service and no npm
packaging of the binary.
