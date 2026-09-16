# Speed

[← Back to the README](../../README.md)

## On speed

Roughly in order of impact:

1. **Prompt caching** (Anthropic): the system prompt, tool definitions, and the tail of history are cache breakpoints, so the unchanged prefix of a growing tool-calling loop is reused rather than reprocessed. Two refinements keep the cache actually holding: the stable prefix (system prompt + tools, fixed for the whole session) is pinned to the **1-hour** cache TTL so a slow `bun test` or a long pause between messages can't evict it, and the per-turn query-ranked project memory is sent as a **separate system block** so it never invalidates that stable prefix when it changes from one user message to the next. Run with `--profile-turns` (or `ELIA_PROFILE=1`) to print a per-call table of the cache-read/write split and time-to-first-token and see how well the cache is holding.
2. **Parallel sub-agents in dependency waves** — the widest safe wave at each point, rather than everything at once (which corrupts files two workers both edit) or everything in order (which wastes the fleet).
3. **The fast tier** — recon and summarising go to a cheap quick model; only decisions pay for the strong one.
4. **Parallel tool execution** — up to 8 read-only tool calls in flight per turn, 4 when any of them mutates.
5. **Predictive prefetch and mid-stream dispatch** — a read-only tool call is run *while the model is still generating*: predicted reads the moment a grep or import points at them, and any read-only `tool_use` block the instant it finishes streaming. The tool phase often costs ~0ms instead of a disk round-trip per file.
6. **Connection prewarm** — every configured model host gets a pooled connection opened at startup, so the first request skips DNS + TLS + HTTP/2 setup.
7. **Non-blocking startup and compaction** — MCP servers connect in the background instead of gating the prompt; a slow one (a cold `npx` server) is left connecting past a ~2.5s soft deadline (`ELIA_MCP_CONNECT_DEADLINE_MS`) rather than blocking a one-shot run for its full connect timeout; the history-shrinking archive (itself a model call) overlaps the turn that triggers it instead of stalling that turn's first token.
8. **Round-trip discipline** — `parallel_tool_calls` is requested explicitly, and the loop watches for a model reading files one per turn (or re-reading a file it already has) and injects one plain reminder to batch. Fewer model round-trips is the single biggest lever on wall-clock, especially with a fast-token / weaker-agent model.

`elia bench-latency` measures items 4–7 directly, with a scripted model so the numbers are all elia, and gates CI on the ones that are deterministic.

`max_tokens` for Anthropic is 32,000 (Sonnet 5 supports up to 128k). Billing is by tokens actually generated, not the ceiling, so this only removes the risk of truncated output on large refactors, with no cost downside.

## Coding speed, accuracy, and benchmark discipline

Elia keeps speed and correctness separate. Read-only file, data, and web observations can run in a bounded higher-concurrency pool; mutating tools, shared browser navigation, and external side effects remain conservative. The optional fast model tier is used for scouts and low-risk summaries, while builders, testers, critics, security reviewers, and final verification retain the deep tier. `ELIA_TOOL_CONCURRENCY` is capped at 8 for read-only batches and at 4 for batches that include mutations.

The coding benchmark records per-task steps, elapsed time, stop reason, token usage, cache hits/misses, total agent time, and suite wall-clock time. Promotion is correctness-first: a candidate that regresses any previously passing task is rejected, and a tied-correctness candidate must show a material token or wall-clock improvement. This prevents Elia from becoming “faster” by skipping verification or silently lowering task quality.
