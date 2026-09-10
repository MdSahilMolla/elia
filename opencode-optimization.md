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
- **C++ — keep narrow (scan kernel only).** `validator.cpp` is exactly the right shape:
  dependency-free, linear, sub-millisecond, FFI-callable. Future C++ work should stay
  inside that kernel (more lexers, optional SIMD row-scan, fuzz tests) — not grow into
  services, which belong in Rust where Cargo manages the build.
- **Go — do not add.** A fourth toolchain (Bun + Cargo + C++ + Go, plus JVM bridge)
  buys build matrix pain, installer weight, and ABI surface for no identified hot path.
  The governor already allowlists `go build/test/vet` for *target* projects — that is
  toolchain *support*, not a reason to write Elia itself in Go. Revisit only if a
  must-have dependency exists solely in Go.
- **Performance honesty:** agent wall-clock is dominated by model RTT and verification
  loops, not local compute. Native code wins by avoiding round trips (FFI vs daemon hop,
  warm pools vs cold handshakes) and by shrinking token spend (index/prefetch/compaction).
  Instrument first: cold-start ms, FFI hit rate, tokens/verified-task, repair loops,
  $/verified-task — then let `elia evolve` promote only measured wins.

## 7. Proposed next actions

1. Implement `eliad` provider-connection pool + MCP supervisor; metric: p50 first-token
   latency on repeat invocations.
2. Audit FFI hit rate across edits; fix stale-ABI fallbacks; metric: % edits checked
   in-process.
3. Add provider health/cooldown telemetry; metric: degraded-provider wasted latency.
4. Prototype workspace index (Rust, daemon-resident) behind the TS fallback; metric:
   grep/glob latency on large repos.
5. Keep C++ to the validator kernel + fuzz corpus; no new C++ services.
6. No Go introduction; document the decision in the toolchain ADR.
